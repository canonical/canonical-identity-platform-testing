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
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
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
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
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
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user", credentials: ["password"], totpConfigured: false, verified: false },
    expectedPath: [
      "verification",
      "verification",  // rejected — stays on the verification page
    ],
    expectError: true,
  }),
  // ── Resend: countdown renders, and the RESENT code is the one that works ─
  // Wave-2 resend-code intervention (docs/testing-spec.md §10 item 11). The
  // primitive clicks "Resend code", requires the cooldown countdown to
  // render, waits for the second mail, and re-anchors ctx.mailCursor so this
  // walk's own code submit can only resolve the RESENT code — the terminal
  // being reached IS the newest-code-wins proof. Pins PD-10's REAL behaviour
  // (immediate resend succeeds because the button re-enables after 90ms and
  // no server limit exists); the primitive fails loudly when the fix lands.
  // NOTE the recovery anchor the wave-2 table proposed (reset-email-code) is
  // REFUTED: the v0.28 recovery code page has no resend control (observed
  // 2026-09-01), so `verification` is the only legal anchor.
  defineScenario({
    id: "verification-resend-newest-code",
    description:
      "Resend during the cooldown restarts the countdown, mails a fresh code, and that code verifies",
    requires: { verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "unverified-user-3", credentials: ["password"], totpConfigured: false, verified: false },
    expectedPath: [
      "verification",
      "login-email",
    ],
    interventions: [{ at: "verification", do: "resend-code" }],
  }),
  ],
});
