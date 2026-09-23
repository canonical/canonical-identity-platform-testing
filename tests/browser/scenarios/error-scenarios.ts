// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Wrong password, wrong TOTP code, and backup-code login. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const errorScenarios = defineScenarioSuite({
  name: "error",
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "wrong-password-error",
    description: "Wrong password shows error message on login-password page",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-password",
    ],
    expectError: true,
  }),

  defineScenario({
    id: "invalid-totp-code",
    description: "Wrong TOTP code shows error on login-totp-verify page",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-totp-verify",
    ],
    expectError: true,
  }),

  defineScenario({
    id: "backup-code-login",
    description: "User switches from TOTP verify to backup code and authenticates",
    requires: { mfaEnabled: true, hookService: true, localUsersEnabled: true },
    user: { ref: "backup-code-user", credentials: ["password", "totp", "lookup_secret"], totpConfigured: true },
    // lookup_secret ⇒ the runner reads an unused code via the admin API and the walk spends it: internal only.
    lanes: ["internal"],
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
