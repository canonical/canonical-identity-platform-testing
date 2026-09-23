// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Multi-tenancy: zero/single/multi-tenant login and session reuse, entered by password and by dex.
 * Tenant lookup keys on the identifier, so a dex identity sees the selection page before its credential page.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const tenantScenarios = defineScenarioSuite({
  name: "tenant",
  defaultLanes: ["live", "internal"],
  scenarios: [
  defineScenario({
    id: "zero-tenant-login",
    description: "User with no tenants completes login without tenant selection",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: { ref: "zero-tenant-user", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  defineScenario({
    id: "single-tenant-auto-select",
    description: "User with one tenant — auto-selected, no selection screen",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: { ref: "single-tenant-user", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { tenantIdFromSeed: true },
  }),

  defineScenario({
    id: "multi-tenant-selection",
    description: "User with multiple tenants must select one",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: {
      ref: "multi-tenant-user",
      credentials: ["password", "totp"],
      totpConfigured: true,
      selectTenant: "alpha",
    },
    expectedPath: [
      "login-email",
      "tenant-selection",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { tenantIdFromSeed: true },
  }),

  defineScenario({
    id: "multi-tenant-session-reuse",
    description: "Session exists but multi-tenant user must re-select tenant",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: {
      ref: "multi-tenant-user",
      credentials: ["password", "totp"],
      totpConfigured: true,
      selectTenant: "beta",
    },
    phases: [
      {
        name: "establish-session",
        expectedPath: [
          "login-email",
          "tenant-selection",
          "login-password",
          "login-totp-verify",
          "oidc-callback",
        ],
      },
      {
        name: "reuse-session-reselect-tenant",
        flowParams: {},
        expectedPath: [
          "tenant-selection",
          "oidc-callback",
        ],
      },
    ],
    assertions: { tenantIdFromSeed: true },
  }),

  // The dex-entered shapes are what run on oidc-only multi-tenant rows, which have no password user at all.
  defineScenario({
    id: "dex-single-tenant-auto-select",
    description: "Dex-credentialed user with one tenant — auto-selected, no selection screen",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: false },
    user: { ref: "dex-single-tenant-user", credentials: ["oidc/dex"], totpConfigured: false },
    expectedPath: ["login-email", "provider:dex:login", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
  }),

  defineScenario({
    id: "dex-multi-tenant-selection",
    description: "Dex-credentialed user with multiple tenants selects one, then signs in with Dex",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: false },
    user: {
      ref: "dex-multi-tenant-user",
      credentials: ["oidc/dex"],
      totpConfigured: false,
      selectTenant: "beta",
    },
    expectedPath: ["login-email", "tenant-selection", "provider:dex:login", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
  }),

  defineScenario({
    id: "dex-single-tenant-auto-select-sequencing",
    description: "Dex-credentialed single-tenant user under OIDC→WebAuthn sequencing: dex, key enrolment, callback",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
    user: { ref: "dex-single-tenant-user", credentials: ["oidc/dex"], totpConfigured: false },
    expectedPath: ["login-email", "provider:dex:login", "setup-passkey", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
    cleanup: "remove-2fa",
  }),

  defineScenario({
    id: "dex-multi-tenant-selection-sequencing",
    description: "Dex-credentialed multi-tenant user under sequencing: select, dex, key enrolment, callback",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
    user: {
      ref: "dex-multi-tenant-user",
      credentials: ["oidc/dex"],
      totpConfigured: false,
      selectTenant: "beta",
    },
    expectedPath: ["login-email", "tenant-selection", "provider:dex:login", "setup-passkey", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
    cleanup: "remove-2fa",
  }),
  ],
});
