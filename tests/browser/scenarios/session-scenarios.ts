// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Session lifecycle: reuse without max_age, forced re-auth with max_age=0, backup-code regeneration prompt. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { amrRecords, reauthenticated } from "../framework/claim-assertions";

export const sessionScenarios = defineScenarioSuite({
  name: "session",
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "session-reuse-no-max-age",
    description: "Second login reuses existing Kratos session (no max_age)",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "login-password",
          "login-totp-verify",
          "oidc-callback",
        ],
      },
      {
        name: "reuse-session",
        flowParams: {},
        expectedPath: ["oidc-callback"],
      },
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "forced-reauth-max-age-0",
    description: "max_age=0 forces full re-authentication including MFA",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "login-password",
          "login-totp-verify",
          "oidc-callback",
        ],
      },
      {
        name: "forced-reauth",
        flowParams: { max_age: "0" },
        expectedPath: [
          "login-email",
          "login-password",
          "login-totp-verify",
          "oidc-callback",
        ],
      },
    ],
    // The path alone cannot tell a re-challenge from a replayed session; max_age makes `auth_time` mandatory.
    assertions: {
      noTenantId: true,
      claims: [
        reauthenticated(0, 1),
        amrRecords({ mustInclude: ["totp"] }),
      ],
    },
  }),

  // Entering the email is not a sign-in: the request opened again still shows its login.
  defineScenario({
    id: "forced-reauth-not-met-by-reopening-the-request",
    description: "max_age=0 with a session: after the email step, the login request opened again still asks who is signing in",
    requires: { mfaEnabled: true, localUsersEnabled: true, multiTenancy: false },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    phases: [
      {
        name: "establish-session",
        expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      },
      {
        name: "forced-reauth",
        flowParams: { max_age: "0" },
        expectedPath: ["login-email", "login-password"],
        interventions: [{ at: "login-password", do: "reopen-login-request", expect: "login-email" }],
      },
    ],
  }),

  // PD-13 (login-ui#988), pinned: with multi-tenancy the same walk ends at the RP (testing-spec §10).
  // When fixed, drop this pin and the multiTenancy gate of the scenario above.
  defineScenario({
    id: "forced-reauth-skipped-by-reopening-the-request",
    description: "PD-13: max_age=0 with a session and multi-tenancy: after the email step, the login request opened again is accepted on the old session",
    requires: { mfaEnabled: true, localUsersEnabled: true, multiTenancy: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    phases: [
      {
        name: "establish-session",
        expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      },
      {
        name: "forced-reauth",
        flowParams: { max_age: "0" },
        expectedPath: ["login-email", "login-password"],
        interventions: [{ at: "login-password", do: "reopen-login-request", expect: "oidc-callback" }],
      },
    ],
  }),

  defineScenario({
    id: "backup-code-regeneration-prompt",
    description: "User running low on backup codes is prompted to regenerate after signing in with one",
    requires: { mfaEnabled: true, hookService: true, localUsersEnabled: true },
    user: { ref: "backup-code-user-2", credentials: ["password", "totp", "lookup_secret"], totpConfigured: true },
    // lookup_secret ⇒ the runner reads an unused code via the admin API and the walk spends it: internal only.
    lanes: ["internal"],
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-backup-code-verify",
      "backup-code-regenerate",
      "oidc-callback",
    ],
  }),
  ],
});
