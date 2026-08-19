// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Settle/journal pure logic. Both modules are observer-only after decision
// D-3, so these tests pin the DIAGNOSTIC surface that replaced the removed
// remediation: which status lines a settle timeout reports, and which unit
// states the journal calls stuck. No process is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";

import { nonCleanLines } from "../run-row.mjs";
import { unitStates, isStuck } from "../watchdog.mjs";

const STATUS_SHORT = [
  "- hydra/0: 10.1.0.5 (agent:idle, workload:active)",
  "- kratos/0: 10.1.0.6 (agent:idle, workload:error) hook failed: kratos-pebble-check-failed",
  "- login-ui/0: 10.1.0.7 (agent:idle, workload:waiting) Container is not connected yet",
  "",
].join("\n");

test("nonCleanLines keeps exactly the lines that blocked settling", () => {
  assert.deepEqual(nonCleanLines(STATUS_SHORT), [
    "- kratos/0: 10.1.0.6 (agent:idle, workload:error) hook failed: kratos-pebble-check-failed",
    "- login-ui/0: 10.1.0.7 (agent:idle, workload:waiting) Container is not connected yet",
  ]);
});

test("nonCleanLines is empty for a settled model and tolerates no output", () => {
  assert.deepEqual(nonCleanLines("- hydra/0: 10.1.0.5 (agent:idle, workload:active)\n"), []);
  assert.deepEqual(nonCleanLines(""), []);
  assert.deepEqual(nonCleanLines(undefined), []);
});

test("unitStates flattens a juju status document to unit -> workload state", () => {
  const states = unitStates({
    applications: {
      kratos: { units: { "kratos/0": { "workload-status": { current: "error", message: "hook failed" } } } },
      hydra: { units: { "hydra/0": { "workload-status": { current: "active", message: "" } } } },
      "idp-dex": {},
    },
  });
  assert.equal(states.size, 2);
  assert.deepEqual(states.get("kratos/0"), { app: "kratos", current: "error", message: "hook failed" });
  assert.deepEqual(states.get("hydra/0"), { app: "hydra", current: "active", message: "" });
});

test("unitStates tolerates a malformed/empty document", () => {
  assert.equal(unitStates(null).size, 0);
  assert.equal(unitStates({}).size, 0);
});

test("isStuck covers both shapes of the filed kratos-operator wedge only", () => {
  assert.equal(isStuck({ current: "error", message: "hook failed" }), true);
  assert.equal(isStuck({ current: "waiting", message: "Container is not connected yet" }), true);
  assert.equal(isStuck({ current: "waiting", message: "Waiting for database migration" }), false);
  assert.equal(isStuck({ current: "active", message: "" }), false);
  assert.equal(isStuck({ current: "maintenance", message: "installing" }), false);
});
