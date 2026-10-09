// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** The invariant oracles, pinned on the defects they are for, and proven silent on every declared
 *  scenario: I2 over a declared path is a pure function of the data, so a false positive would show
 *  here before any browser runs. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertNoServerErrors, demandsReauthentication, i2Applies, i2Violation, i3Violation, walkedAtTerminal } from "./invariants";
import type { Manifest, ManifestUser } from "../seeder/manifest-schema";
import type { Scenario } from "./scenario-types";

import { accountLinkingScenarios } from "../scenarios/account-linking-scenarios";
import { derivedScenarios } from "../scenarios/derived-scenarios";
import { deviceScenarios } from "../scenarios/device-scenarios";
import { errorScenarios } from "../scenarios/error-scenarios";
import { googleOidcScenarios } from "../scenarios/google-oidc-scenarios";
import { loginScenarios } from "../scenarios/login-scenarios";
import { oidcErrorScenarios } from "../scenarios/oidc-error-scenarios";
import { oidcScenarios, oidcSequencingScenarios } from "../scenarios/oidc-scenarios";
import { recoveryScenarios } from "../scenarios/recovery-scenarios";
import { registrationScenarios } from "../scenarios/registration-scenarios";
import { resilienceScenarios } from "../scenarios/resilience-scenarios";
import { sessionScenarios } from "../scenarios/session-scenarios";
import { settingsScenarios } from "../scenarios/settings-scenarios";
import { tenantScenarios } from "../scenarios/tenant-scenarios";
import { verificationScenarios } from "../scenarios/verification-scenarios";
import { webauthnScenarios } from "../scenarios/webauthn-scenarios";

const ALL: Scenario[] = [
  accountLinkingScenarios, derivedScenarios, deviceScenarios, errorScenarios, googleOidcScenarios, loginScenarios,
  oidcErrorScenarios, oidcScenarios, oidcSequencingScenarios, recoveryScenarios, registrationScenarios,
  resilienceScenarios, sessionScenarios, settingsScenarios, tenantScenarios, verificationScenarios,
  webauthnScenarios,
].flatMap((s) => s.scenarios);

