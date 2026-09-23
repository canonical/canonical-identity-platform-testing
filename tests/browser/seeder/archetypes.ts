// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Source of truth for seeding: a scenario referencing a ref not listed here fails the seeder.

export interface UserArchetype {
  ref: string;
  credentials: string[];
  totpConfigured: boolean;
  verified?: boolean;
  /** Burn backup codes down to 4 unused; login-ui only offers regeneration at ≤3 remaining. */
  lowBackupCodes?: boolean;
  /** For `oidc/dex` users: the static account's `userID` in docker/dex/config.yml. */
  dexUserId?: string;
}

export const USER_ARCHETYPES: UserArchetype[] = [
  {
    ref: "first-mfa",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    ref: "returning-mfa",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    ref: "no-mfa",
    credentials: ["password"],
    totpConfigured: false,
  },

  // Needs a profile that deploys Dex (canonical-internal or canonical-portal); skipped elsewhere.
  {
    ref: "dex-user",
    credentials: ["oidc/dex"],
    totpConfigured: false,
    dexUserId: "08a8684b-db88-4b73-90a9-3cd1661f5466",
  },

  {
    ref: "backup-code-user",
    credentials: ["password", "totp", "lookup_secret"],
    totpConfigured: true,
  },
  {
    ref: "backup-code-user-2",
    credentials: ["password", "totp", "lookup_secret"],
    totpConfigured: true,
    lowBackupCodes: true,
  },
  {
    // settings-backup-codes-deactivate: seeded WITHOUT lookup_secret; deactivation consumes codes.
    ref: "backup-code-user-3",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    // backup-code-reuse-rejected: seeded WITHOUT lookup_secret; burning codes must stay isolated.
    ref: "backup-code-user-4",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    // settings-totp-unlink: post-unlink shape (lookup_secret, no totp); seeder enrols TOTP then unlinks it.
    ref: "totp-unlink-user",
    credentials: ["password", "lookup_secret"],
    totpConfigured: false,
  },

  {
    ref: "zero-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    ref: "single-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    ref: "multi-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  // Tenant journeys entered through dex, for oidc-only rows that have no password user.
  {
    ref: "dex-single-tenant-user",
    credentials: ["oidc/dex"],
    totpConfigured: false,
    dexUserId: "3d9e795b-ec99-4c84-a1b0-4dd2661f5469",
  },
  {
    ref: "dex-multi-tenant-user",
    credentials: ["oidc/dex"],
    totpConfigured: false,
    dexUserId: "4eaf795b-ec99-4c84-a1b0-4dd2661f546a",
  },

  // One per WebAuthn scenario: registering a security key permanently raises the identity's AAL.
  {
    ref: "webauthn-new-user",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    ref: "webauthn-new-user-2",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    ref: "webauthn-new-user-3",
    credentials: ["password"],
    totpConfigured: false,
  },
  // Account linking, one per scenario; each has a matching static account in docker/dex/config.yml.
  {
    // Password-only: the login-time link dead-ends for TOTP identities (kratos 1010004, upstreamFindings).
    ref: "link-user",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    ref: "settings-link-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },

  // Only seeded when GOOGLE_TEST_EMAIL and GOOGLE_TEST_SUBJECT_ID are set.
  {
    ref: "google-user",
    credentials: ["oidc/google"],
    totpConfigured: false,
  },

  // Registration scenarios delete and re-create these.
  {
    ref: "new-user-mfa",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    ref: "new-user-no-mfa",
    credentials: ["password"],
    totpConfigured: false,
  },
  {
    // register-without-verification, on rows where verification is off.
    ref: "new-user-no-verification",
    credentials: ["password"],
    totpConfigured: false,
  },

  // One per verification scenario: completing verification permanently marks the identity verified.
  {
    ref: "unverified-user",
    credentials: ["password"],
    totpConfigured: false,
    verified: false,
  },
  {
    ref: "unverified-user-2",
    credentials: ["password"],
    totpConfigured: false,
    verified: false,
  },
  {
    ref: "unverified-user-3",
    credentials: ["password"],
    totpConfigured: false,
    verified: false,
  },
  {
    ref: "unverified-user-4",
    credentials: ["password"],
    totpConfigured: false,
    verified: false,
  },
];
