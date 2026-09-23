// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

export interface TokenClaims {
  [key: string]: unknown;
  sub?: string;
  tenant_id?: string;
}

export function decodeJwtPayload(token: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(`invalid JWT: expected 3 parts, got ${parts.length}`);
  }

  const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(base64, "base64").toString("utf-8");
  return JSON.parse(json) as TokenClaims;
}

/** Hydra puts hook-service extras (`groups`, `tenant_id`) top-level in the ID token but under `ext` in the access token. */
export function readClaim(claims: TokenClaims, name: string): unknown {
  if (claims[name] !== undefined) return claims[name];
  const ext = claims.ext;
  if (ext && typeof ext === "object") {
    return (ext as Record<string, unknown>)[name];
  }
  return undefined;
}
