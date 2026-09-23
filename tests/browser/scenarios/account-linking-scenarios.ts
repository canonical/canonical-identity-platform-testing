// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Login-time (register page → dex collision → password links) and settings-page (Connect/Disconnect) account linking.
 * Every archetype has a matching static-password account in docker/dex/config.yml; internal lane: bootstrap hits kratos's public port and cleanup needs the admin API.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const accountLinkingScenarios = defineScenarioSuite({
  name: "account-linking",
  defaultLanes: ["internal"],
  scenarios: [
    // Password-only archetype on purpose: a TOTP-bearing identity dead-ends behind the BFF
    // (kratos 1010004 → bare BFF 500 → blank UI), which has no walkable expectError shape.
    defineScenario({
      id: "link-at-login",
      description:
        "A dex sign-in for an existing local address collides, links after password auth, and then yields the seeded identity's tokens",
      requires: {
        accountLinkingEnabled: true,
        oidcProviders: ["dex"],
        oidcSequencing: false,
        localUsersEnabled: true,
      },
      user: { ref: "link-user", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "dex collides and the existing password links it",
          expectedPath: [
            "register-email",
            "provider:dex:login",
            "login-password",
            "manage-details",
          ],
        },
        {
          name: "dex sign-in now lands the linked identity",
          freshSession: true,
          expectedPath: ["login-email", "provider:dex:login", "oidc-callback"],
        },
      ],
      postChecks: ["linked-identity-tokens"],
      cleanup: "remove-oidc",
    }),

    defineScenario({
      id: "link-at-login-sequencing",
      description:
        "Under OIDC→WebAuthn sequencing: the dex collision links after password auth, and the post-link dex sign-in enrols a key before yielding the seeded identity's tokens",
      requires: {
        accountLinkingEnabled: true,
        oidcProviders: ["dex"],
        oidcSequencing: true,
        webauthnEnabled: true,
        localUsersEnabled: true,
      },
      user: { ref: "link-user", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "dex collides and the existing password links it",
          expectedPath: [
            "register-email",
            "provider:dex:login",
            "login-password",
            "manage-details",
          ],
        },
        {
          name: "dex sign-in enrols a key, then lands the linked identity",
          freshSession: true,
          expectedPath: ["login-email", "provider:dex:login", "setup-passkey", "oidc-callback"],
        },
      ],
      postChecks: ["linked-identity-tokens"],
      cleanup: ["remove-oidc", "remove-2fa"],
    }),

    defineScenario({
      id: "settings-link-and-unlink",
      description:
        "Connect dex from the connected-accounts page, then disconnect it — both shapes render and the walk restores the seeded identity",
      requires: {
        accountLinkingEnabled: true,
        oidcProviders: ["dex"],
        oidcSequencing: false,
        localUsersEnabled: true,
        mfaEnabled: true,
      },
      user: { ref: "settings-link-user", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        {
          name: "sign in",
          expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
        },
        {
          // No return_to on the Connect settings flow, so completion lands on settings.ui_url (/ui/reset_password).
          name: "connect dex",
          expectedPath: ["manage-details", "connected-accounts", "provider:dex:login", "reset-password"],
        },
        {
          name: "disconnect it",
          expectedPath: ["manage-details", "connected-accounts", "connected-accounts"],
        },
      ],
      cleanup: "remove-oidc",
    }),
  ],
});
