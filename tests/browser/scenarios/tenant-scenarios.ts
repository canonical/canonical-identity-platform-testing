// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Tenant scenario suite — multi-tenancy flows.
 *
 * Covers: zero-tenant, single-tenant (auto-selected), multi-tenant
 * (manual selection), and multi-tenant session reuse.
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
  ],
});
