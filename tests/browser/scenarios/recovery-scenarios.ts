// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Password reset via emailed code (internal lane: reads codes from Mailslurper). */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const recoveryScenarios = defineScenarioSuite({
  name: "recovery",
  defaultLanes: ["internal"],
  scenarios: [
  defineScenario({
    id: "password-reset-via-email",
    description: "Password reset: click reset, get code from email, set new password",
    requires: { mfaEnabled: true, hookService: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "reset-email",
      "reset-email-code",
      // A recovery code yields AAL1 only; settings.required_aal is highest_available, so TOTP first.
      "login-totp-verify",
      "reset-password",
      // The settings flow inherits return_to=/ui/login; the session is already AAL2, so login-ui bounces on.
      "manage-details",
    ],
    cleanup: "restore-password",
  }),

  defineScenario({
    id: "password-reset-then-mfa-login",
    description: "Password reset followed by login with new password and MFA",
    requires: { mfaEnabled: true, hookService: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    phases: [
      {
        name: "reset-password",
        expectedPath: [
          "login-email",
          "login-password",
          "reset-email",
          "reset-email-code",
          "login-totp-verify",
          "reset-password",
          "manage-details",
        ],
      },
      {
        name: "login-with-new-password",
        flowParams: { max_age: "0" },
        expectedPath: [
          "login-email",
          "login-password",
          "login-totp-verify",
          "oidc-callback",
        ],
      },
    ],
    cleanup: "restore-password",
  }),

  // Five wrong codes is exactly what `max_submissions` allows (ory/kratos@v25.4.0 driver/config/config.go);
  // the sixth would trip the cap but panics login-ui's BFF (pkg/kratos/service.go:737), so it is not walked.
  // When that is fixed: add the sixth submission and a `reset-email-code → reset-email` terminal.
  // Entered via the recovery deep link: no session or credential changes, so no cleanup.
  defineScenario({
    id: "wrong-codes-rejected-in-place",
    description:
      "Wrong recovery codes are rejected in place on the code step, for the submissions the cap allows",
    requires: { localUsersEnabled: true, mailApi: true },
    user: { ref: "returning-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "reset-email",
      "reset-email-code",
      "reset-email-code",
      "reset-email-code",
      "reset-email-code",
      "reset-email-code",
      "reset-email-code",
    ],
    expectError: true,
  }),
  ],
});
