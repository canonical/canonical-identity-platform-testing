// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Kratos email verification: after registration, from the login prompt, invalid code, resend (internal lane: reads codes from Mailslurper). */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const verificationScenarios = defineScenarioSuite({
  name: "verification",
  defaultLanes: ["internal"],
  scenarios: [
  // Pinned on the three walks that verify: after the code is taken, the page asks the BFF for a
  // settings flow and is answered 500 (measured 2026-10-09 on login-ui v0.28.0); the walk goes on.
  defineScenario({
    id: "verify-email-after-registration",
    description: "New user registers, receives verification email, enters code",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
    pinnedServerError: "/self-service/settings/browser",
  }),

  defineScenario({
    id: "verify-email-from-login-prompt",
    description: "Unverified user logs in, sees verification prompt, verifies email",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user-2", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
    pinnedServerError: "/self-service/settings/browser",
  }),

  defineScenario({
    id: "invalid-verification-code",
    description: "User enters an invalid verification code, sees error",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "verification",
      "verification",
    ],
    expectError: true,
  }),
  // Pins the real behaviour: immediate resend succeeds (button re-enables after 90ms, no server limit); the primitive fails loudly when upstream fixes that.
  defineScenario({
    id: "verification-resend-newest-code",
    description:
      "Resend during the cooldown restarts the countdown, mails a fresh code, and that code verifies",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user-3", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
    interventions: [{ at: "verification", do: "resend-code" }],
    pinnedServerError: "/self-service/settings/browser",
  }),
  // kratos replaces the flow's code on resend, so the original code must be rejected visibly.
  defineScenario({
    id: "verification-resend-invalidates-prior-code",
    description:
      "After a resend, the original verification code is rejected visibly",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user-4", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "verification",
      "verification",
    ],
    expectError: true,
    verificationCodeSubmission: "stale-after-resend",
  }),
  ],
});
