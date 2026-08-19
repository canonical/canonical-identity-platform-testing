// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Login scenario suite — core login flows.
 *
 * Covers: first-time login with MFA, returning login with MFA,
 * login with MFA disabled, and wrong password error path.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const loginScenarios = defineScenarioSuite({
  name: "login",
  defaultLanes: ["live", "internal"],
  scenarios: [
  // ── First-time login with MFA ──────────────────────────────────────────
  defineScenario({
    id: "first-login-mfa",
    description: "First-time login with MFA enabled — user must set up TOTP",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "first-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "login-password",
      "setup-secure",
      "setup-complete",
      "oidc-callback",
    ],
    // first-mfa belongs to no group, so the hook must add nothing. On its own
    // this is trivially true where hook-service is absent; it earns its keep as
    // a PAIR with login-carries-group-claim, which proves in the same run that
    // the hook is live — so together they show enrichment is selective rather
    // than blanket.
    assertions: { noTenantId: true, noGroups: true },
    cleanup: "remove-totp",
  }),

  // ── Group claims in the issued token ──────────────────────────────────
  // The whole point of deploying hook-service: it enriches the token via
  // Hydra's token hook. Without this assertion nothing distinguishes a
  // hook-service deployment from `core` — the browser journey is identical and
  // only the token differs. Skips where hook-service is absent.
  defineScenario({
    id: "login-carries-group-claim",
    description:
      "A user in a hook-service group receives that group in both the access and ID token",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true, hookService: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true, groups: ["platform-testers"] },
  }),

  // ── Returning login with MFA ──────────────────────────────────────────
  defineScenario({
    id: "returning-login-mfa",
    description: "Returning user with TOTP already configured",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  // ── Login with MFA disabled ───────────────────────────────────────────
  defineScenario({
    id: "login-mfa-off",
    description: "Login with MFA disabled — password only, no TOTP",
    requires: { mfaEnabled: false, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "no-mfa", credentials: ["password"], totpConfigured: false },
    expectedPath: [
      "login-email",
      "login-password",
      "oidc-callback",
    ],
    assertions: { noTenantId: true },
  }),

  // ── Expired TOTP code ─────────────────────────────────────────────────
  // Distinct from error-scenarios.ts's `invalid-totp-code`: that one submits a
  // code that was never valid, this one submits a code that WAS valid, three
  // windows ago. The code is computed for a past window (no sleeping), so the
  // rejection is Kratos's skew check rather than a plain mismatch.
  defineScenario({
    id: "expired-totp-code",
    description: "Expired TOTP code shows error, stays on login-totp-verify page",
    requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
    user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
    expectedPath: [
      "login-email",
      "login-password",
      "login-totp-verify",
      "login-totp-verify",  // rejected — stays on the verify page
    ],
    totpCodeWindow: "expired",
    expectError: true,
  }),
  ],
});
