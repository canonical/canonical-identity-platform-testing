// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Controller-guard reject paths. These tests are the ONLY proof of every
// reject path: a guard whose negative path is demonstrated by running the real
// entrypoint against a disallowed controller would make the demonstration
// itself the hazard. Nothing here spawns juju — both functions under test are
// pure, and `assertController()`'s only untested line is its spawnSync.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateControllerEnv, assertControllerPure, DEFAULT_ALLOWED_CONTROLLER } from "../controller-guard.mjs";

test("validateControllerEnv: unset JUJU_CONTROLLER fails, telling the operator to set it", () => {
  const res = validateControllerEnv({});
  assert.equal(res.ok, false);
  assert.match(res.reason, /JUJU_CONTROLLER is unset/);
  assert.match(res.reason, /set it explicitly/);
});

test("validateControllerEnv: JUJU_MODEL outranks JUJU_CONTROLLER, so it is refused by name", () => {
  const res = validateControllerEnv({ JUJU_CONTROLLER: "microk8s-localhost", JUJU_MODEL: "admin/prod" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /JUJU_MODEL/);
  assert.match(res.reason, /admin\/prod/);
});

test("validateControllerEnv: JUJU_CONTROLLER_ADDRESSES bypasses the CLI fallback, so it is refused by name", () => {
  const res = validateControllerEnv({ JUJU_CONTROLLER: "microk8s-localhost", JUJU_CONTROLLER_ADDRESSES: "10.0.0.1:17070" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /JUJU_CONTROLLER_ADDRESSES/);
});

test("validateControllerEnv: a clean env passes", () => {
  const res = validateControllerEnv({ JUJU_CONTROLLER: "microk8s-localhost" });
  assert.deepEqual(res, { ok: true, reason: "" });
});

test("assertControllerPure: the allowed controller passes and is reported as resolved", () => {
  const res = assertControllerPure({ [DEFAULT_ALLOWED_CONTROLLER]: { details: {} } }, DEFAULT_ALLOWED_CONTROLLER);
  assert.equal(res.ok, true);
  assert.equal(res.resolved, DEFAULT_ALLOWED_CONTROLLER);
});

test("assertControllerPure: a wrong controller fails naming resolved AND allowed", () => {
  const res = assertControllerPure({ "production-jimm": { details: {} } }, DEFAULT_ALLOWED_CONTROLLER);
  assert.equal(res.ok, false);
  assert.equal(res.resolved, "production-jimm");
  assert.match(res.reason, /production-jimm/);
  assert.match(res.reason, new RegExp(DEFAULT_ALLOWED_CONTROLLER));
});

test("assertControllerPure: MATRIX_ALLOWED_CONTROLLER can widen deliberately", () => {
  const res = assertControllerPure({ "other-local": {} }, "other-local");
  assert.equal(res.ok, true);
  assert.equal(res.resolved, "other-local");
});

test("assertControllerPure: unparseable / empty / multi-key documents fail closed", () => {
  for (const doc of [null, undefined, "", "microk8s-localhost", 7, [], [{ "microk8s-localhost": {} }], {}]) {
    const res = assertControllerPure(doc, DEFAULT_ALLOWED_CONTROLLER);
    assert.equal(res.ok, false, `expected fail-closed for ${JSON.stringify(doc)}`);
    assert.equal(res.resolved, null);
  }
  const multi = assertControllerPure({ "microk8s-localhost": {}, "production-jimm": {} }, DEFAULT_ALLOWED_CONTROLLER);
  assert.equal(multi.ok, false);
  assert.match(multi.reason, /expected exactly one/);
});