test("I2 is silent on every declared scenario on the strictest row, except where the scenario pins it", () => {
  const violations: string[] = [];
  const pinsNotMet: string[] = [];
  for (const scenario of ALL) {
    const phases = scenario.phases ?? [{ name: "default", flowParams: scenario.flowParams, expectedPath: scenario.expectedPath!, interventions: scenario.interventions }];
    let violated = false;
    for (const [index, phase] of phases.entries()) {
      if (!i2Applies(phase.expectedPath) || !demandsReauthentication(index, phase)) continue;
      const v = i2Violation({
        walked: walkedAtTerminal(phase.expectedPath, phase.interventions),
        mfaEnforced: true,
        totpConfigured: scenario.user.totpConfigured === true,
      });
      if (!v) continue;
      if (scenario.pinnedInvariantViolation === "I2") violated = true;
      else violations.push(`${scenario.id} phase "${phase.name}": ${v}`);
    }
    if (scenario.pinnedInvariantViolation === "I2" && !violated) pinsNotMet.push(scenario.id);
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(pinsNotMet, []);
});

test("walkedAtTerminal restarts the record at the last re-entry's landing", () => {
  const path = ["login-email", "login-password", "login-totp-verify", "login-email", "login-password", "oidc-callback"] as const;
  assert.deepEqual(walkedAtTerminal(path, [{ atIndex: 2, do: "back" }]), ["login-email", "login-password", "oidc-callback"]);
  assert.deepEqual(walkedAtTerminal(path), [...path]);
});

test("I0: a pinned 5xx is required and tolerated; any other 5xx still fails", () => {
  const pinned = { status: 500, method: "GET", url: "http://localhost/self-service/settings/browser" };
  const other = { status: 502, method: "POST", url: "http://localhost/api/kratos/self-service/login?flow=x" };
  assert.equal(assertNoServerErrors([], "p"), false);
  assert.equal(assertNoServerErrors([pinned], "p", "/self-service/settings/browser"), true);
  assert.equal(assertNoServerErrors([], "p", "/self-service/settings/browser"), false);
  assert.throws(() => assertNoServerErrors([pinned], "p"), /500 GET/);
  assert.throws(() => assertNoServerErrors([pinned, other], "p", "/self-service/settings/browser"), /502 POST/);
});

test("I2 flags PD-13: the request opened again is accepted with no credential step", () => {
  // forced-reauth phase, re-entry at the password step resets the record; the landing is the callback.
  const v = i2Violation({ walked: ["oidc-callback"], mfaEnforced: true, totpConfigured: true });
  assert.match(v ?? "", /no credential step was walked/);
});

test("I2 flags the abandoned-setup accept (testing-spec §2 of the proposal)", () => {
  // max_age=0 request: setup-secure walked with no first factor before it in this phase.
  const v = i2Violation({ walked: ["login-email", "setup-secure", "setup-complete", "oidc-callback"], mfaEnforced: true, totpConfigured: false });
  assert.match(v ?? "", /no credential step was walked/);
});

test("I2 accepts enrolment as a sign-in after a first factor", () => {
  assert.equal(
    i2Violation({ walked: ["login-email", "login-password", "setup-secure", "setup-complete", "oidc-callback"], mfaEnforced: true, totpConfigured: false }),
    undefined,
  );
});

test("I2 demands the second factor only for an enrolled local user on an enforced row", () => {
  const walked = ["login-email", "login-password", "oidc-callback"] as const;
  assert.match(i2Violation({ walked, mfaEnforced: true, totpConfigured: true }) ?? "", /no second-factor step/);
  assert.equal(i2Violation({ walked, mfaEnforced: false, totpConfigured: true }), undefined);
  assert.equal(i2Violation({ walked, mfaEnforced: true, totpConfigured: false }), undefined);
  // External-provider sign-ins are exempt from enforcement.
  assert.equal(i2Violation({ walked: ["login-email", "provider:dex:login", "oidc-callback"], mfaEnforced: true, totpConfigured: true }), undefined);
});

test("demandsReauthentication: phase 0, cleared cookies, max_age=0, prompt=login", () => {
  assert.equal(demandsReauthentication(0, {}), true);
  assert.equal(demandsReauthentication(1, {}), false);
  assert.equal(demandsReauthentication(1, { freshSession: true }), true);
  assert.equal(demandsReauthentication(1, { flowParams: { max_age: "0" } }), true);
  assert.equal(demandsReauthentication(1, { flowParams: { max_age: "3600" } }), false);
  assert.equal(demandsReauthentication(1, { flowParams: { prompt: "login" } }), true);
  assert.equal(demandsReauthentication(1, { flowParams: { prompt: "consent login" } }), true);
  assert.equal(demandsReauthentication(1, { flowParams: { prompt: "none" } }), false);
});

const user: ManifestUser = {
  ref: "u", email: "u@test.example", password: "x", credentials: ["password"], totpConfigured: false, totpSecret: null,
  identityId: "id-u", verified: true, tenantRefs: ["alpha"],
};
const manifest = { tenants: [{ ref: "alpha", name: "Alpha", id: "t-alpha" }, { ref: "beta", name: "Beta", id: "t-beta" }] } as unknown as Manifest;
const base = { user, manifest, hookServicePresent: true, identityCreatedByWalk: false, accessTokenClaims: null };

test("I3 flags PD-14: another user's tenant on the tokens of the one who signed in", () => {
  assert.match(i3Violation({ ...base, idTokenClaims: { sub: "id-u", tenant_id: "t-beta" } }) ?? "", /not one of the tenants/);
  assert.equal(i3Violation({ ...base, idTokenClaims: { sub: "id-u", tenant_id: "t-alpha" } }), undefined);
  assert.equal(i3Violation({ ...base, idTokenClaims: { sub: "id-u" } }), undefined);
});

test("I3 flags a foreign subject, and a tenant_id with no writer deployed", () => {
  assert.match(i3Violation({ ...base, idTokenClaims: { sub: "id-other" } }) ?? "", /sub is "id-other"/);
  assert.equal(i3Violation({ ...base, identityCreatedByWalk: true, idTokenClaims: { sub: "id-other" } }), undefined);
  assert.match(i3Violation({ ...base, hookServicePresent: false, idTokenClaims: { sub: "id-u", tenant_id: "t-alpha" } }) ?? "", /only writer/);
});

test("I3 checks the access token too when it is a JWT", () => {
  assert.match(
    i3Violation({ ...base, idTokenClaims: { sub: "id-u" }, accessTokenClaims: { tenant_id: "t-beta" } }) ?? "",
    /access_token tenant_id/,
  );
});
