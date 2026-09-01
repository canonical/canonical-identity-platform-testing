// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Registration scenario suite — new user registration flows.
 *
 * Covers: registration with MFA enabled, registration without MFA, and
 * registration on a verification-off deployment (the terminal forks on the
 * verification flag, so the first two REQUIRE verificationEnabled).
 * Uses the registration flow entry point (not OIDC consumer redirect).
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const registrationScenarios = defineScenarioSuite({
  name: "registration",
  defaultLanes: ["internal"],
  scenarios: [
  // ── Registration ───────────────────────────────────────────────────────
  // kratos.yml DOES run the `session` after-hook on registration (mirroring
  // kratos-operator/templates/kratos.yaml.j2), so a session exists when the
  // walk leaves register_password. There is still no MFA-enrolment step in
  // the flow itself; /ui/register_secure and /ui/register_complete are
  // orphan static mocks that nothing navigates to.
  // Verification is always appended when it is ENABLED, and
  // RegisterPassword.tsx follows continue_with[show_verification_ui] first —
  // so on a verification-on profile every registration ends on the
  // verification page regardless of the MFA setting (hence
  // verificationEnabled: true on the two scenarios below; without it a
  // verification-off row would expect a page that cannot render).
  defineScenario({
    id: "register-with-mfa",
    description:
      "Registration on an MFA-enforcing profile — email, password, then hand-off to email verification",
    requires: { mfaEnabled: true, hookService: true, registrationEnabled: true, verificationEnabled: true, localUsersEnabled: true, mailApi: true },
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
    requires: { registrationEnabled: true, verificationEnabled: true, localUsersEnabled: true, mailApi: true },
    user: { ref: "new-user-no-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "register-email",
      "register-password",
      "verification",
    ],
  }),
  // ── Registration with verification OFF ─────────────────────────────────
  // The other side of the terminal fork, observed 2026-09-01 on row
  // mx-l1m0v0wnp0t1h0u1aj (verification=off): kratos answers the password
  // submit with continue_with[redirect_browser_to → /ui/manage_details]
  // (measured on the wire), RegisterPassword.tsx follows that action as its
  // fallback (v0.28.0 RegisterPassword.tsx:85-94), and the session hook's
  // session makes the settings hub the observed terminal (runner-detected).
  // Phase 2 is the point: the account is USABLE without ever verifying the
  // address. mfaEnabled:false keeps phase 2's walk deterministic
  // (password → callback); the mfa-enforced+verification-off shape would
  // fork into forced TOTP enrolment instead.
  defineScenario({
    id: "register-without-verification",
    description:
      "Registration with verification off — no hand-off page, and the unverified account signs in",
    requires: { mfaEnabled: false, registrationEnabled: true, verificationEnabled: false, localUsersEnabled: true },
    user: { ref: "new-user-no-verification", credentials: ["password"], totpConfigured: false },
    phases: [
      {
        name: "register — no verification hand-off",
        expectedPath: ["register-email", "register-password", "manage-details"],
      },
      {
        name: "the unverified account signs in",
        freshSession: true,
        expectedPath: ["login-email", "login-password", "oidc-callback"],
      },
    ],
    // Server-side premise pin: with verification off the created identity's
    // address stays UNVERIFIED — without this, phase 2's "unverified account
    // signs in" could silently become vacuous if kratos ever auto-verified.
    postChecks: ["registered-address-unverified"],
  }),
  ],
});
