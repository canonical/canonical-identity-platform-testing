#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Model journal for the juju matrix lane. OBSERVES AND JOURNALS; NEVER MUTATES.
// Records every workload-status change plus a periodic line while any unit
// sits in error or waiting-not-connected, across the phases the settle loops
// don't watch (seed/test). Those lines are the evidence for the filed
// kratos-operator wedge (config-model.mjs upstreamFindings) — never silence
// them. No remediation (no `juju resolved`, no config kick): a deployment-layer
// retry would launder a novel charm bug into a green row. Manual recovery:
// docs/juju-lane-runbook.md.
//
// Usage: JUJU_CONTROLLER=<ctl> node matrix/watchdog.mjs (auto-spawned by run-row.mjs)

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { assertController } from "./controller-guard.mjs";

const MODEL = process.env.MATRIX_JUJU_MODEL ?? "iam-matrix";
const POLL_MS = 20_000;
// While a unit is stuck, re-journal at most this often.
const STUCK_REPORT_MS = 5 * 60_000;

const sh = (args) => spawnSync("juju", args, { encoding: "utf8" });
const ts = () => new Date().toISOString().slice(11, 19);

/** Flatten a `juju status --format json` document to unit -> {app, current, message}. */
export function unitStates(statusJson) {
  const states = new Map();
  for (const [app, a] of Object.entries(statusJson?.applications ?? {})) {
    for (const [unit, u] of Object.entries(a.units ?? {})) {
      const wl = u["workload-status"] ?? {};
      states.set(unit, { app, current: wl.current ?? "unknown", message: wl.message ?? "" });
    }
  }
  return states;
}

/** Is this unit in one of the states the upstream wedge presents as? */
export function isStuck({ current, message }) {
  return current === "error" || (current === "waiting" && /not connected/i.test(message));
}

// ── Entry (main-guarded so matrix/tests/ can import the pure functions) ─────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {

assertController();

const previous = new Map();
const stuckSince = new Map();
let lastStuckReport = 0;

console.log(`[watchdog] journaling model ${MODEL} every ${POLL_MS / 1000}s — OBSERVER ONLY, never mutates (upstream kratos-operator fragility: see config-model.mjs upstreamFindings)`);

for (;;) {
  const st = sh(["status", "-m", MODEL, "--format", "json"]);
  if (st.status === 0) {
    let status = null;
    try {
      status = JSON.parse(st.stdout);
    } catch {
      status = null;
    }
    const states = unitStates(status);

    for (const [unit, s] of states) {
      const prev = previous.get(unit);
      if (!prev || prev.current !== s.current || prev.message !== s.message) {
        console.log(`[watchdog ${ts()}] ${unit} ${prev ? `${prev.current} -> ` : ""}${s.current}${s.message ? ` (${s.message})` : ""}`);
      }
      previous.set(unit, s);
      if (isStuck(s)) {
        if (!stuckSince.has(unit)) stuckSince.set(unit, Date.now());
      } else {
        stuckSince.delete(unit);
      }
    }
    for (const unit of [...previous.keys()]) {
      if (!states.has(unit)) {
        console.log(`[watchdog ${ts()}] ${unit} gone from status`);
        previous.delete(unit);
        stuckSince.delete(unit);
      }
    }

    const now = Date.now();
    if (stuckSince.size > 0 && now - lastStuckReport >= STUCK_REPORT_MS) {
      lastStuckReport = now;
      for (const [unit, since] of stuckSince) {
        const s = states.get(unit);
        console.log(`[watchdog ${ts()}] STUCK ${Math.round((now - since) / 60_000)} min: ${unit} ${s.current} (${s.message}) — no remediation by design (D-3); the row's settle budget decides`);
      }
    }
  } else {
    console.log(`[watchdog ${ts()}] juju status failed: ${(st.stderr ?? "").trim().split("\n")[0]}`);
  }
  spawnSync("sleep", [String(POLL_MS / 1000)]);
}

}
