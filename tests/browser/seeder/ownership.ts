// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Ownership — the predicate that decides what the seeder is allowed to delete.
 *
 * Fresh-mode cleanup must never be an unscoped list-and-delete of every Kratos
 * identity and tenant on the deployment: that is only defensible against a
 * disposable compose stack; pointed at a shared or pre-existing deployment it
 * deletes that deployment's users. An admin has to be able to create, re-create
 * and remove the test archetypes out of band without touching anything they did
 * not seed, so deletion is scoped by two independent, provable signals:
 *
 *  - NAMESPACE. Every identity the test plane creates lives in the
 *    `@test.example` domain: archetypes (`<ref>@test.example`), the Dex static
 *    user, `uniqueEmail()` probes, and matrix/verify.mjs's throwaway AAL
 *    identity. `.example` is reserved by RFC 2606 §3 and can never be a real
 *    mail domain, so domain membership proves ownership with no prior state to
 *    consult. tenant-service has no reserved namespace to borrow, so seeded
 *    tenants carry `TEST_TENANT_PREFIX` in their name instead.
 *
 *  - PROVENANCE. Anything we created that is NOT in the namespace — today only
 *    `google-user`, whose email is the operator's real Workspace account — is
 *    owned solely because the manifest we last wrote recorded its id. The
 *    Google identity therefore stays re-creatable without the seeder ever
 *    inferring a right to delete an account from its email address.
 *
 * Neither signal is a heuristic, and neither can be satisfied by a record the
 * test plane did not create. Anything matching neither is foreign and is left
 * strictly alone.
 */

/** Reserved domain (RFC 2606 §3) that every test-plane identity lives in. */
export const TEST_EMAIL_DOMAIN = "test.example";

/** Name prefix marking a tenant as test-plane owned. */
export const TEST_TENANT_PREFIX = "iam-test ";

/**
 * The seeded email for an archetype ref — the seeder's only email rule, and
 * the reason archetype identities are recognisable as ours on sight.
 */
export function archetypeEmail(ref: string): string {
  return `${ref}@${TEST_EMAIL_DOMAIN}`;
}

/** Ids recorded by a manifest this test plane previously wrote. */
export interface Provenance {
  identityIds: ReadonlySet<string>;
  tenantIds: ReadonlySet<string>;
}

/** No prior manifest: only the reserved namespace grants ownership. */
export const NO_PROVENANCE: Provenance = {
  identityIds: new Set(),
  tenantIds: new Set(),
};

/**
 * Extract provenance from a previously written manifest.
 *
 * Deliberately tolerant of shape: a manifest from an older seeder, or one an
 * admin hand-wrote for an out-of-band deployment, must widen ownership where it
 * can and never throw. A malformed entry simply grants nothing, which fails
 * closed — the record is treated as foreign and survives.
 */
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

/**
 * Whether the seeder may delete this identity: reserved-domain email, or an id
 * a manifest we wrote recorded. Everything else belongs to the deployment.
 */
export function ownsIdentity(
  identity: { id: string; traits?: { email?: string } },
  provenance: Provenance = NO_PROVENANCE,
): boolean {
  const email = identity.traits?.email;
  const inNamespace =
    typeof email === "string" && email.toLowerCase().endsWith(`@${TEST_EMAIL_DOMAIN}`);
  return inNamespace || provenance.identityIds.has(identity.id);
}

/**
 * Whether the seeder may delete this tenant: prefixed name, or an id a manifest
 * we wrote recorded. Everything else belongs to the deployment.
 */
export function ownsTenant(
  tenant: { id: string; name: string },
  provenance: Provenance = NO_PROVENANCE,
): boolean {
  return tenant.name.startsWith(TEST_TENANT_PREFIX) || provenance.tenantIds.has(tenant.id);
}
