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

    // The TOTP ⇄ backup-code switch is the app's only push-based history pair, so Forward is reachable exactly here.
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
