// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Registration scenario suite — new user registration flows.
 *
 * Covers: registration with MFA enabled, registration without MFA.
 * Uses the registration flow entry point (not OIDC consumer redirect).
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const registrationScenarios = defineScenarioSuite({
  name: "registration",
  defaultLanes: ["internal"],
  scenarios: [
  // ── Registration ───────────────────────────────────────────────────────
  // There is no MFA-enrolment step in registration: kratos.yml declares no
  // `session` after-hook for the registration flow, so no session is issued and
  // a settings/TOTP flow is impossible. /ui/register_secure and
  // /ui/register_complete are orphan static mocks that nothing navigates to.
  // Verification is always appended when it is enabled, and RegisterPassword.tsx
  // follows continue_with[show_verification_ui] first — so every registration
  // ends on the verification page regardless of the profile's MFA setting.
  defineScenario({
    id: "register-with-mfa",
    description:
      "Registration on an MFA-enforcing profile — email, password, then hand-off to email verification",
    requires: { mfaEnabled: true, multiTenancy: false, hookService: true, registrationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "new-user-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "register-email",
      "register-password",
      "verification",
    ],
  }),

  defineScenario({
    id: "register-without-mfa",
    description:
      "Registration without MFA enforcement — email, password, then hand-off to email verification",
    requires: { multiTenancy: false, registrationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "new-user-no-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "register-email",
      "register-password",
      "verification",
    ],
  }),
  ],
});
