// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Resilience scenarios — weird-user-behavior coverage over the standard
 * password+TOTP login walk, declared as interventions on scenarios
 * (docs/testing-spec.md §10 item 11).
 *
 * Every flow page persists `?flow=` into the URL via router.replace and
 * re-hydrates from it, so refresh/replay behavior is a designed contract of
 * the login-ui — these scenarios are what pin it. The OAuth-side behaviors
 * (code single-use, verifier replay) are RFC-mandated; their terminals were
 * pinned against the deployed canonical forks, not assumed from upstream.
 *
 * Lanes: internal only for now — the perturbations are safe in principle
 * against a live deployment (they only ever break their own flow), but they
 * are new; widen to live once they have gate history.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const resilienceScenarios = defineScenarioSuite({
  name: "resilience",
  defaultLanes: ["internal"],
  scenarios: [
    // ── Refresh (F5) at every interactive login step ──────────────────────
    // The single most common user recovery action. Each reload must re-hydrate
    // the SAME state from the ?flow= id (login-ui persists it via
    // router.replace precisely so this works), and the walk must then complete
    // normally — proving the re-hydrated form is live, not a dead render.
    defineScenario({
      id: "refresh-survives-login-walk",
      description: "F5 at every login step re-hydrates the same state and the walk still completes",
      requires: { mfaEnabled: true, localUsersEnabled: true },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      interventions: [
        { at: "login-email", do: "reload" },
        { at: "login-password", do: "reload" },
        { at: "login-totp-verify", do: "reload" },
      ],
      assertions: { noTenantId: true },
    }),

    // ── Double-click on submit ────────────────────────────────────────────
    // The UI guard (Flow.tsx drops re-entrant submits while isLoading) has
    // never been provoked. The contract is user-visible: a double click must
    // never derail the journey — the walk's next state assertion is the judge.
    // Password and TOTP are the two submits with side effects (session
    // issuance, code consumption).
    defineScenario({
      id: "double-click-submit",
      description: "Double-clicking Sign in on the password and TOTP steps never derails the walk",
      requires: { mfaEnabled: true, localUsersEnabled: true },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      interventions: [
        { on: "login-password → login-totp-verify", do: "double-submit" },
        { on: "login-totp-verify → oidc-callback", do: "double-submit" },
      ],
      assertions: { noTenantId: true },
    }),

    // ── Authorization-code replay at the RP callback ──────────────────────
    // F5/back on /callback?code=… re-sends the callback. Two layers answer,
    // and this scenario pins both (observed on the deployed forks):
    //  - browser half: the CLI consumer's own state guard rejects the replay
    //    ("States do not match") BEFORE re-exchanging the code — the user sees
    //    the consumer's error page, never a silent success;
    //  - API half (post check): replaying the code at the token endpoint is
    //    where RFC 6749 §10.5 lives — invalid_grant, and the refresh token
    //    from the legitimate exchange is revoked with it (family revocation).
    defineScenario({
      id: "callback-replay-rejected",
      description: "Replaying the RP callback is rejected at both layers and revokes the token family",
      requires: { mfaEnabled: true, localUsersEnabled: true },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      interventions: [
        { at: "oidc-callback", do: "replay-current-url", expect: "oidc-callback-error" },
      ],
      postChecks: ["code-replay-revokes-family"],
    }),

    // ── Back-button after completing auth ─────────────────────────────────
    // The login-ui persists flow state via router.replace, so NO history entry
    // carries the login_challenge — browser-back can never reach the login
    // form with a used challenge in this UI. The nearest surviving entry is
    // Hydra's consent-verifier hop: one Back replays it, Hydra rejects the
    // reuse, and the RP shows an explicit access_denied ("The consent verifier
    // has already been used") — observed on the deployed fork,
    // confirming the verifier replay guard the upstream evidence predicted.
    // The contract defended: back after auth ends in an explicit, terminal
    // error — never a second issuance, never a silent hang.
    defineScenario({
      id: "back-after-auth-terminal",
      description: "History-back after auth replays the consent-verifier hop and terminates in an explicit RP error",
      requires: { mfaEnabled: true, localUsersEnabled: true },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
      interventions: [
        {
          at: "oidc-callback",
          do: "history-back",
          untilUrl: "error=access_denied",
          expect: "oidc-callback-error",
          expectUrlContains: "error=access_denied",
        },
      ],
    }),

    // ── Browser Back/Forward across the method switch ─────────────────────
    // The TOTP ⇄ backup-code switch is the app's ONLY push-based history pair
    // (everything else is router.replace or a hard navigation, so Back there
    // triggers a server redirect and truncates the forward stack — forward is
    // deterministically reachable exactly here). Contract: real browser Back
    // from the backup-code form returns to TOTP, real Forward returns to the
    // backup-code form, and the form is still LIVE — the walk then completes
    // the backup-code login, which fails if the round-trip left a dead paint.
    defineScenario({
      id: "backup-code-history-roundtrip",
      description: "Browser Back/Forward across the TOTP ⇄ backup-code switch keeps the form live",
      requires: { mfaEnabled: true, hookService: true, localUsersEnabled: true },
      user: { ref: "backup-code-user", credentials: ["password", "totp", "lookup_secret"], totpConfigured: true },
      expectedPath: [
        "login-email",
        "login-password",
        "login-totp-verify",
        "login-backup-code-verify",
        "oidc-callback",
      ],
      interventions: [
        { at: "login-backup-code-verify", do: "history-roundtrip", via: "login-totp-verify" },
      ],
    }),
  ],
});
