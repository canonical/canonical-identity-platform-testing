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
