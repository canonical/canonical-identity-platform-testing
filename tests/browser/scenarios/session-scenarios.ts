// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Session scenario suite — session lifecycle flows.
 *
 * Covers: session reuse (no max_age), forced re-auth (max_age=0).
 * These are multi-phase scenarios that establish a session in phase 1
 * and test session behavior in phase 2.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { allOf, amrRecords, reauthenticated } from "../framework/claim-assertions";

export const sessionScenarios = defineScenarioSuite({
  name: "session",
  defaultLanes: ["live", "internal"],
  scenarios: [
  // ── Session reuse (no max_age) ─────────────────────────────────────────
  defineScenario({
    id: "session-reuse-no-max-age",
    description: "Second login reuses existing Kratos session (no max_age)",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
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

  // ── Forced re-auth (max_age=0) ────────────────────────────────────────
  defineScenario({
    id: "forced-reauth-max-age-0",
    description: "max_age=0 forces full re-authentication including MFA",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
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
    // Path alone cannot tell a genuine re-challenge from a replayed session:
    // both walk login-email → … → oidc-callback. `auth_time` is the platform's
    // own answer, and max_age makes it mandatory (R-22).
    assertions: {
      noTenantId: true,
      custom: allOf(
        reauthenticated(0, 1),
        amrRecords({ mustInclude: ["totp"] }),
      ),
    },
  }),

  // ── Backup code regeneration prompt ────────────────────────────────────
  defineScenario({
    id: "backup-code-regeneration-prompt",
    description: "User running low on backup codes is prompted to regenerate after signing in with one",
    requires: { mfaEnabled: true, multiTenancy: false, hookService: true, localUsersEnabled: true },
    user: { ref: "backup-code-user-2", credentials: ["password", "totp", "lookup_secret"], totpConfigured: true },
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
