// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Recovery scenario suite — account recovery flows.
 *
 * Covers: password reset via email code, password reset followed by MFA login.
 * Uses Mailslurper (via page.context()) to read recovery codes from email.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const recoveryScenarios = defineScenarioSuite({
  name: "recovery",
  defaultLanes: ["internal"],
  scenarios: [
  // ── Password reset via email ──────────────────────────────────────────
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
      // A recovery code only yields an AAL1 session, and settings.required_aal
      // is highest_available, so a 2FA identity must clear TOTP before Kratos
      // will serve the settings (reset password) page.
      "login-totp-verify",
      "reset-password",
      // The settings flow inherits return_to=/ui/login; the session is already
      // AAL2, so login-ui bounces on to the self-serve account page.
      "manage-details",
    ],
    cleanup: "restore-password",
  }),

  // ── Password reset then MFA login ─────────────────────────────────────
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

  // ── Wrong recovery codes are rejected in place, WITHIN the submission cap ──
  // The cap exists and is enforced: `max_submissions` (default 5) is present at
  // `ory/kratos@v25.4.0` in driver/config/config.go, embedx/config.schema.json and
  // persistence/sql/persister_code.go; `useOneTimeCode` increments `submit_count`
  // on the flow row and returns ErrCodeSubmittedTooOften once it exceeds the cap.
  // Measured against Kratos directly: submissions 1-5 return 200 with message
  // 4060006, submission 6 returns 303 and the flow is invalidated.
  //
  // So this pins only what it can honestly observe through the UI: wrong codes
  // are rejected in place, on the same step, for the submissions the cap allows.
  // Five wrong codes prove in-place rejection and NOTHING about the cap — five
  // is exactly what the default permits, so only a sixth submission would see it.
  // That cap-trip is NOT covered here, because driving it through login-ui
  // panics the BFF — `Service.UpdateRecoveryFlow` dereferences a nil `resp` at
  // pkg/kratos/service.go:737 on that path. When that is fixed this scenario
  // should grow a sixth submission and a terminal hop.
  //
  // Deliberately entered via the recovery deep link (`start → reset-email`)
  // rather than through a login: no session is created and no credential is
  // changed, so this scenario needs no cleanup and cannot disturb the shared
  // identity other scenarios reuse.
  defineScenario({
    id: "wrong-codes-rejected-in-place",
    description:
      "Wrong recovery codes are rejected in place on the code step, for the submissions the cap allows",
    requires: { localUsersEnabled: true, mailApi: true },
    // Only a password identity is needed: the walk submits wrong codes and
    // never reaches the AAL2 gate, so demanding a TOTP secret here would make
    // the scenario unrunnable on MFA-off profiles for no reason.
    user: { ref: "returning-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "reset-email",
      "reset-email-code",
      "reset-email-code", // wrong code 1
      "reset-email-code", // 2
      "reset-email-code", // 3
      "reset-email-code", // 4
      "reset-email-code", // 5 — the last submission the default cap (5) allows
    ],
    expectError: true,
  }),
  ],
});
