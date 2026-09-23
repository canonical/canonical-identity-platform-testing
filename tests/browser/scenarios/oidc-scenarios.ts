// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Dex social login: login, session reuse, forced re-auth, no MFA enforcement; plus the same journeys under OIDC→WebAuthn sequencing. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { amrRecords, reauthenticated } from "../framework/claim-assertions";

export const oidcScenarios = defineScenarioSuite({
  name: "oidc",
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "oidc-dex-login",
    description: "Social login via Dex OIDC provider",
    requires: { oidcProviders: ["dex"], oidcEnabled: true },
    user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "provider:dex:login",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "oidc-session-reuse",
    description: "Second OIDC login reuses existing Kratos session",
    requires: { oidcProviders: ["dex"], oidcEnabled: true },
    user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "provider:dex:login",
          "oidc-callback",
        ],
      },
      {
        name: "reuse-session",
        flowParams: {},
        expectedPath: ["oidc-callback"],
      },
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "oidc-forced-reauth",
    description: "max_age=0 forces full re-authentication after OIDC session",
    requires: { oidcProviders: ["dex"], oidcEnabled: true },
    user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "provider:dex:login",
          "oidc-callback",
        ],
      },
      {
        name: "forced-reauth",
        flowParams: { max_age: "0" },
        expectedPath: [
          "login-email",
          "provider:dex:login",
          "oidc-callback",
        ],
      },
    ],
    // Asserted by claim: max_age makes `auth_time` mandatory, and dex is the only factor on this path.
    assertions: {
      noTenantId: true,
      claims: [
        reauthenticated(0, 1),
        amrRecords({ mustInclude: ["oidc"] }),
      ],
    },
  }),

  defineScenario({
    id: "oidc-login-no-mfa-enforcement",
    description: "OIDC login bypasses MFA when provider doesn't enforce it",
    requires: { oidcProviders: ["dex"], mfaEnabled: true, oidcEnabled: true },
    user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "provider:dex:login",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),
  ],
});

/**
 * Sequencing profiles (canonical-internal): Kratos hands back to login-ui for AAL2 before the callback.
 * `cleanup: "remove-2fa"` is required: a leftover key is unusable by the next context's fresh virtual authenticator and hangs it at verify.
 */
export const oidcSequencingScenarios = defineScenarioSuite({
  name: "oidc-sequencing",
  defaultLanes: ["live", "internal"],
  scenarios: [
    defineScenario({
      id: "oidc-dex-login",
      description: "Social login via Dex, stepped up to a security key",
      requires: { oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
      user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
      expectedPath: [
        "login-email",
        "provider:dex:login",
        "setup-passkey",
        "oidc-callback",
      ],
      assertions: { noTenantId: true },
      cleanup: "remove-2fa",
    }),

    defineScenario({
      id: "oidc-session-reuse",
      description: "Second OIDC login reuses the existing AAL2 Kratos session",
      requires: { oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
      user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
      phases: [
        {
          name: "establish-session",
          expectedPath: [
            "login-email",
            "provider:dex:login",
            // Enrolment completes the ceremony and releases the callback in one step; there is no separate verify page.
            "setup-passkey",
            "oidc-callback",
          ],
        },
        { name: "reuse-session", expectedPath: ["oidc-callback"] },
      ],
      assertions: { noTenantId: true },
      cleanup: "remove-2fa",
    }),

    // A loop back to /ui/login?login_challenge=… means serve.public.base_url bypasses the BFF, not a product defect.
    defineScenario({
      id: "oidc-forced-reauth-demands-security-key",
      description:
        "max_age=0 forces a fresh trip through Dex, sequencing demands the enrolled security key, and the assertion releases the OIDC callback",
      requires: { oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
      user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
      phases: [
        {
          name: "establish-session",
          expectedPath: [
            "login-email",
            "provider:dex:login",
            "setup-passkey",
            "oidc-callback",
          ],
        },
        {
          name: "forced-reauth-demands-security-key",
          flowParams: { max_age: "0" },
          expectedPath: [
            "login-email",
            "provider:dex:login",
            "login-webauthn-verify",
            "oidc-callback",
          ],
        },
      ],
      cleanup: "remove-2fa",
    }),

    // Clearing cookies leaves the credential in place: it lives on the CDP virtual authenticator, not in the cookie jar.
    defineScenario({
      id: "oidc-webauthn-assertion",
      description:
        "A security key enrolled under OIDC sequencing satisfies a later sign-in from a clean session — the assertion ceremony releases the OIDC callback",
      requires: { oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
      user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
      phases: [
        {
          name: "enrol-security-key",
          expectedPath: [
            "login-email",
            "provider:dex:login",
            "setup-passkey",
            "oidc-callback",
          ],
        },
        {
          name: "sign-in-with-the-existing-key",
          freshSession: true,
          expectedPath: [
            "login-email",
            "provider:dex:login",
            "login-webauthn-verify",
            "oidc-callback",
          ],
        },
      ],
      // Membership, not equality: the exact amr list on the assertion path is unobserved.
      assertions: {
        noTenantId: true,
        claims: [amrRecords({ mustInclude: ["oidc", "webauthn"] })],
      },
      cleanup: "remove-2fa",
    }),

    defineScenario({
      id: "oidc-login-mfa-enforcement",
      description:
        "OIDC login is forced through a WebAuthn second factor even though the provider does not enforce MFA",
      requires: { oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
      user: { ref: "dex-user", credentials: ["oidc/dex"], totpConfigured: false },
      expectedPath: [
        "login-email",
        "provider:dex:login",
        "setup-passkey",
        "oidc-callback",
      ],
      assertions: { noTenantId: true },
      cleanup: "remove-2fa",
    }),
  ],
});
