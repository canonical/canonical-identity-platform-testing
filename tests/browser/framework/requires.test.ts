// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * `satisfies()` semantics, pinned.
 *
 * This predicate is load-bearing TWICE over: `runScenario` gates every
 * scenario with it, and `scripts/expected-set.ts` computes the expected
 * execution set with the SAME function. That is deliberate (they cannot
 * drift), but it also means a predicate bug shifts gating and expectation in
 * lockstep and the row still reports "executed (matching the declaration
 * exactly)". Nothing else in the tree pins these semantics, so this file is
 * the only place a wrong answer can be caught.
 *
 * Run: npx tsx --test framework/requires.test.ts  (or `npm run test:unit`,
 * chained into `make check`). No stack, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { satisfies } from "./requires";
import type { ActiveConfig } from "./active-config";
import type { ScenarioRequires } from "./scenario-types";

/** A fully-populated declaration: everything on, both services, both providers. */
const FULL: ActiveConfig = {
  oidc_webauthn_sequencing_enabled: true,
  base_url: "http://localhost",
  identifier_first_enabled: true,
  multi_tenancy_enabled: true,
  support_email: "support@test.example",
  flags: [],
  services: ["kratos", "hydra", "login-ui", "dex", "openfga", "hook-service", "tenant-service"],
  methods_1fa: ["password", "oidc"],
  methods_2fa: ["totp", "lookup_secret", "webauthn"],
  mfa_enforced: true,
  webauthn_enabled: true,
  oidc_enabled: true,
  local_users_enabled: true,
  registration_enabled: true,
  account_linking_enabled: true,
  oidc_providers: ["dex", "google"],
  mail_api: true,
  access_token_format: "jwt",
};

/** Everything off: no optional services, no second factor, oidc only. */
const MINIMAL: ActiveConfig = {
  ...FULL,
  oidc_webauthn_sequencing_enabled: false,
  multi_tenancy_enabled: false,
  services: ["kratos", "hydra", "login-ui", "dex"],
  methods_1fa: ["oidc"],
  methods_2fa: [],
  mfa_enforced: false,
  webauthn_enabled: false,
  oidc_enabled: true,
  local_users_enabled: false,
  registration_enabled: false,
  account_linking_enabled: false,
  oidc_providers: ["dex"],
  mail_api: false,
};

/** Every boolean key: which ActiveConfig field it reads, and its true-value config. */
const BOOLEAN_KEYS: Array<{ key: keyof ScenarioRequires; met: ActiveConfig; unmet: ActiveConfig; reasonKey: string }> = [
  { key: "webauthnEnabled", met: FULL, unmet: MINIMAL, reasonKey: "webauthnEnabled" },
  { key: "multiTenancy", met: FULL, unmet: MINIMAL, reasonKey: "multiTenancy" },
  { key: "mfaEnforced", met: FULL, unmet: MINIMAL, reasonKey: "mfaEnforced" },
  { key: "oidcSequencing", met: FULL, unmet: MINIMAL, reasonKey: "oidcSequencing" },
  { key: "registrationEnabled", met: FULL, unmet: MINIMAL, reasonKey: "registrationEnabled" },
  { key: "localUsersEnabled", met: FULL, unmet: MINIMAL, reasonKey: "localUsersEnabled" },
  { key: "accountLinkingEnabled", met: FULL, unmet: MINIMAL, reasonKey: "accountLinkingEnabled" },
  // mfaEnabled is a legacy alias: it reads methods_2fa.includes("totp"), NOT mfa_enforced.
  { key: "mfaEnabled", met: FULL, unmet: MINIMAL, reasonKey: "mfaEnabled" },
  // hookService is a legacy alias for service presence.
  { key: "hookService", met: FULL, unmet: MINIMAL, reasonKey: "hookService" },
];

for (const { key, met, unmet, reasonKey } of BOOLEAN_KEYS) {
  test(`${key}: true is met by the enabled config and unmet by the disabled one`, () => {
    assert.equal(satisfies({ [key]: true } as ScenarioRequires, met).met, true);
    const no = satisfies({ [key]: true } as ScenarioRequires, unmet);
    assert.equal(no.met, false);
    // Every reason must start "requires " — both skip allow-lists match on
    // /^Skipped: requires / after the runner's prefix.
    assert.match(no.reason ?? "", new RegExp(`^requires ${reasonKey}=true`));
  });

  test(`${key}: false is UNMET when the deployment has it on (exact match, not "at least")`, () => {
    const no = satisfies({ [key]: false } as ScenarioRequires, met);
    assert.equal(no.met, false, `${key}: false must not be satisfied by an enabled deployment`);
    assert.equal(satisfies({ [key]: false } as ScenarioRequires, unmet).met, true);
  });

}

test("an absent key is never gated on — an empty declaration always passes", () => {
  assert.deepEqual(satisfies({}, FULL), { met: true });
  assert.deepEqual(satisfies({}, MINIMAL), { met: true });
});

test("mfaEnabled reads methods_2fa, not mfa_enforced (the two are independent)", () => {
  // Second factor available but not enforced: mfaEnabled met, mfaEnforced not.
  const available = { ...FULL, mfa_enforced: false };
  assert.equal(satisfies({ mfaEnabled: true }, available).met, true);
  assert.equal(satisfies({ mfaEnforced: true }, available).met, false);
});

