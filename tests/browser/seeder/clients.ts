// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

export const RP_CLIENT_PAYLOAD = {
  client_id: "browser-test-rp",
  client_secret: "browser-test-rp-secret",
  redirect_uris: [
    "http://127.0.0.1:4446/callback",
    "http://localhost:4446/callback",
    "http://127.0.0.1:4447/callback",
    "http://localhost:4447/callback",
  ],
  // RFC 8628 URN is `oauth`, not `oauth2`; Hydra stores a typo silently, dropping the device grant.
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  response_types: ["code", "token", "id_token"],
  scope: "openid profile email offline_access",
  token_endpoint_auth_method: "client_secret_post",
};

export const SVC_CLIENT_PAYLOAD = {
  client_id: "browser-test-svc",
  client_secret: "browser-test-svc-secret",
  grant_types: ["client_credentials"],
  response_types: ["token"],
  scope: "tenant-service",
  token_endpoint_auth_method: "client_secret_basic",
};

/** hook-service requires exactly this scope; Hydra runs `strategies.scope: exact`. */
export const HOOKS_ADMIN_CLIENT_PAYLOAD = {
  client_id: "browser-test-hooks",
  client_secret: "browser-test-hooks-secret",
  grant_types: ["client_credentials"],
  response_types: ["token"],
  scope: "hook-service:admin",
  token_endpoint_auth_method: "client_secret_basic",
};

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
}
