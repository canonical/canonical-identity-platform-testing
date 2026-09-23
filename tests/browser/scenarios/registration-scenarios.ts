// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** New-user registration via the registration entry point (not the OIDC consumer redirect); the terminal forks on the verification flag. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const registrationScenarios = defineScenarioSuite({
  name: "registration",
  defaultLanes: ["internal"],
  scenarios: [
  // On a verification-on profile every registration ends on the verification page regardless of MFA
  // (RegisterPassword.tsx follows continue_with[show_verification_ui] first), hence verificationEnabled: true.
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
  // mfaEnabled: false keeps phase 2 deterministic; mfa-enforced + verification-off would fork into TOTP enrolment.
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
    postChecks: ["registered-address-unverified"],
  }),
  ],
});
