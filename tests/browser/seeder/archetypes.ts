// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * User archetypes — the single authoritative definition of which users the
 * seeder should create, and their properties.
 *
 * This file is the source of truth for seeding. It is intentionally
 * decoupled from scenario definitions: adding a new scenario does NOT
 * automatically seed a new user. If a scenario references a ref not listed
 * here, the seeder will fail with a clear error.
 *
 * Note: the `dex-user` archetype requires a profile that deploys Dex
 * (canonical-internal or canonical-portal). It will be skipped silently
 * in profiles without Dex.
 *
 * To add a new user archetype:
 * 1. Add an entry below with a unique `ref` and the required properties.
 * 2. Run `make seed-test-data` to create the user in Kratos.
 *
 * Properties:
 * - ref:            Unique identifier (also used as the email prefix).
 * - credentials:    Credential types the user will have (drives seeding logic).
 * - totpConfigured: Whether TOTP is pre-configured (false = set up at first login).
 * - verified:       Whether the user's email is verified (default: true).
 * - tenantCount:    For tenant scenarios: 0, 1, or "many".
 * - lowBackupCodes: Burn backup codes down to 4 unused, so a scenario that
 *                   spends one leaves 3 and triggers the regeneration prompt.
 */

export interface UserArchetype {
  ref: string;
  credentials: string[];
  totpConfigured: boolean;
  verified?: boolean;
  tenantCount?: 0 | 1 | "many";
  lowBackupCodes?: boolean;
}

export const USER_ARCHETYPES: UserArchetype[] = [
  // ── Core login users ───────────────────────────────────────────────────
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

  // ── OIDC / Dex user ────────────────────────────────────────────────────
  {
    ref: "dex-user",
    credentials: ["oidc/dex"],
    totpConfigured: false,
  },

  // ── Backup code user ───────────────────────────────────────────────────
  // Note: Kratos only generates backup codes as part of TOTP setup, so this
  // user must have TOTP configured to have lookup_secret credentials.
  {
    ref: "backup-code-user",
    credentials: ["password", "totp", "lookup_secret"],
    totpConfigured: true,
  },
  {
    // Seeded deliberately low: login-ui only offers the regeneration prompt at
    // three or fewer unused codes remaining, so a full set of 12 makes that
    // state unreachable.
    ref: "backup-code-user-2",
    credentials: ["password", "totp", "lookup_secret"],
    totpConfigured: true,
    lowBackupCodes: true,
  },
  {
    // For settings-backup-codes-deactivate: seeded WITHOUT lookup_secret. The
    // scenario creates its own codes from the settings page and deactivates
    // them, so a completed walk leaves the identity exactly as seeded. One
    // archetype per scenario: deactivation consumes the codes another
    // scenario's precondition would need.
    ref: "backup-code-user-3",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    // For backup-code-reuse-rejected: also seeded without lookup_secret; the
    // scenario proves the codes the settings page hands out are single-use,
    // and rotating/burning them must not consume any other scenario's codes.
    ref: "backup-code-user-4",
    credentials: ["password", "totp"],
    totpConfigured: true,
  },
  {
    // The post-unlink product state: backup codes WITHOUT a TOTP credential
    // (login-ui's "Unlink TOTP Authenticator App" removes totp and keeps
    // lookup_secret). The seeder enrols TOTP for the codes, then unlinks it
    // via the admin API. settings-totp-unlink re-enrols and unlinks again, so
    // a completed walk restores this exact shape.
    ref: "totp-unlink-user",
    credentials: ["password", "lookup_secret"],
    totpConfigured: false,
  },

  // ── Multi-tenancy users ────────────────────────────────────────────────
  {
    ref: "zero-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
    tenantCount: 0,
  },
  {
    ref: "single-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
    tenantCount: 1,
  },
  {
    ref: "multi-tenant-user",
    credentials: ["password", "totp"],
    totpConfigured: true,
    tenantCount: "many",
  },

  // ── WebAuthn user ──────────────────────────────────────────────────────
  // One per scenario. Registering a security key permanently raises the
  // identity's highest available AAL, and login-ui forces a TOTP secret onto
  // the identity before the passkey page is reachable, so a shared archetype
  // would leave the second scenario's preconditions consumed by the first.
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

  // ── Google OIDC user ───────────────────────────────────────────────────
  // Only seeded when GOOGLE_TEST_EMAIL and GOOGLE_TEST_SUBJECT_ID are set.
  // The identity is created with a pre-linked OIDC credential so the
  // identifier-first flow shows the "Sign in with Google" button.
  {
    ref: "google-user",
    credentials: ["oidc/google"],
    totpConfigured: false,
  },

  // ── Registration users ─────────────────────────────────────────────────
  // These users are deleted and re-created during registration tests.
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
    // For register-without-verification: deleted and re-created like the
    // other new-user-* archetypes, on rows where verification is off.
    ref: "new-user-no-verification",
    credentials: ["password"],
    totpConfigured: false,
  },

  // ── Verification users ─────────────────────────────────────────────────
  // One per verification scenario: completing a verification flow permanently
  // marks the identity verified, so two scenarios cannot share an archetype —
  // the first would consume the second's precondition, and the gate's second
  // run would fail even though the first passed.
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

/** Look up an archetype by ref. Returns undefined if not found. */
export function getArchetype(ref: string): UserArchetype | undefined {
  return USER_ARCHETYPES.find((a) => a.ref === ref);
}
