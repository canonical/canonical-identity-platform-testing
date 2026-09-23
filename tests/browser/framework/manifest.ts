// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import * as fs from "node:fs";
import * as path from "node:path";
import type { Manifest, ManifestUser, ManifestOauthClients } from "../seeder/manifest-schema";

export const MANIFEST_FILENAME = "manifest.json";

/** `MANIFEST` if set, else `tests/browser/manifest.json`; the override lets a seeding host hand
 *  the file to a runner that has only public login-ui reach. */
export function resolveManifestPath(): string {
  const override = process.env.MANIFEST;
  return override ? path.resolve(override) : path.resolve(__dirname, "..", MANIFEST_FILENAME);
}

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

  if (!manifest.profile || !manifest.seededAt || !Array.isArray(manifest.users)) {
    throw new Error(
      `Invalid manifest format: missing required fields (profile, seededAt, users). ` +
      `File: ${filePath}`
    );
  }

  return manifest;
}

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

/** Manifest ref (or seeded display name) → the display name the UI renders. The seeder namespaces
 *  tenant names (seeder/ownership.ts); scenario data must not restate that convention. */
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

export function getRpClient(manifest: Manifest): ManifestOauthClients["rp"] | undefined {
  return manifest.oauthClients?.rp;
}

export function getSvcClient(manifest: Manifest): ManifestOauthClients["svc"] | undefined {
  return manifest.oauthClients?.svc;
}
