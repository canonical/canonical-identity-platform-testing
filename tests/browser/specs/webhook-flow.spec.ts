// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Cross-service webhook flow — browser E2E test.
 *
 * NEW: Tests the cross-service webhook flow that spans hook-service ↔ tenant-service.
 * When a user registers and logs in, hook-service webhooks can trigger group
 * membership assignment in tenant-service.
 *
 * Requires the groups profile (or any profile with hook-service + tenant-service).
 *
 * Prerequisites:
 *   - Full dev stack running (Kratos, Hydra, Traefik, OpenFGA, Postgres)
 *   - identity-platform-login-ui running
 *   - hook-service running on :8080
 *   - tenant-service running on :8081
 *
 * Environment variables:
 *   AUTH_CLIENT_ID      — Hydra client_credentials client_id
 *   AUTH_CLIENT_SECRET  — corresponding client_secret
 */

import { test, expect } from "@playwright/test";
import {
  createIdentity,
  markVerified,
  deleteIdentity,
  deleteIdentitySessions,
} from "../helpers/kratos";
import {
  createTenant,
  deleteTenant,
  getServiceToken,
  provisionUser,
} from "../helpers/tenants";
import { startOIDCFlow, expectOIDCFlowComplete } from "../helpers/oidc";
import { loginWithPassword } from "../helpers/login";
import { completeTotpSetup } from "../helpers/totp";
import { uniqueEmail, uniqueTenantName } from "../helpers/utils";
import { requireProfile, isMultiTenancyEnabled, activeConfig, HOOK_SERVICE_URL } from "../helpers/config";
import { readManifest } from "../framework/manifest";
import { readClaim } from "../helpers/jwt";
import { DEFAULT_TEST_PASSWORD } from "../helpers/test-credentials";

const PASSWORD = DEFAULT_TEST_PASSWORD;

// Skip all tests if hook-service is not in the active profile
test.beforeEach(async () => {
  test.skip(!requireProfile("hook-service"), "hook-service not in active profile");
});

// ---------------------------------------------------------------------------
// Shared state per test
// ---------------------------------------------------------------------------

interface TestState {
  token: string;
  identityIds: string[];
  tenantIds: string[];
}

let state: TestState;

test.beforeEach(async () => {
  const manifest = readManifest();
  const token = await getServiceToken(undefined, undefined, manifest);
  state = { token, identityIds: [], tenantIds: [] };
});

test.afterEach(async () => {
  if (!state) return; // beforeEach may not have run (e.g. skipped or threw before setting state)
  for (const id of state.identityIds) {
    await deleteIdentitySessions(id).catch(() => {});
    await deleteIdentity(id).catch(() => {});
  }
  for (const id of state.tenantIds) {
    await deleteTenant(state.token, id).catch(() => {});
  }
});

async function addIdentity(email: string): Promise<string> {
  const id = await createIdentity({ email, password: PASSWORD });
  state.identityIds.push(id);
  // Admin-created identities are unverified; verification-enabled
  // deployments intercept their first login with the verification page.
  await markVerified(id);
  return id;
}

async function addTenant(name: string): Promise<string> {
  const t = await createTenant(state.token, name);
  state.tenantIds.push(t.id);
  return t.id;
}

// ---------------------------------------------------------------------------
// Webhook registration and login flow
// ---------------------------------------------------------------------------

test.describe("webhook flow", () => {
  test("hook-service health check", async () => {
    // Verify hook-service is reachable
    const res = await fetch(`${HOOK_SERVICE_URL}/api/v0/status`);
    expect(res.ok).toBeTruthy();
  });

  test("registration → webhook → group membership", async ({ page }) => {
    // The body unconditionally creates a tenant and provisions the user into
    // it, so this needs tenant-service, not just hook-service. The file-level
    // gate only covers hook-service, and a profile can deploy hook-service
    // without tenant-service (`canonical-internal` does) — hence this skip.
    test.skip(
      !requireProfile("tenant-service"),
      "tenant-service not in active profile",
    );
    // Service-client auth (tenant/hook admin APIs) is JWKS-based: opaque
    // access tokens (jwt_access_tokens=false) 401 as 'invalid token'
    // (config-model upstreamFindings). The product's
    // MT login path is unaffected; only API provisioning needs JWTs.
    test.skip(
      activeConfig().access_token_format === "opaque",
      "requires jwt access tokens but the active deployment mints opaque ones (service-client auth is JWKS-based)",
    );

    const email = uniqueEmail("webhook");
    await addIdentity(email);

    // Create a tenant and provision the user
    const tenantId = await addTenant(uniqueTenantName("Webhook"));
    await provisionUser(state.token, tenantId, email);

    // Login via OIDC flow — this triggers hook-service webhooks
    await startOIDCFlow(page);
    await loginWithPassword(page, email, PASSWORD);
    await completeTotpSetup(page);

    // The login should complete successfully
    const tokens = await expectOIDCFlowComplete(page);

    // Verify the tenant the user was provisioned into reaches the token.
    //
    // Read via readClaim: hook-service writes extras under `ext` on the access
    // token but at the top level on the ID token. Asserting the exact tenant
    // rather than mere presence — this test provisions exactly one tenant, so
    // "defined" would also pass if the wrong one came back.
    if (requireProfile("tenant-service") && isMultiTenancyEnabled()) {
      // Opaque access tokens (access_token_format=opaque) embed no claims —
      // accessTokenClaims is null and the tenant_id lives only behind
      // introspection (the opaque rows' still-open assertion variant). The
      // ID token is always a JWT, so that side asserts unconditionally.
      if (tokens.accessTokenClaims) {
        expect(readClaim(tokens.accessTokenClaims, "tenant_id"), "access token tenant_id").toBe(tenantId);
      }
      expect(readClaim(tokens.idTokenClaims, "tenant_id"), "id token tenant_id").toBe(tenantId);
    }
  });
});
