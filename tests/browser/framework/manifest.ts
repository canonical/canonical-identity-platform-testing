// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Manifest reader/writer for the scenario-driven test framework.
 *
 * The manifest is a JSON file that contains all seeded test data (users,
 * tenants, memberships). The test runner reads it to find user credentials
 * and tenant IDs. The seeder writes it after creating test data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Manifest, ManifestUser, ManifestTenant, ManifestOauthClients } from "../seeder/manifest-schema";

// ---------------------------------------------------------------------------
// Default manifest path
// ---------------------------------------------------------------------------

/** Default manifest file name. */
export const MANIFEST_FILENAME = "manifest.json";

/**
 * Resolve the manifest path: `MANIFEST` if set, else `tests/browser/manifest.json`.
 *
 * The override is what lets the seeding host and the test host be different
 * machines. An admin with admin-API reach runs the seeder out of band against a
 * real deployment (`MANIFEST=/path/out.json npx tsx seeder/seed.ts`), hands the
 * file to a runner that has only the public login-ui, and the runner reads it
 * back the same way. Without it the suite could only ever test a deployment it
 * was itself allowed to provision.
 */
export function resolveManifestPath(): string {
  const override = process.env.MANIFEST;
  return override ? path.resolve(override) : path.resolve(__dirname, "..", MANIFEST_FILENAME);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read a manifest from a JSON file.
 * Throws if the file doesn't exist or is invalid JSON.
 */
export function readManifest(manifestPath?: string): Manifest {
  const filePath = manifestPath ?? resolveManifestPath();

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Manifest file not found: ${filePath}\n` +
      `Run "make seed-test-data" to create it, or provide a manifest with MANIFEST=<path>.`
    );
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const manifest: Manifest = JSON.parse(raw);

  // Basic validation
  if (!manifest.profile || !manifest.seededAt || !Array.isArray(manifest.users)) {
    throw new Error(
      `Invalid manifest format: missing required fields (profile, seededAt, users). ` +
      `File: ${filePath}`
    );
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write a manifest to a JSON file.
 * Creates the directory if it doesn't exist.
 */
export function writeManifest(manifest: Manifest, manifestPath?: string): void {
  const filePath = manifestPath ?? resolveManifestPath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Persist a user's TOTP secret in the manifest.
 *
 * This allows scenarios that rely on pre-configured TOTP users to reuse the
 * generated secret across independent test cases in the same run.
 */
export function setUserTotpSecret(ref: string, totpSecret: string, manifestPath?: string): void {
  const manifest = readManifest(manifestPath);
  const user = manifest.users.find((u) => u.ref === ref);
  if (!user) {
    throw new Error(`User ref "${ref}" not found when setting TOTP secret`);
  }
  user.totpSecret = totpSecret;
  user.totpConfigured = true;
  writeManifest(manifest, manifestPath);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a user in the manifest by ref.
 * Throws if not found.
 */
export function findUserByRef(manifest: Manifest, ref: string): ManifestUser {
  const user = manifest.users.find((u) => u.ref === ref);
  if (!user) {
    throw new Error(
      `User ref "${ref}" not found in manifest. ` +
      `Available refs: ${manifest.users.map((u) => u.ref).join(", ")}`
    );
  }
  return user;
}

/**
 * Find a tenant in the manifest by ref.
 * Throws if not found.
 */
export function findTenantByRef(manifest: Manifest, ref: string): ManifestTenant {
  const tenant = manifest.tenants.find((t) => t.ref === ref);
  if (!tenant) {
    throw new Error(
      `Tenant ref "${ref}" not found in manifest. ` +
      `Available refs: ${manifest.tenants.map((t) => t.ref).join(", ")}`
    );
  }
  return tenant;
}

/**
 * Resolve a scenario's tenant reference to the display name the UI renders.
 *
 * Scenarios name a tenant by manifest ref, exactly as they name a user. The
 * seeder namespaces the actual tenant names so cleanup can tell them apart from
 * a deployment's own tenants (seeder/ownership.ts), and scenario data must not
 * restate that convention. A seeded display name is still accepted so an
 * ad-hoc scenario can name one directly.
 */
export function resolveTenantDisplayName(
  manifest: Manifest,
  ref: string | undefined,
): string | undefined {
  if (!ref) return undefined;
  const tenant = manifest.tenants.find((t) => t.ref === ref || t.name === ref);
  if (!tenant) {
    const seeded = manifest.tenants.map((t) => `${t.ref} (${t.name})`).join(", ");
    throw new Error(
      `Scenario selects tenant "${ref}" but no seeded tenant matches. ` +
      `Seeded tenants: ${seeded || "none"}`
    );
  }
  return tenant.name;
}

/**
 * Get the OAuth2 client credentials from the manifest.
 * Returns undefined if the manifest was created before client seeding was added.
 */
export function getOauthClients(manifest: Manifest): ManifestOauthClients | undefined {
  return manifest.oauthClients;
}

/**
 * Get the RP (authorization code) client credentials from the manifest.
 * Returns undefined if not available.
 */
export function getRpClient(manifest: Manifest): ManifestOauthClients["rp"] | undefined {
  return manifest.oauthClients?.rp;
}

/**
 * Get the service (client credentials) client credentials from the manifest.
 * Returns undefined if not available.
 */
export function getSvcClient(manifest: Manifest): ManifestOauthClients["svc"] | undefined {
  return manifest.oauthClients?.svc;
}
