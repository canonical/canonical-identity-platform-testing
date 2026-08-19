// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OIDC scenario suite — social login flows via Dex.
 *
 * Covers: OIDC login via Dex, OIDC session reuse, OIDC forced re-auth.
 */

import { expect } from "@playwright/test";
import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { readClaim } from "../helpers/jwt";
import { allOf, amrRecords, reauthenticated } from "../framework/claim-assertions";

export const oidcScenarios = defineScenarioSuite({
  name: "oidc",
  defaultLanes: ["live", "internal"],
  scenarios: [
  // ── OIDC login via Dex ─────────────────────────────────────────────────
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

  // ── OIDC session reuse ────────────────────────────────────────────────
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

  // ── OIDC forced re-auth ──────────────────────────────────────────────
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
    // Re-authentication asserted by claim, not by page: max_age makes
    // `auth_time` mandatory, and dex is the only factor on this path (R-22).
    assertions: {
      noTenantId: true,
      custom: allOf(
        reauthenticated(0, 1),
        amrRecords({ mustInclude: ["oidc"] }),
      ),
    },
  }),

  // ── OIDC login without MFA enforcement ───────────────────────────────
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
 * The same four journeys, for deployments where the login-ui runs with OIDC /
 * WebAuthn sequencing enabled (canonical-internal). There, Kratos hands control
 * back to the login-ui for AAL2 before the callback: a user with no security key
 * is sent to the passkey page to enrol one, then back into the login flow to
 * verify with it.
 *
 * `cleanup: "remove-2fa"` strips the key the scenario enrolled. Each test gets a
 * fresh browser context and therefore a fresh virtual authenticator, so a key
 * left behind in Kratos would be unusable by the next test and would hang it at
 * the verification step.
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
            // Enrolling the key completes the ceremony and releases the
            // callback in one step — the ID token comes back with
            // amr ["oidc","webauthn","pop"]. There is no separate verify page.
            "setup-passkey",
            "oidc-callback",
          ],
        },
        { name: "reuse-session", expectedPath: ["oidc-callback"] },
      ],
      assertions: { noTenantId: true },
      cleanup: "remove-2fa",
    }),

    // ── Forced re-auth under OIDC/WebAuthn sequencing ─────────────────────
    //
    // This journey completes: max_age=0 forces a fresh trip through Dex,
    // sequencing then demands the key enrolled in phase 1, and the assertion
    // releases the OIDC callback.
    //
    // It once did NOT complete, and the cause was our own compose config:
    // kratos.yml set serve.public.base_url to http://localhost:4433, Kratos's
    // own published port, and Kratos builds every flow's ui.action from
    // base_url. So every browser-submitted self-service form went straight to
    // Kratos, bypassing Traefik and login-ui's BFF — and the BFF is what
    // redeems the Hydra login challenge (handleUpdateFlow in
    // pkg/kratos/handlers.go). Kratos could not redeem it either: under
    // sequencing the challenge is never attached to a Kratos flow, it rides
    // inside return_to. Nobody accepted, Kratos 303'd back to
    // /ui/login?login_challenge=<same challenge>, and MustReAuthenticate
    // restarted the first factor — forever.
    //
    // Lesson, because this cost a wrongly-drafted upstream bug report: the
    // skip/accept decision spans login-ui, Hydra's login session AND Kratos's
    // flow state. Before calling a loop here a product defect, prove the
    // submission actually reached login-ui's BFF. Kratos's request log records
    // the client address; a browser posting to :4433 rather than the ingress
    // is the tell.
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
            // Enrolling the key completes the ceremony and releases the
            // callback in one step — the ID token comes back with
            // amr ["oidc","webauthn","pop"]. There is no separate verify page.
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
            // The key enrolled in phase 1 lives in this context's virtual
            // authenticator, so this time the flow verifies with it instead of
            // enrolling, and that assertion releases the callback.
            "login-webauthn-verify",
            "oidc-callback",
          ],
        },
      ],
      cleanup: "remove-2fa",
    }),

    // ── WebAuthn ASSERTION (sign-in with an existing key) ─────────────────
    //
    // The only runnable scenario that performs an assertion ceremony rather
    // than an enrolment. Everything else on every profile enrols: portal's
    // webauthn-first-login-setup registers a key and never uses it, the
    // sequencing scenarios above stop at enrolment or at PD-7's wall, PD-4
    // blocks the password-user path, and google-oidc-sequencing (the only other
    // user of login-webauthn-verify → oidc-callback) is permanently blocked on
    // Workspace credentials. So a regression in navigator.credentials.get()
    // handling was invisible to every gate and every matrix row (R-5).
    //
    // Why a fresh session rather than max_age=0: with the phase-1 session
    // intact login-ui legitimately skips straight to the callback (Hydra
    // reports skip:true — measured, see PD-7's contrast note), so the key is
    // never exercised; and max_age=0 is exactly the shape PD-7 blocks on this
    // profile. Clearing cookies leaves the credential in place (it lives on the
    // CDP virtual authenticator, not in the cookie jar) while the platform sees
    // an unauthenticated visitor — first factor via Dex, then sequencing
    // demands the key it already knows about, and the verification releases the
    // callback. PD-7's scope note is explicit that only the forced-re-auth form
    // is broken: "the same max_age=0 re-auth with password + TOTP completes
    // normally", and the challenge with max_age removed is accepted.
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
            // Enrolment completes the ceremony and releases the callback in one
            // step — there is no separate verify page on this path.
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
            // THE point of this scenario: an assertion, not an enrolment. The
            // credential is already in the authenticator, so sequencing asks
            // the user to USE it (navigator.credentials.get) instead of
            // registering another one.
            "login-webauthn-verify",
            "oidc-callback",
          ],
        },
      ],
      // The path proves the verify page appeared; the token proves the ceremony
      // is what satisfied AAL2. `amr` is asserted by membership, not equality:
      // the exact list has only ever been OBSERVED for the enrolment path
      // (["oidc","webauthn","pop"]), and pinning an unobserved list for the
      // assertion path would be a guess.
      // TODO(review): tighten to an exact list after the first green run on a
      // sequencing deployment records it.
      assertions: {
        noTenantId: true,
        custom: async ({ idTokenClaims }) => {
          const amr = readClaim(idTokenClaims, "amr");
          expect(Array.isArray(amr), `id token amr must be an array, got ${JSON.stringify(amr)}`).toBe(true);
          const methods = amr as string[];
          expect(methods, "amr must record the WebAuthn ceremony").toContain("webauthn");
          expect(methods, "amr must record Dex as the first factor").toContain("oidc");
        },
      },
      cleanup: "remove-2fa",
    }),

    // Deliberately the INVERSE of oidc-login-no-mfa-enforcement: under
    // sequencing the platform, not the provider, enforces the second factor.
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
