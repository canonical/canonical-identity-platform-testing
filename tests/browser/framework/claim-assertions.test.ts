// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The claim assertions are the only thing standing between "the page looked
 * right" and "the platform really re-authenticated", so their failure modes are
 * pinned here rather than discovered on a stack. Pure functions over token
 * objects — no browser, no stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reauthenticated, amrRecords, allOf } from "./claim-assertions";
import type { CapturedTokens, CustomAssertionArgs } from "./scenario-types";

type Claims = Record<string, unknown>;
const phase = (idTokenClaims: Claims): CapturedTokens => ({ accessTokenClaims: null, idTokenClaims });
const arg = (phases: Array<CapturedTokens | undefined>): CustomAssertionArgs => ({
  accessTokenClaims: null,
  idTokenClaims: phases[phases.length - 1]?.idTokenClaims ?? {},
  phaseTokens: phases,
});

async function rejects(fn: () => Promise<void>, match: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.match(String(err), match);
    return true;
  });
}

test("reauthenticated: an advanced auth_time passes", async () => {
  await reauthenticated(0, 1)(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ auth_time: 2000, iat: 2000 })]));
});

test("reauthenticated: an UNCHANGED auth_time fails — that is a replayed session", async () => {
  await rejects(
    () => reauthenticated(0, 1)(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ auth_time: 1000, iat: 2000 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: an EARLIER auth_time fails", async () => {
  await rejects(
    () => reauthenticated(0, 1)(arg([phase({ auth_time: 2000, iat: 2000 }), phase({ auth_time: 1000, iat: 3000 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: a missing auth_time on the max_age phase fails loudly, never inconclusively", async () => {
  await rejects(
    () => reauthenticated(0, 1)(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ iat: 2000 })])),
    /requires auth_time/,
  );
});

test("reauthenticated: falls back to the earlier phase's iat when it carries no auth_time", async () => {
  // Phase 1 without max_age may legitimately omit auth_time; an authentication
  // later than that token's issuance still cannot be the earlier one.
  await reauthenticated(0, 1)(arg([phase({ iat: 1000 }), phase({ auth_time: 1500, iat: 1600 })]));
  await rejects(
    () => reauthenticated(0, 1)(arg([phase({ iat: 2000 }), phase({ auth_time: 1500, iat: 2100 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: a referenced phase that issued no token fails with the reason", async () => {
  // Index 1 minted nothing, so comparing against it cannot conclude anything —
  // and must say so rather than pass on the phases that did mint.
  await rejects(
    () => reauthenticated(1, 2)(arg([phase({ iat: 1000 }), undefined, phase({ auth_time: 2000, iat: 2000 })])),
    /issued no token/,
  );
});

test("reauthenticated: cross-phase indexing picks the right phases", async () => {
  // webauthn-returning-login's shape: phase 1 and phase 3 mint tokens, phase 2
  // (enrolment) does not.
  await reauthenticated(0, 2)(arg([phase({ auth_time: 1000, iat: 1000 }), undefined, phase({ auth_time: 3000, iat: 3000 })]));
});

test("amrRecords: required methods must be present", async () => {
  await amrRecords({ mustInclude: ["totp"] })(arg([phase({ amr: ["pwd", "totp"] })]));
  await rejects(
    () => amrRecords({ mustInclude: ["totp"] })(arg([phase({ amr: ["pwd"] })])),
    /amr must record "totp"/,
  );
});

test("amrRecords: excluded methods must be absent — this is how PD-4's thesis is falsifiable", async () => {
  await amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] })(arg([phase({ amr: ["pwd", "totp"] })]));
  // If a release made the security key satisfy the gate too, this must fail on
  // the exclusion even though the required method is still present.
  await rejects(
    () => amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] })(arg([phase({ amr: ["pwd", "totp", "webauthn"] })])),
    /amr must NOT record "webauthn"/,
  );
});

test("amrRecords: a non-array amr fails rather than being coerced", async () => {
  await rejects(() => amrRecords({ mustInclude: ["totp"] })(arg([phase({ amr: "totp" })])), /amr must be an array/);
});

test("amrRecords: reads amr from a named phase when asked", async () => {
  await amrRecords({ mustInclude: ["oidc"] }, 0)(arg([phase({ amr: ["oidc"] }), phase({ amr: ["pwd"] })]));
  await rejects(
    () => amrRecords({ mustInclude: ["oidc"] }, 1)(arg([phase({ amr: ["oidc"] }), phase({ amr: ["pwd"] })])),
    /amr must record "oidc"/,
  );
});

test("allOf: runs every assertion and surfaces the first failure", async () => {
  const calls: string[] = [];
  const ok = async () => { calls.push("ok"); };
  await allOf(ok, ok)(arg([phase({})]));
  assert.deepEqual(calls, ["ok", "ok"]);

  await rejects(
    () => allOf(reauthenticated(0, 1), amrRecords({ mustInclude: ["totp"] }))(
      arg([phase({ auth_time: 1000, iat: 1000 }), phase({ auth_time: 1000, iat: 2000, amr: ["totp"] })]),
    ),
    /auth_time must ADVANCE/,
  );
});
