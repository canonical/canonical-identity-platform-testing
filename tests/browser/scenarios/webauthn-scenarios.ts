// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Security-key enrolment and sign-in without OIDC sequencing: login-ui's MFA gate is TOTP-only, so a key is an
 * additional factor enrolled from the self-service page. Each scenario owns its identity: enrolling a key permanently raises the AAL.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { amrRecords, reauthenticated } from "../framework/claim-assertions";

export const webauthnScenarios = defineScenarioSuite({
  name: "webauthn",
  defaultLanes: ["live", "internal"],
  scenarios: [
    defineScenario({
      id: "webauthn-first-login-setup",
      description:
        "First login enrols the mandatory TOTP factor, then registers a virtual security key from the self-service passkey page",
      requires: { webauthnEnabled: true, mfaEnabled: true },
      user: { ref: "webauthn-new-user", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "first-login",
          expectedPath: [
            "login-email",
            "login-password",
            "setup-secure",
            "setup-complete",
            "oidc-callback",
          ],
        },
        {
          name: "enrol-security-key",
          expectedPath: ["setup-passkey", "setup-complete"],
        },
      ],
      cleanup: "remove-2fa",
    }),

    defineScenario({
      id: "webauthn-returning-login",
      description:
        "A returning user who has enrolled a security key is still challenged for the authenticator code — login-ui's MFA gate only recognises TOTP",
      requires: { webauthnEnabled: true, mfaEnabled: true },
      user: { ref: "webauthn-new-user-2", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "first-login",
          expectedPath: [
            "login-email",
            "login-password",
            "setup-secure",
            "setup-complete",
            "oidc-callback",
          ],
        },
        {
          name: "enrol-security-key",
          expectedPath: ["setup-passkey", "setup-complete"],
        },
        {
          // Real product limitation: the MFA gate checks only for a `totp` credential; if that changes, expect "login-webauthn-verify".
          name: "sign-in-after-enrolment",
          flowParams: { max_age: "0" },
          expectedPath: [
            "login-email",
            "login-password",
            "login-totp-verify",
            "oidc-callback",
          ],
        },
      ],
      // `amr` pins which factor the platform used; max_age makes `auth_time` mandatory, so the re-challenge is asserted too.
      assertions: {
        claims: [
          reauthenticated(0, 2),
          amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] }),
        ],
      },
      cleanup: "remove-2fa",
    }),
    // Key-only shape is built by dropping the totp credential out-of-band (enrolment ordering forces TOTP first);
    // not even a signed key satisfies the TOTP-only gate, so re-enrolment is forced mid-login.
    defineScenario({
      id: "webauthn-key-only-forces-totp-enrolment",
      description:
        "A key-only identity is challenged for the key from the password step; the signed key is accepted and TOTP re-enrolment is still forced",
      requires: { webauthnEnabled: true, mfaEnabled: true },
      // drop-totp-out-of-band is an admin-API perturbation: internal only.
      lanes: ["internal"],
      user: { ref: "webauthn-new-user-3", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "first-login",
          expectedPath: [
            "login-email",
            "login-password",
            "setup-secure",
            "setup-complete",
            "oidc-callback",
          ],
        },
        {
          name: "enrol-security-key",
          expectedPath: ["setup-passkey", "setup-complete"],
        },
        {
          name: "key-only sign-in — key accepted, TOTP enrolment forced",
          freshSession: true,
          expectedPath: [
            "login-email",
            "login-password",
            "login-webauthn-verify",
            "setup-secure",
            "setup-complete",
            "oidc-callback",
          ],
          interventions: [{ at: "login-email", do: "drop-totp-out-of-band" }],
        },
      ],
      assertions: {
        claims: [amrRecords({ mustInclude: ["webauthn"] })],
      },
      cleanup: "remove-2fa",
    }),
  ],
});
