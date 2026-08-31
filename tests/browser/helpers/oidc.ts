// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OIDC authorization-code flow helpers.
 *
 * Ported from tenant-service/tests/browser/helpers/oidc.ts.
 * The dev stack runs the Hydra exemplary OAuth 2.0 consumer on :4446.
 * These helpers drive the browser through the full OAuth2 flow.
 */
import { Page, expect } from "@playwright/test";
import { buildAuthorizeUrl } from "./hydra";
import { decodeJwtPayload, TokenClaims } from "./jwt";
import { HYDRA_PUBLIC_URL, OIDC_CONSUMER_URL } from "./config";
import type { Manifest, ManifestOauthClientRp } from "../seeder/manifest-schema";
import { getRpClient as getManifestRpClient, readManifest } from "../framework/manifest";

const CALLBACK_URL = `${OIDC_CONSUMER_URL}/callback`;

/**
 * Get the RP (authorization code) client credentials from the manifest.
 * Returns undefined if the manifest doesn't contain client data.
 */
export function getRpClient(manifest: Manifest): ManifestOauthClientRp | undefined {
  return getManifestRpClient(manifest);
}

/**
 * Tokens extracted from the OIDC callback page.
 */
export interface OIDCTokens {
  accessToken: string;
  idToken: string;
  /** Present when the client requested offline_access (the seeded RP does).
   *  Captured so post checks can prove family revocation after a code replay. */
  refreshToken?: string;
  /** null when the deployment mints opaque access tokens (access_token_format=opaque). */
  accessTokenClaims: TokenClaims | null;
  idTokenClaims: TokenClaims;
}

/**
 * Start a new authorization-code flow from the OIDC consumer app.
 * Strips any default max_age injected by the OIDC consumer so the
 * flow behaves as a normal first-login (no forced re-auth).
 * After this call the browser is on the Kratos login page.
 */
export async function startOIDCFlow(page: Page): Promise<void> {
  const url = await buildAuthorizeUrl(page, {});
  await page.goto(url);
  await waitForOidcEntryState(page);
}

/**
 * Start a new authorization-code flow with additional OIDC parameters.
 *
 * @param page — Playwright Page object
 * @param params — Additional query parameters (e.g., { max_age: "0" } for forced re-auth)
 */
export async function startOIDCFlowWithParams(
  page: Page,
  params: Record<string, string>,
): Promise<void> {
  const url = await buildAuthorizeUrl(page, params);
  await page.goto(url);
  await waitForOidcEntryState(page);
}

/**
 * Wait for any valid first state after starting an OIDC flow.
 * Depending on session state, Hydra/Kratos can land on:
 * - login page (/ui/login)
 * - consent page (/ui/consent)
 * - callback page (/callback)
 */
async function waitForOidcEntryState(page: Page): Promise<void> {
  await expect(async () => {
    const url = page.url();
    const isLogin = url.includes("/ui/login");
    const isConsent = url.includes("/ui/consent");
    const isCallback = url.includes("/callback?");

    expect(isLogin || isConsent || isCallback).toBe(true);
  }).toPass({ timeout: 15_000 });

  // Do not assert login-page content here: the flow may briefly pass through
  // /ui/login and auto-redirect immediately (session reuse path).
}

/**
 * Assert the OIDC flow completed by checking the callback page shows tokens.
 * Returns the decoded tokens for further assertions (e.g. tenant_id claims).
 */
export async function expectOIDCFlowComplete(
  page: Page,
): Promise<OIDCTokens> {
  await page.waitForURL(CALLBACK_URL + "?*", { timeout: 30_000 });
  const body = await page.content();
  expect(body).toContain("Access Token");

  return extractTokensFromCallback(page);
}

/**
 * Extract access token and ID token from the Hydra OIDC consumer callback page.
 *
 * The page renders tokens as:
 *   <li>Access Token: <code>eyJ...</code></li>
 *   <li>ID Token: <code>eyJ...</code></li>
 *
 * The ID token is ALWAYS a JWT (OIDC spec). The access token's shape is a
 * deployment dimension: hydra mints JWTs only when jwt_access_tokens is on;
 * opaque rows produce `ory_at_…` strings (2 dot-parts) that must not be
 * decoded. Claims are null for opaque tokens — assertions that need
 * access-token claims must gate on the declared access_token_format.
 */
