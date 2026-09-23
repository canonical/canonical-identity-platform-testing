// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Core login: first-time MFA setup, returning MFA, MFA off, group claims, expired TOTP. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const loginScenarios = defineScenarioSuite({
  name: "login",
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "first-login-mfa",
    description: "First-time login with MFA enabled — user must set up TOTP",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "first-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "login-password",
      "setup-secure",
      "setup-complete",
      "oidc-callback",
    ],
    // first-mfa is in no group; paired with login-carries-group-claim this proves enrichment is selective.
    assertions: { noTenantId: true, noGroups: true },
    cleanup: "remove-totp",
  }),

  defineScenario({
    id: "login-carries-group-claim",
    description:
      "A user in a hook-service group receives that group in both the access and ID token",
    requires: { mfaEnabled: true, localUsersEnabled: true, hookService: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true, groups: ["platform-testers"] },
  }),

  defineScenario({
    id: "returning-login-mfa",
    description: "Returning user with TOTP already configured",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "login-mfa-off",
    description: "Login with MFA disabled — password only, no TOTP",
    requires: { mfaEnabled: false, localUsersEnabled: true },
    user: { ref: "no-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "login-password",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  // Unlike invalid-totp-code, the code WAS valid three windows ago; the rejection is Kratos's skew check.
  defineScenario({
    id: "expired-totp-code",
    description: "Expired TOTP code shows error, stays on login-totp-verify page",
    requires: { mfaEnabled: true, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-totp-verify",
    ],
    totpCodeWindow: "expired",
    expectError: true,
  }),
  ],
});
