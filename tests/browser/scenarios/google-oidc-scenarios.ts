// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Google social login: first login with TOTP, session reuse, and OIDC→WebAuthn sequencing.
 * The Google account is real (GOOGLE_TEST_* env vars); the google-user archetype carries its `sub` claim.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const googleOidcScenarios = defineScenarioSuite({
  name: "google-oidc",
  // The journeys use public surfaces only; the google-user identity is seeded once, out of band.
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "google-oidc-first-login",
    description: "Google OIDC login (first time, identity created in Kratos, includes TOTP 2FA)",
    requires: { oidcProviders: ["google"], oidcEnabled: true },
    user: { ref: "google-user", credentials: ["oidc/google"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "provider:google:login",
      "provider:google:password",
      "provider:google:totp",
      "provider:google:confirm-identity",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "google-oidc-session-reuse",
    description: "Second Google login reuses existing Kratos session",
    requires: { oidcProviders: ["google"], oidcEnabled: true },
    user: { ref: "google-user", credentials: ["oidc/google"], totpConfigured: false },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "provider:google:login",
          "provider:google:password",
          "provider:google:totp",
          "provider:google:confirm-identity",
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
    id: "google-oidc-sequencing",
    description: "Google login with OIDC sequencing — register webauthn key on first login, verify with key on returning login",
    requires: { oidcProviders: ["google"], oidcSequencing: true, webauthnEnabled: true, oidcEnabled: true },
    user: { ref: "google-user", credentials: ["oidc/google"], totpConfigured: false },
    phases: [
      {
        name: "register-key",
        expectedPath: [
          "login-email",
          "provider:google:login",
          "provider:google:password",
          "provider:google:totp",
          "provider:google:confirm-identity",
          "setup-passkey",
          "oidc-callback",
        ],
      },
      {
        name: "authenticate-with-key",
        flowParams: { max_age: "0" },
        // Google's session persists from phase 1: no password/TOTP pages, and the accounts.google.com hop is too brief to be a state.
        expectedPath: [
          "login-email",
          "login-webauthn-verify",
          "oidc-callback",
        ],
      },
    ],
    assertions: { noTenantId: true },
    // A leftover key would turn the next first-login into a verify step instead of setup-passkey.
    cleanup: "remove-2fa",
  }),
  ],
});
