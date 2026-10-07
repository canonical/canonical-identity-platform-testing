// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Weird-user-behaviour interventions (refresh, double-click, callback replay, history) on the password+TOTP walk; internal lane until they have gate history. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const resilienceScenarios = defineScenarioSuite({
  name: "resilience",
  defaultLanes: ["internal"],
  scenarios: [
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

    // Browser half: the CLI consumer's state guard rejects the replay; post check: token-endpoint replay revokes the family (RFC 6749 §10.5).
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

    // router.replace leaves no history entry with the login_challenge; Back replays Hydra's consent-verifier hop → access_denied.
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

    // The SPA starts a new login for the same login_challenge (login-ui#986), so the redone walk
    // still returns to the RP.
    defineScenario({
      id: "back-on-second-factor-keeps-oidc-login",
      description: "Browser Back on the second-factor page restarts the login for the same RP request; signing in again completes it",
      requires: { mfaEnabled: true, localUsersEnabled: true },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: [
        "login-email",
        "login-password",
        "login-totp-verify",
        "login-email",
        "login-password",
        "login-totp-verify",
        "oidc-callback",
      ],
    }),

    // The same for a user who picks a tenant: the password page is then reached from the tenant
    // selection, and the tenant picked for this login_challenge is kept.
    defineScenario({
      id: "back-on-second-factor-after-tenant-selection-keeps-oidc-login",
      description: "Browser Back on the second-factor page after a tenant selection restarts the login for the same RP request",
      requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
      user: { ref: "multi-tenant-user", credentials: ["password", "totp"], totpConfigured: true, selectTenant: "alpha" },
      expectedPath: [
        "login-email",
        "tenant-selection",
        "login-password",
        "login-totp-verify",
        "login-email",
        "login-password",
        "login-totp-verify",
        "oidc-callback",
      ],
      assertions: { tenantIdFromSeed: true },
    }),

    // Kratos refuses the submit because the session already satisfies the flow; login-ui answers
    // session_already_available and the SPA goes to the settings hub (login-ui#987). Only where
    // Kratos is not given the login_challenge: with it the flow is a refresh and Kratos takes the code.
    defineScenario({
      id: "stale-second-factor-submit-leads-to-settings",
      description: "A code submitted on the second-factor page of a login that already completed leads to the settings hub, not to an error",
      requires: { mfaEnabled: true, localUsersEnabled: true, kratosLoginChallenge: false },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: [
        "login-email",
        "login-password",
        "login-totp-verify",
        "oidc-callback",
        "login-totp-verify",
        "manage-details",
      ],
    }),

    // The TOTP ⇄ backup-code switch is the app's only push-based history pair, so only here do Back and Forward both land on a live form.
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