async function extractTokensFromCallback(page: Page): Promise<OIDCTokens> {
  const items = page.locator("li");
  let accessToken = "";
  let idToken = "";
  let refreshToken = "";

  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const text = await items.nth(i).innerText();
    if (text.startsWith("Access Token:")) {
      accessToken = await items.nth(i).locator("code").innerText();
    } else if (text.startsWith("ID Token:")) {
      idToken = await items.nth(i).locator("code").innerText();
    } else if (text.startsWith("Refresh Token:")) {
      refreshToken = await items.nth(i).locator("code").innerText();
    }
  }

  if (!accessToken) throw new Error("access token not found on callback page");
  if (!idToken) throw new Error("ID token not found on callback page");

  const accessTokenIsJwt = accessToken.split(".").length === 3;
  return {
    accessToken,
    idToken,
    refreshToken: refreshToken || undefined,
    accessTokenClaims: accessTokenIsJwt ? decodeJwtPayload(accessToken) : null,
    idTokenClaims: decodeJwtPayload(idToken),
  };
}
/** RFC 8628 §3.2 device authorization response, as the walk needs it. */
export interface DeviceAuthorization {
  deviceCode: string;
  verificationUriComplete: string;
}

/**
 * Device-grant bootstrap (RFC 8628 §3.1): request a device_code/user_code
 * pair from hydra's public device endpoint, authenticated the way the seeded
 * RP is registered (client_secret_post — hydra rejects basic auth for it).
 * Public surface + manifest only, so it runs on the live lane.
 *
 * Returns hydra's own verification_uri_complete: entering the journey there
 * is exactly what a real device's link/QR does, and hydra redirects it to
 * login-ui's /ui/device_code with the device_challenge attached.
 */
export async function startDeviceAuth(page: Page): Promise<DeviceAuthorization> {
  const rp = getRpClient(readManifest());
  if (!rp) {
    throw new Error("startDeviceAuth: no RP client in the manifest — seed first");
  }
  const res = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/device/auth`, {
    form: {
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
      scope: "openid profile email offline_access",
    },
  });
  const body = await res.text();
  if (!res.ok()) {
    throw new Error(`device authorization failed: HTTP ${res.status()} ${body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(body) as { device_code?: string; verification_uri_complete?: string };
  if (!parsed.device_code || !parsed.verification_uri_complete) {
    throw new Error(`device authorization answered without device_code/verification_uri_complete: ${body.slice(0, 300)}`);
  }
  return { deviceCode: parsed.device_code, verificationUriComplete: parsed.verification_uri_complete };
}

/**
 * Redeem an APPROVED device_code at the token endpoint (RFC 8628 §3.4) — the
 * RP-side half of the grant, which never passes through the browser: device
 * tokens arrive by polling, not via a callback. Called by the runner after
 * the walk observed /ui/device_complete, so the code is approved and a single
 * poll must succeed; authorization_pending here means the approval did not
 * stick and IS the failure.
 */
export async function pollDeviceToken(page: Page, deviceCode: string): Promise<OIDCTokens> {
  const rp = getRpClient(readManifest());
  if (!rp) {
    throw new Error("pollDeviceToken: no RP client in the manifest — seed first");
  }
  const res = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    form: {
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    },
  });
  const body = await res.text();
  if (!res.ok()) {
    throw new Error(`device token poll failed after device_complete: HTTP ${res.status()} ${body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(body) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
  };
  if (!parsed.access_token || !parsed.id_token) {
    throw new Error(`device token poll answered without access_token/id_token: ${body.slice(0, 300)}`);
  }
  const accessTokenIsJwt = parsed.access_token.split(".").length === 3;
  return {
    accessToken: parsed.access_token,
    idToken: parsed.id_token,
    refreshToken: parsed.refresh_token || undefined,
    accessTokenClaims: accessTokenIsJwt ? decodeJwtPayload(parsed.access_token) : null,
    idTokenClaims: decodeJwtPayload(parsed.id_token),
  };
}
