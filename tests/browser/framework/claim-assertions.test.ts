// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Failure modes of the claim assertions, as pure functions over token objects. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reauthenticated, amrRecords, subjectIsSeededIdentity, runClaimAssertions } from "./claim-assertions";
import type { CapturedTokens, ClaimAssertion, ClaimAssertionArgs } from "./scenario-types";
import type { ManifestUser } from "../seeder/manifest-schema";

type Claims = Record<string, unknown>;
const user: ManifestUser = {
  ref: "returning-mfa",
  email: "returning-mfa@example.test",
  password: "pw",
  credentials: ["password", "totp"],
  totpConfigured: true,
  totpSecret: null,
  identityId: "seeded-identity-id",
  verified: true,
};
const phase = (idTokenClaims: Claims): CapturedTokens => ({ accessTokenClaims: null, idTokenClaims });
const arg = (phases: Array<CapturedTokens | undefined>): ClaimAssertionArgs => ({
  accessTokenClaims: null,
  idTokenClaims: phases[phases.length - 1]?.idTokenClaims ?? {},
  phaseTokens: phases,
  user,
});

async function rejects(fn: () => Promise<void>, match: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.match(String(err), match);
    return true;
  });
}

test("reauthenticated: an advanced auth_time passes", async () => {
  await reauthenticated(0, 1).run(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ auth_time: 2000, iat: 2000 })]));
});

test("reauthenticated: an UNCHANGED auth_time fails — that is a replayed session", async () => {
  await rejects(
    () => reauthenticated(0, 1).run(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ auth_time: 1000, iat: 2000 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: an EARLIER auth_time fails", async () => {
  await rejects(
    () => reauthenticated(0, 1).run(arg([phase({ auth_time: 2000, iat: 2000 }), phase({ auth_time: 1000, iat: 3000 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: a missing auth_time on the max_age phase fails loudly, never inconclusively", async () => {
  await rejects(
    () => reauthenticated(0, 1).run(arg([phase({ auth_time: 1000, iat: 1000 }), phase({ iat: 2000 })])),
    /requires auth_time/,
  );
});

test("reauthenticated: falls back to the earlier phase's iat when it carries no auth_time", async () => {
  // Phase 1 without max_age may legitimately omit auth_time; an authentication
  // later than that token's issuance still cannot be the earlier one.
  await reauthenticated(0, 1).run(arg([phase({ iat: 1000 }), phase({ auth_time: 1500, iat: 1600 })]));
  await rejects(
    () => reauthenticated(0, 1).run(arg([phase({ iat: 2000 }), phase({ auth_time: 1500, iat: 2100 })])),
    /auth_time must ADVANCE/,
  );
});

test("reauthenticated: a referenced phase that issued no token fails with the reason", async () => {
  await rejects(
    () => reauthenticated(1, 2).run(arg([phase({ iat: 1000 }), undefined, phase({ auth_time: 2000, iat: 2000 })])),
    /issued no token/,
  );
});

test("reauthenticated: cross-phase indexing picks the right phases", async () => {
  // webauthn-returning-login's shape: phases 0 and 2 mint tokens, phase 1
  // (enrolment) does not.
  await reauthenticated(0, 2).run(arg([phase({ auth_time: 1000, iat: 1000 }), undefined, phase({ auth_time: 3000, iat: 3000 })]));
});

test("amrRecords: required methods must be present", async () => {
  await amrRecords({ mustInclude: ["totp"] }).run(arg([phase({ amr: ["pwd", "totp"] })]));
  await rejects(
    () => amrRecords({ mustInclude: ["totp"] }).run(arg([phase({ amr: ["pwd"] })])),
    /amr must record "totp"/,
  );
});

test("amrRecords: excluded methods must be absent even when the required one is present", async () => {
  await amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] }).run(arg([phase({ amr: ["pwd", "totp"] })]));
  await rejects(
    () => amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] }).run(arg([phase({ amr: ["pwd", "totp", "webauthn"] })])),
    /amr must NOT record "webauthn"/,
  );
});

test("amrRecords: an absent or non-array amr fails rather than passing by omission", async () => {
  await rejects(() => amrRecords({ mustInclude: ["totp"] }).run(arg([phase({ sub: "x" })])), /amr must be an array/);
  await rejects(() => amrRecords({ mustInclude: ["totp"] }).run(arg([phase({ amr: "totp" })])), /amr must be an array/);
});

test("amrRecords: refuses an empty mustInclude at construction", () => {
  assert.throws(() => amrRecords({ mustInclude: [] }), /mustInclude must name at least one method/);
});

test("amrRecords: reads amr from a named phase when asked", async () => {
  await amrRecords({ mustInclude: ["oidc"] }, 0).run(arg([phase({ amr: ["oidc"] }), phase({ amr: ["pwd"] })]));
  await rejects(
    () => amrRecords({ mustInclude: ["oidc"] }, 1).run(arg([phase({ amr: ["oidc"] }), phase({ amr: ["pwd"] })])),
    /amr must record "oidc"/,
  );
});

test("subjectIsSeededIdentity: sub must equal the manifest identity id, not merely exist", async () => {
  await subjectIsSeededIdentity().run(arg([phase({ sub: "seeded-identity-id" })]));
  await rejects(
    () => subjectIsSeededIdentity().run(arg([phase({ sub: "some-other-identity" })])),
    /seeded identity of user "returning-mfa"/,
  );
});

test("runClaimAssertions: runs in order, stops at the first failure, and names it", async () => {
  const calls: string[] = [];
  const passing = (name: string): ClaimAssertion => ({ name, async run() { calls.push(name); } });
  await runClaimAssertions([passing("first"), passing("second")], arg([phase({})]));
  assert.deepEqual(calls, ["first", "second"]);

  calls.length = 0;
  await rejects(
    () =>
      runClaimAssertions(
        [passing("before"), amrRecords({ mustInclude: ["totp"] }), passing("after")],
        arg([phase({ amr: ["pwd"] })]),
      ),
    /claim assertion amrRecords\(include=\[totp\]\) failed: .*amr must record "totp"/s,
  );
  assert.deepEqual(calls, ["before"], "assertions after the failing one must not run");
});
