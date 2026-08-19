// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Google OIDC scenario suite — social login flows via Google.
 *
 * Covers: Google OIDC login (first time, with TOTP 2FA),
 * Google OIDC session reuse, Google OIDC with oidc_sequencing.
 *
 * Unlike Dex scenarios, Google scenarios do NOT use a seeded user.
 * The Google test account is a real Google Workspace account whose
 * credentials come from environment variables. The Kratos identity
 * is registered via the admin API in beforeAll (using the Google
 * `sub` claim from GOOGLE_TEST_SUBJECT_ID).
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const googleOidcScenarios = defineScenarioSuite({
  name: "google-oidc",
  defaultLanes: ["internal"],
  scenarios: [
  // ── Google OIDC first login ──────────────────────────────────────────
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

  // ── Google OIDC session reuse ────────────────────────────────────────
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

  // ── Google OIDC with OIDC sequencing (webauthn MFA) ──────────────────
  //
  // When oidc_sequencing=true and webauthn_enabled=true, after the Google
  // OIDC provider returns, Kratos redirects to the login UI for AAL2.
  // If the user has no webauthn key, they must register one (setup-passkey).
  // If the user has a webauthn key, they must verify with it (login-webauthn-verify).
  //
  // Phase 1: First login — Google auth → register webauthn key → verify with key → callback
  // Phase 2: Returning login — Google auth → verify with key → callback
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
          "login-webauthn-verify",
          "oidc-callback",
        ],
      },
      {
        name: "authenticate-with-key",
        flowParams: { max_age: "0" },
        // Google session persists from Phase 1, so Google auto-selects the
        // session and redirects back immediately — no password/TOTP pages.
        // The browser goes: login-ui → Kratos OIDC → Google (auto-session)
        // → Kratos callback → login-ui (webauthn verify for AAL2).
        expectedPath: [
          "login-email",
          "provider:google:login",
          "login-webauthn-verify",
          "oidc-callback",
        ],
      },
    ],
    assertions: { noTenantId: true },
    // TODO: Consider removing the webauthn key via the Kratos admin API
    // instead of the settings page, to avoid navigating away from the
    // current page. For now, cleanup is handled by the seeder
    // (re-seeding deletes all identities).
  }),
  ],
});