test("null booleans in the declaration count as false", () => {
  // capabilities.json legitimately carries null for "not producible / unknown"
  // (e.g. webauthn on the pinned rows). Null must gate OFF, never pass.
  const nulled: ActiveConfig = { ...FULL, webauthn_enabled: null, mfa_enforced: null };
  assert.equal(satisfies({ webauthnEnabled: true }, nulled).met, false);
  assert.equal(satisfies({ webauthnEnabled: false }, nulled).met, true);
  assert.equal(satisfies({ mfaEnforced: true }, nulled).met, false);
});

test("oidcProviders is SUBSET semantics: required ⊆ available", () => {
  assert.equal(satisfies({ oidcProviders: ["dex"] }, FULL).met, true);
  assert.equal(satisfies({ oidcProviders: ["dex", "google"] }, FULL).met, true);
  // Extra providers on the deployment never disqualify a scenario…
  assert.equal(satisfies({ oidcProviders: ["dex"] }, { ...FULL, oidc_providers: ["dex", "google", "okta"] }).met, true);
  // …but a missing one does, and the reason names exactly what is missing.
  const no = satisfies({ oidcProviders: ["dex", "google"] }, MINIMAL);
  assert.equal(no.met, false);
  assert.match(no.reason ?? "", /^requires OIDC providers \[dex, google\], ActiveConfig is missing \[google\]$/);
});

test("an empty provider/method list is not a constraint", () => {
  assert.equal(satisfies({ oidcProviders: [] }, MINIMAL).met, true);
  assert.equal(satisfies({ firstFactorMethods: [] }, MINIMAL).met, true);
  assert.equal(satisfies({ secondFactorMethods: [] }, MINIMAL).met, true);
});

test("firstFactorMethods / secondFactorMethods are subset semantics too", () => {
  assert.equal(satisfies({ firstFactorMethods: ["password"] }, FULL).met, true);
  assert.equal(satisfies({ firstFactorMethods: ["password"] }, MINIMAL).met, false);
  assert.equal(satisfies({ firstFactorMethods: ["oidc"] }, MINIMAL).met, true);
  assert.equal(satisfies({ secondFactorMethods: ["totp", "webauthn"] }, FULL).met, true);
  const no = satisfies({ secondFactorMethods: ["totp", "webauthn"] }, { ...FULL, methods_2fa: ["totp"] });
  assert.equal(no.met, false);
  assert.match(no.reason ?? "", /missing \[webauthn\]/);
});

test('"service:<name>" keys gate on declared service presence, both directions', () => {
  assert.equal(satisfies({ "service:tenant-service": true }, FULL).met, true);
  assert.equal(satisfies({ "service:tenant-service": true }, MINIMAL).met, false);
  assert.equal(satisfies({ "service:tenant-service": false }, MINIMAL).met, true);
  const no = satisfies({ "service:user-verification-service": true }, FULL);
  assert.equal(no.met, false);
  assert.match(no.reason ?? "", /^requires service:user-verification-service=true, ActiveConfig=false$/);
});

test("mailApi: an ABSENT mail_api key defaults to true", () => {
  // Mail was an unconditional assumption before it became a capability, so a
  // declaration written before the key existed must keep passing mailApi:true.
  const { mail_api: _omitted, ...withoutMailApi } = FULL;
  const legacy = withoutMailApi as ActiveConfig;
  assert.equal(satisfies({ mailApi: true }, legacy).met, true);
  // …and mailApi:false must then be UNMET, not silently accepted.
  const no = satisfies({ mailApi: false }, legacy);
  assert.equal(no.met, false);
  assert.match(no.reason ?? "", /^requires mailApi=false, ActiveConfig mail_api=true$/);
});

test("mailApi: an explicit false gates mail-reading scenarios off", () => {
  assert.equal(satisfies({ mailApi: true }, MINIMAL).met, false);
  assert.equal(satisfies({ mailApi: true }, FULL).met, true);
});

test("multiple keys: the FIRST unmet one is reported and met-ness is conjunctive", () => {
  const all: ScenarioRequires = { oidcEnabled: true, multiTenancy: true, hookService: true, mailApi: true };
  assert.equal(satisfies(all, FULL).met, true);
  const no = satisfies(all, MINIMAL);
  assert.equal(no.met, false);
  // Evaluation order is the function's declaration order: multiTenancy (2nd
  // check) precedes hookService (10th) and mailApi (15th).
  assert.match(no.reason ?? "", /^requires multiTenancy=true/);
});

test("every reason begins with 'requires ' so both skip allow-lists match", () => {
  const unmet: ScenarioRequires[] = [
    { webauthnEnabled: true },
    { multiTenancy: true },
    { mfaEnforced: true },
    { oidcSequencing: true },
    { registrationEnabled: true },
    { localUsersEnabled: true },
    { accountLinkingEnabled: true },
    { mfaEnabled: true },
    { hookService: true },
    { oidcProviders: ["google"] },
    { firstFactorMethods: ["password"] },
    { secondFactorMethods: ["totp"] },
    { "service:tenant-service": true },
    { mailApi: true },
  ];
  for (const requires of unmet) {
    const result = satisfies(requires, MINIMAL);
    assert.equal(result.met, false, `expected unmet: ${JSON.stringify(requires)}`);
    assert.match(result.reason ?? "", /^requires /, `reason shape for ${JSON.stringify(requires)}`);
    assert.match(`Skipped: ${result.reason}`, /^Skipped: requires /i);
  }
});
