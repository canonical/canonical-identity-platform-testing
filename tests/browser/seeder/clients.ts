// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OAuth2 client definitions for the Hydra test clients.
 *
 * These payloads are used by the seeder to upsert Hydra clients via
 * PUT /admin/clients/{id}. The client IDs and secrets are deterministic
 * so that the oidc-consumer compose service can start with known credentials
 * before the seeder runs.
 */

/** Hydra OAuth2 client payload for the OIDC consumer (authorization code). */
export const RP_CLIENT_PAYLOAD = {
  client_id: "browser-test-rp",
  client_secret: "browser-test-rp-secret",
  redirect_uris: [
    "http://127.0.0.1:4446/callback",
    "http://localhost:4446/callback",
    // The charmed matrix lane runs its consumer on 4447 — compose's consumer
    // owns 4446 on this host and both stacks stay up concurrently.
    "http://127.0.0.1:4447/callback",
    "http://localhost:4447/callback",
  ],
  // RFC 8628 grant URN is urn:ietf:params:oauth:grant-type:device_code — "oauth",
  // not "oauth2". Hydra stores unknown grant strings without complaint, so the
  // typo'd form silently left the client WITHOUT the device grant (C-13).
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  response_types: ["code", "token", "id_token"],
  scope: "openid profile email offline_access",
  token_endpoint_auth_method: "client_secret_post",
};

/** Hydra OAuth2 client payload for the service auth (client credentials). */
export const SVC_CLIENT_PAYLOAD = {
  client_id: "browser-test-svc",
  client_secret: "browser-test-svc-secret",
  grant_types: ["client_credentials"],
  response_types: ["token"],
  scope: "tenant-service",
  token_endpoint_auth_method: "client_secret_basic",
};

/**
 * Hydra OAuth2 client payload for hook-service group administration.
 *
 * hook-service protects `/api/v0/authz` with JWT auth and requires the
 * `hook-service:admin` scope (AUTHENTICATION_REQUIRED_SCOPE). Tokens are
 * minted at Hydra's public port; Hydra runs with `strategies.scope: exact`,
 * so the requested scope must equal this one verbatim.
 */
export const HOOKS_ADMIN_CLIENT_PAYLOAD = {
  client_id: "browser-test-hooks",
  client_secret: "browser-test-hooks-secret",
  grant_types: ["client_credentials"],
  response_types: ["token"],
  scope: "hook-service:admin",
  token_endpoint_auth_method: "client_secret_basic",
};

/** Registered client record returned by Hydra after upsert. */
export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
}
