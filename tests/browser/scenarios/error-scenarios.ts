// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Error scenario suite — error and recovery paths.
 *
 * Covers: wrong password, invalid TOTP code, backup code login.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const errorScenarios = defineScenarioSuite({
  name: "error",
  defaultLanes: ["live", "internal"],
  scenarios: [
  // ── Wrong password ────────────────────────────────────────────────────
  defineScenario({
    id: "wrong-password-error",
    description: "Wrong password shows error message on login-password page",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-password",  // rejected — stays on the password page
    ],
    expectError: true,
  }),

  // ── Wrong TOTP code ───────────────────────────────────────────────────
  // The expired-code counterpart lives in login-scenarios.ts; it submits a
  // well-formed code from a stale window instead of a code that never existed.
  defineScenario({
    id: "invalid-totp-code",
    description: "Wrong TOTP code shows error on login-totp-verify page",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-totp-verify",  // rejected — stays on the verify page
    ],
    expectError: true,
  }),

  // ── Backup code login ─────────────────────────────────────────────────
  defineScenario({
    id: "backup-code-login",
    description: "User switches from TOTP verify to backup code and authenticates",
    requires: { mfaEnabled: true, multiTenancy: false, hookService: true, localUsersEnabled: true },
    user: { ref: "backup-code-user", credentials: ["password", "totp", "lookup_secret"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-backup-code-verify",
      "oidc-callback",
    ],
  }),
  ],
});
