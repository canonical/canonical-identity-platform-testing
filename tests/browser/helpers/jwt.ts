// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * JWT decoding helpers for extracting claims from access and ID tokens.
 *
 * Ported from tenant-service/tests/browser/helpers/jwt.ts.
 * Only decodes the payload (no signature verification) — this is sufficient
 * for E2E tests where we trust the local Hydra instance.
 */

export interface TokenClaims {
  /** All decoded claims from the JWT payload. */
  [key: string]: unknown;
  sub?: string;
  tenant_id?: string;
}

/**
 * Decode a JWT and return the payload as a parsed object.
 * Does NOT verify the signature — suitable for test assertions only.
 */
export function decodeJwtPayload(token: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(`invalid JWT: expected 3 parts, got ${parts.length}`);
  }

  // Base64url → Base64 → Buffer → JSON
  const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(base64, "base64").toString("utf-8");
  return JSON.parse(json) as TokenClaims;
}

/**
 * Read a session claim from a decoded token.
 *
 * Hydra surfaces the extras hook-service attaches (`groups`, `tenant_id`)
 * top-level in the ID token but nested under `ext` in the access token, so both
 * shapes have to be accepted.
 */
export function readClaim(claims: TokenClaims, name: string): unknown {
  if (claims[name] !== undefined) return claims[name];
  const ext = claims.ext;
  if (ext && typeof ext === "object") {
    return (ext as Record<string, unknown>)[name];
  }
  return undefined;
}
