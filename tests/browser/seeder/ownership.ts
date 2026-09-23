// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// The seeder may delete only what it can prove it created: identities in the
// reserved `@test.example` domain (RFC 2606 §3), tenants named with `TEST_TENANT_PREFIX`,
// and ids recorded in a manifest it wrote. Anything else is foreign and is left alone.

export const TEST_EMAIL_DOMAIN = "test.example";

export const TEST_TENANT_PREFIX = "iam-test ";

export function archetypeEmail(ref: string): string {
  return `${ref}@${TEST_EMAIL_DOMAIN}`;
}

/** Ids recorded by a manifest this test plane previously wrote. */
export interface Provenance {
  identityIds: ReadonlySet<string>;
  tenantIds: ReadonlySet<string>;
}

export const NO_PROVENANCE: Provenance = {
  identityIds: new Set(),
  tenantIds: new Set(),
};

/** Tolerant of shape: a malformed entry grants nothing, so the record stays foreign. */
export function provenanceFromManifest(manifest: unknown): Provenance {
  const identityIds = new Set<string>();
  const tenantIds = new Set<string>();

  if (!manifest || typeof manifest !== "object") {
    return { identityIds, tenantIds };
  }

  if ("users" in manifest && Array.isArray(manifest.users)) {
    for (const user of manifest.users) {
      if (!user || typeof user !== "object" || !("identityId" in user)) continue;
      if (typeof user.identityId === "string" && user.identityId) {
        identityIds.add(user.identityId);
      }
    }
  }

  if ("tenants" in manifest && Array.isArray(manifest.tenants)) {
    for (const tenant of manifest.tenants) {
      if (!tenant || typeof tenant !== "object" || !("id" in tenant)) continue;
      if (typeof tenant.id === "string" && tenant.id) {
        tenantIds.add(tenant.id);
      }
    }
  }

  return { identityIds, tenantIds };
}

export function ownsIdentity(
  identity: { id: string; traits?: { email?: string } },
  provenance: Provenance = NO_PROVENANCE,
): boolean {
  const email = identity.traits?.email;
  const inNamespace =
    typeof email === "string" && email.toLowerCase().endsWith(`@${TEST_EMAIL_DOMAIN}`);
  return inNamespace || provenance.identityIds.has(identity.id);
}

export function ownsTenant(
  tenant: { id: string; name: string },
  provenance: Provenance = NO_PROVENANCE,
): boolean {
  return tenant.name.startsWith(TEST_TENANT_PREFIX) || provenance.tenantIds.has(tenant.id);
}
