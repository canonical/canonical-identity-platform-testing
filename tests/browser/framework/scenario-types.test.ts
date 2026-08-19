// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * `defineScenario()`'s import-time guards, pinned.
 *
 * The constructor is the only thing standing between a malformed declaration
 * and a test that passes for the wrong reason. `expectError` is the sharp case
 * (R-2): it is enforced at self-transitions, so a scenario that declares it on
 * a path with no repeated state gets a green run and asserts nothing about the
 * error it claims to test. That has to fail at collection, not at runtime.
 *
 * Run: npx tsx --test framework/scenario-types.test.ts  (or `npm run
 * test:unit`). No stack, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { defineScenario } from "./scenario-types";
import type { Scenario } from "./scenario-types";

/** The shape every case below varies: a valid single-phase error scenario. */
const BASE: Scenario = {
  id: "example",
  description: "example",
  requires: { localUsersEnabled: true },
  user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
  expectedPath: ["login-email", "login-password", "login-password"],
  expectError: true,
};

test("expectError is accepted on a path that repeats a state", () => {
  const scenario = defineScenario({ ...BASE });
  assert.equal(scenario.expectError, true);
});

test("expectError without a self-transition is rejected at import", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
      }),
    /no self-transition/,
  );
});

test("expectError on the scenario is rejected when it declares phases", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: undefined,
        phases: [
          {
            name: "reject",
            expectedPath: ["login-email", "login-password", "login-password"],
          },
        ],
      }),
    /alongside phases/,
  );
});

test("an intervention anchored to a state absent from the path is rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [{ at: "login-totp-verify", do: "reload" }],
      }),
    /exactly once in the path/,
  );
});

test("reload at oidc-callback is rejected (that is replay-current-url's job)", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [{ at: "oidc-callback", do: "reload" }],
      }),
    /replay-current-url/,
  );
});

test("replay-current-url off the final state is rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [
          { at: "login-password", do: "replay-current-url", expect: "login-password" },
        ],
      }),
    /only.*legal at the final path state/,
  );
});

test("history-back without untilUrl is rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [
          { at: "oidc-callback", do: "history-back", expect: "oidc-callback-error" },
        ],
      }),
    /requires untilUrl/,
  );
});

test("a double-submit intervention on a pair not in the path is rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [{ on: "login-totp-verify → oidc-callback", do: "double-submit" }],
      }),
    /does not match/,
  );
});

test("a valid intervention set on the final callback state is accepted", () => {
  const scenario = defineScenario({
    ...BASE,
    expectedPath: ["login-email", "login-password", "oidc-callback"],
    expectError: undefined,
    interventions: [
      { at: "login-password", do: "reload" },
      { on: "login-email → login-password", do: "double-submit" },
      { at: "oidc-callback", do: "replay-current-url", expect: "oidc-callback-error" },
    ],
    postChecks: ["code-replay-revokes-family"],
  });
  assert.equal(scenario.interventions?.length, 3);
});

test("postChecks on a scenario not ending at the callback are rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        postChecks: ["code-replay-revokes-family"],
      }),
    /postChecks/,
  );
});

test("history-roundtrip without via is rejected", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [{ at: "login-password", do: "history-roundtrip" }],
      }),
    /requires via/,
  );
});

test("history-roundtrip rejects expect/untilUrl/expectUrlContains", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
        expectError: undefined,
        interventions: [
          { at: "login-password", do: "history-roundtrip", via: "login-email", expect: "login-email" },
        ],
      }),
    /takes no expect/,
  );
});

test("history-roundtrip is accepted mid-walk", () => {
  const scenario = defineScenario({
    ...BASE,
    expectedPath: ["login-email", "login-password", "oidc-callback"],
    expectError: undefined,
    interventions: [{ at: "login-password", do: "history-roundtrip", via: "login-email" }],
  });
  assert.equal(scenario.interventions?.length, 1);
});

test("phase-level expectError without a self-transition is rejected at import", () => {
  assert.throws(
    () =>
      defineScenario({
        ...BASE,
        expectedPath: undefined,
        expectError: undefined,
        phases: [
          {
            name: "reject",
            expectedPath: ["login-email", "login-password", "oidc-callback"],
            expectError: true,
          },
        ],
      }),
    /phase "reject" declares expectError/,
  );
});
