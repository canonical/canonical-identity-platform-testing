#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Controller guard for the juju matrix lane.
//
// This workstation has a PRODUCTION JIMM controller registered alongside the
// local microk8s one. A presence-only `JUJU_CONTROLLER` check is not enough:
//
//   1. terraform-provider-juju never reads JUJU_CONTROLLER. With none of
//      JUJU_CONTROLLER_ADDRESSES/JUJU_USERNAME/JUJU_PASSWORD/JUJU_CA_CERT/
//      JUJU_CLIENT_ID/JUJU_CLIENT_SECRET set it shells out to
//      `juju show-controller`, so the controller is bound TRANSITIVELY
//      through the CLI's own resolution order.
//   2. That order is JUJU_MODEL > JUJU_CONTROLLER > `juju switch` state, so a
//      stray JUJU_MODEL silently outranks a correctly exported
//      JUJU_CONTROLLER.
//   3. JUJU_CONTROLLER_ADDRESSES bypasses the CLI fallback entirely — the
//      provider then talks to whatever that env names, and no CLI-visible
//      state reflects it.
//
// So the guard checks the RESOLVED name (from `juju show-controller`) against
// an allowlist of one (MATRIX_ALLOWED_CONTROLLER, default microk8s-localhost)
// and refuses the two envs that can route around the check.
//
// Everything except the single spawnSync below is pure and unit-tested
// (matrix/tests/controller-guard.test.mjs) — reject-paths are NEVER proven by
// running a real entrypoint against a disallowed controller.
//
// Read-only self-test:  JUJU_CONTROLLER=<ctl> node matrix/controller-guard.mjs --check

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_ALLOWED_CONTROLLER = "microk8s-localhost";

/** Pure: env preconditions, checked BEFORE any process is spawned.
 *  Returns {ok, reason}. */
export function validateControllerEnv(env) {
  if (!env.JUJU_CONTROLLER) {
    return {
      ok: false,
      reason:
        "JUJU_CONTROLLER is unset — set it explicitly (never rely on the ambient `juju switch` state; " +
        "this workstation also has a production JIMM controller registered)",
    };
  }
  if (env.JUJU_MODEL) {
    return {
      ok: false,
      reason:
        `JUJU_MODEL is set (${env.JUJU_MODEL}) — it outranks JUJU_CONTROLLER in juju's resolution order ` +
        "(JUJU_MODEL > JUJU_CONTROLLER > switch state), so the controller you exported may not be the one used. Unset it.",
    };
  }
  if (env.JUJU_CONTROLLER_ADDRESSES) {
    return {
      ok: false,
      reason:
        "JUJU_CONTROLLER_ADDRESSES is set — terraform-provider-juju uses it directly and never falls back to " +
        "the juju CLI, so this guard cannot observe the controller it would reach. Unset it.",
    };
  }
  return { ok: true, reason: "" };
}

/** Pure: check the resolved controller name against the allowlist of one.
 *  `showControllerJson` is the parsed `juju show-controller --format=json`
 *  document; its single top-level key IS the resolved controller name.
 *  Malformed or empty documents fail closed. */
export function assertControllerPure(showControllerJson, allowed) {
  if (showControllerJson === null || typeof showControllerJson !== "object" || Array.isArray(showControllerJson)) {
    return { ok: false, resolved: null, reason: "could not parse `juju show-controller --format=json` output — failing closed" };
  }
  const names = Object.keys(showControllerJson);
  if (names.length !== 1) {
    return {
      ok: false,
      resolved: null,
      reason: `\`juju show-controller\` named ${names.length} controllers (${names.join(", ") || "none"}); expected exactly one — failing closed`,
    };
  }
  const resolved = names[0];
  if (resolved !== allowed) {
    return {
      ok: false,
      resolved,
      reason: `resolved controller '${resolved}', allowed '${allowed}' (set MATRIX_ALLOWED_CONTROLLER to widen deliberately)`,
    };
  }
  return { ok: true, resolved, reason: "" };
}

/** Impure wrapper: env preconditions first (no process spawned on failure),
 *  then one read-only `juju show-controller`. Exits 2 on any failure.
 *  Returns the resolved controller name. */
export function assertController() {
  const envCheck = validateControllerEnv(process.env);
  if (!envCheck.ok) {
    console.error(`✗ juju controller guard: ${envCheck.reason}`);
    process.exit(2);
  }
  const allowed = process.env.MATRIX_ALLOWED_CONTROLLER ?? DEFAULT_ALLOWED_CONTROLLER;
  const show = spawnSync("juju", ["show-controller", "--format=json"], { encoding: "utf8" });
  let parsed = null;
  if (show.status === 0) {
    try {
      parsed = JSON.parse(show.stdout ?? "");
    } catch {
      parsed = null;
    }
  }
  const verdict = assertControllerPure(parsed, allowed);
  if (!verdict.ok) {
    console.error(`✗ juju controller guard: ${verdict.reason}`);
    if (show.status !== 0) process.stderr.write((show.stderr ?? "").trim() + "\n");
    process.exit(2);
  }
  return verdict.resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) {
    console.log(assertController());
  } else {
    console.error(`usage: node ${path.basename(fileURLToPath(import.meta.url))} --check`);
    process.exit(2);
  }
}
