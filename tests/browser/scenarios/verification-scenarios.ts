// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Verification scenario suite — Kratos email verification flows.
 *
 * Covers: verify email after registration, verify email from login prompt,
 * invalid verification code.
 * Uses Mailslurper (via page.context()) to read verification codes from email.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const verificationScenarios = defineScenarioSuite({
  name: "verification",
  defaultLanes: ["internal"],
  scenarios: [
  // ── Verify email after registration ───────────────────────────────────
  defineScenario({
    id: "verify-email-after-registration",
    description: "New user registers, receives verification email, enters code",
    requires: { multiTenancy: false, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user", credentials: ["password"], totpConfigured: false, verified: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
  }),

  // ── Verify email from login prompt ────────────────────────────────────
  defineScenario({
    id: "verify-email-from-login-prompt",
    description: "Unverified user logs in, sees verification prompt, verifies email",
    requires: { multiTenancy: false, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user-2", credentials: ["password"], totpConfigured: false, verified: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
  }),

  // ── Invalid verification code ──────────────────────────────────────────
  defineScenario({
    id: "invalid-verification-code",
    description: "User enters an invalid verification code, sees error",
    requires: { multiTenancy: false, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user", credentials: ["password"], totpConfigured: false, verified: false },
    expectedPath: [
      "verification",
      "verification",  // rejected — stays on the verification page
    ],
    expectError: true,
  }),
  ],
});
