// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Manifest schema — shared type definitions for the seed manifest.
 *
 * The manifest is the bridge between the seeder (admin API world) and the
 * test runner (browser-only world). It contains all the data the test runner
 * needs to drive scenarios without any admin API access.
 *
 * This file is imported by both the seeder and the framework to ensure
 * type consistency.
 */

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** A seeded user in the manifest. */
export interface ManifestUser {
  /** Reference name matching scenario user.ref (e.g., "first-mfa"). */
  ref: string;
  /** User email address. */
  email: string;
  /** User password (null for OIDC-only users). */
  password: string | null;
  /** Credential types this user has (e.g., ["password", "totp"], ["oidc/dex"]). */
  credentials: string[];
  /** Whether TOTP is configured for this user. */
  totpConfigured: boolean;
  /** Base32 TOTP secret (null if TOTP not configured). */
  totpSecret: string | null;
  /** Kratos identity ID. */
  identityId: string;
  /** Whether the user's email is verified (default: true). */
  verified: boolean;
  /** Dex login email (for OIDC users). */
  dexEmail?: string;
  /** Dex login password (for OIDC users). */
  dexPassword?: string;
  /** Backup recovery code (if generated during seeding). */
  backupCode?: string;
  /** Tenants this user belongs to (refs from ManifestTenant). */
  tenantRefs?: string[];
  /** hook-service group names this user belongs to, i.e. the `groups` claim
   *  the token hook is expected to put in issued tokens. Only populated on
   *  profiles that deploy hook-service. */
  groups?: string[];
}

/** A seeded tenant in the manifest. */
export interface ManifestTenant {
  /** Reference name (e.g., "alpha", "beta"). */
  ref: string;
  /** Tenant display name. */
  name: string;
  /** Tenant ID (UUID). */
  id: string;
}

/** A seeded hook-service group. */
export interface ManifestGroup {
  /** Reference name (e.g., "platform-testers"). */
  ref: string;
  /** Group name — this is the value that appears in the token's `groups` claim. */
  name: string;
  /** Group ID (UUID) assigned by hook-service. */
  id: string;
  /** Member IDs (emails — hook-service keys group membership on email). */
  members: string[];
}

/** A seeded membership (user ↔ tenant). */
export interface ManifestMembership {
  /** User ref. */
  userRef: string;
  /** Tenant ref. */
  tenantRef: string;
  /** Role within the tenant ("owner" or "member"). */
  role: "owner" | "member";
}

/** OAuth2 client credentials for the RP (authorization code) client. */
export interface ManifestOauthClientRp {
  /** Client ID (e.g., "browser-test-rp"). */
  clientId: string;
  /** Client secret. */
  clientSecret: string;
  /** Redirect URI for the OIDC consumer. */
  redirectUri: string;
}

/** OAuth2 client credentials for the service (client credentials) client. */
export interface ManifestOauthClientSvc {
  /** Client ID (e.g., "browser-test-svc"). */
  clientId: string;
  /** Client secret. */
  clientSecret: string;
}

/** OAuth2 client credentials registered with Hydra. */
export interface ManifestOauthClients {
  /** Authorization-code client used by the OIDC consumer. */
  rp: ManifestOauthClientRp;
  /** Client-credentials client used for tenant-service auth. */
  svc: ManifestOauthClientSvc;
  /** Client-credentials client scoped `hook-service:admin`, used to seed groups. */
  hooks: ManifestOauthClientSvc;
}

/** The complete seed manifest. */
export interface Manifest {
  /** Active profile name when the manifest was created. */
  profile: string;
  /** ISO timestamp of when the manifest was created. */
  seededAt: string;
  /** Seeded users. */
  users: ManifestUser[];
  /** Seeded tenants. */
  tenants: ManifestTenant[];
  /** Seeded memberships. */
  memberships: ManifestMembership[];
  /** Seeded hook-service groups (empty on profiles without hook-service). */
  groups: ManifestGroup[];
  /** OAuth2 client credentials registered with Hydra. */
  oauthClients?: ManifestOauthClients;
}
