// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Tenant scenario suite — multi-tenancy flows.
 *
 * Covers: zero-tenant, single-tenant (auto-selected), multi-tenant
 * (manual selection), and multi-tenant session reuse — entered with a
 * password, and entered through dex (§10 item 1: the oidc-only rows have no
 * password user at all, so without the dex-entered pair no tenant journey
 * runs there). Tenant lookup keys on the identifier, so the dex identity
 * sees the same selection page BEFORE its credential page (observed
 * 2026-09-02, canonical-portal).
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const tenantScenarios = defineScenarioSuite({
  name: "tenant",
  defaultLanes: ["live", "internal"],
  scenarios: [
  // ── Zero-tenant user ──────────────────────────────────────────────────
  defineScenario({
    id: "zero-tenant-login",
    description: "User with no tenants completes login without tenant selection",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: { ref: "zero-tenant-user", credentials: ["password", "totp"], totpConfigured: true, tenantCount: 0 },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  // ── Single-tenant user (auto-selected) ────────────────────────────────
  defineScenario({
    id: "single-tenant-auto-select",
    description: "User with one tenant — auto-selected, no selection screen",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: { ref: "single-tenant-user", credentials: ["password", "totp"], totpConfigured: true, tenantCount: 1 },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { tenantIdFromSeed: true },
  }),

  // ── Multi-tenant user (manual selection) ──────────────────────────────
  defineScenario({
    id: "multi-tenant-selection",
    description: "User with multiple tenants must select one",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: {
      ref: "multi-tenant-user",
      credentials: ["password", "totp"],
      totpConfigured: true,
      tenantCount: "many",
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

  // ── Multi-tenant session reuse ────────────────────────────────────────
  defineScenario({
    id: "multi-tenant-session-reuse",
    description: "Session exists but multi-tenant user must re-select tenant",
    requires: { mfaEnabled: true, multiTenancy: true, localUsersEnabled: true },
    user: {
      ref: "multi-tenant-user",
      credentials: ["password", "totp"],
      totpConfigured: true,
      tenantCount: "many",
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

  // ── Dex-entered tenant journeys ───────────────────────────────────────
  // Same shapes as above, no password anywhere: these are what run on the
  // oidc-only multi-tenant rows. Sequencing rows fork the post-dex step into
  // the passkey enrolment (the variants below).
  defineScenario({
    id: "dex-single-tenant-auto-select",
    description: "Dex-credentialed user with one tenant — auto-selected, no selection screen",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: false },
    user: { ref: "dex-single-tenant-user", credentials: ["oidc/dex"], totpConfigured: false, tenantCount: 1 },
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
      tenantCount: "many",
      selectTenant: "beta",
    },
    expectedPath: ["login-email", "tenant-selection", "provider:dex:login", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
  }),

  defineScenario({
    id: "dex-single-tenant-auto-select-sequencing",
    description: "Dex-credentialed single-tenant user under OIDC→WebAuthn sequencing: dex, key enrolment, callback",
    requires: { multiTenancy: true, oidcProviders: ["dex"], oidcEnabled: true, oidcSequencing: true, webauthnEnabled: true },
    user: { ref: "dex-single-tenant-user", credentials: ["oidc/dex"], totpConfigured: false, tenantCount: 1 },
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
      tenantCount: "many",
      selectTenant: "beta",
    },
    expectedPath: ["login-email", "tenant-selection", "provider:dex:login", "setup-passkey", "oidc-callback"],
    assertions: { tenantIdFromSeed: true },
    cleanup: "remove-2fa",
  }),
  ],
});
