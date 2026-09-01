// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * WebAuthn scenario suite — security-key enrolment and second-factor sign-in.
 *
 * canonical-portal does not enable OIDC/WebAuthn sequencing, so login-ui never
 * redirects into /ui/setup_passkey by itself. Its MFA gate is also TOTP-only —
 * it checks for a `totp` credential and nothing else — so every password
 * identity is taken to /ui/setup_secure before anything else becomes
 * reachable. A security key is therefore an ADDITIONAL second factor here,
 * never a replacement for TOTP, and it is enrolled the way a user reaches it:
 * from the self-service security-key page.
 *
 * Each scenario owns its identity. Enrolling a key permanently raises the
 * identity's highest available AAL, so a shared archetype would leave the
 * second scenario's preconditions already consumed by the first.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { allOf, amrRecords, reauthenticated } from "../framework/claim-assertions";

export const webauthnScenarios = defineScenarioSuite({
  name: "webauthn",
  defaultLanes: ["live", "internal"],
  scenarios: [
    // ── Enrol a security key ─────────────────────────────────────────────
    defineScenario({
      id: "webauthn-first-login-setup",
      description:
        "First login enrols the mandatory TOTP factor, then registers a virtual security key from the self-service passkey page",
      requires: { webauthnEnabled: true, mfaEnabled: true },
      user: { ref: "webauthn-new-user", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          // login-ui forces TOTP enrolment before any other page is reachable.
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
          // Self-service navigation, using the session from phase 1.
          name: "enrol-security-key",
          expectedPath: ["setup-passkey", "setup-complete"],
        },
      ],
      cleanup: "remove-2fa",
    }),

    // ── A security key does not replace the authenticator code ───────────
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
          // Documents a real product limitation rather than an aspiration: with
          // both factors enrolled, the deployed login-ui still challenges for
          // TOTP. Its MFA gate checks for a `totp` credential and nothing else,
          // and the redirect into the passkey sign-in only exists behind OIDC
          // sequencing, which this profile does not enable. If that changes,
          // this test fails and the expectation should become
          // "login-webauthn-verify".
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
      // PD-4's thesis as a CLAIM, not a narration: the enrolled security key did
      // not satisfy the gate — TOTP did. `amr` says which factor the platform
      // actually used, so if a release makes the key satisfy AAL2 this fails on
      // the claim as well as on the path. max_age also makes `auth_time`
      // mandatory, so the re-challenge itself is now asserted (R-22).
      assertions: {
        custom: allOf(
          reauthenticated(0, 2),
          amrRecords({ mustInclude: ["totp"], mustExclude: ["webauthn"] }),
        ),
      },
      cleanup: "remove-2fa",
    }),
    // ── The key-only identity: PD-4 walked, and CONFIRMED sharper ────────
    // login-ui#884 (in the v0.28.0 build) made WebAuthn usable as a second
    // factor; what nothing walked until now was the key-ONLY identity,
    // because enrolment ordering forces TOTP first. This scenario builds the
    // real shape — enrol both factors the only way the UI allows, then drop
    // the totp credential out-of-band (the admin-side perturbation class),
    // exactly the identity a user has after unlinking their authenticator
    // while keeping a key.
    //
    // The intended falsifier FAILED to falsify, on both profile shapes
    // (observed 2026-09-01, canonical-internal and canonical-portal
    // identically): the fresh login lands on the KEY challenge straight from
    // the password step (§10 item 12's last cheap edge, now traversed), the
    // signed assertion is ACCEPTED — a session exists — and login-ui then
    // forces TOTP RE-ENROLMENT mid-login before completing to the callback.
    // PD-4 sharpened: not even a signed security key satisfies the TOTP-only
    // gate; the user cannot stay key-only. The walk pins that reality (§11),
    // and `amr` pins the claim half: webauthn IS recorded (the ceremony
    // counted) — when a release lets the key complete without the forced
    // enrolment, the path assertion fails and this scenario flips.
    defineScenario({
      id: "webauthn-key-only-forces-totp-enrolment",
      description:
        "A key-only identity is challenged for the key from the password step; the signed key is accepted and TOTP re-enrolment is still forced",
      requires: { webauthnEnabled: true, mfaEnabled: true },
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
        custom: amrRecords({ mustInclude: ["webauthn"] }),
      },
      cleanup: "remove-2fa",
    }),
  ],
});
