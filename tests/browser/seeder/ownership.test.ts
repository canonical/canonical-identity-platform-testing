// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Ownership semantics, pinned.
 *
 * `ownsIdentity`/`ownsTenant` are the only thing standing between the seeder's
 * cleanup and a deployment's real users. A false positive here deletes data
 * that is not ours; a false negative leaks test records forever. Neither shows
 * up as a test failure anywhere else in the tree, so this file is the only
 * place a wrong answer can be caught.
 *
 * Run: npx tsx --test seeder/ownership.test.ts  (or `npm run test:unit`,
 * chained into `make check`). No stack, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archetypeEmail,
  NO_PROVENANCE,
  ownsIdentity,
  ownsTenant,
  provenanceFromManifest,
  TEST_TENANT_PREFIX,
} from "./ownership";
import { USER_ARCHETYPES } from "./archetypes";
import { DEX_USER_EMAIL } from "../helpers/test-credentials";
import { uniqueEmail, uniqueTenantName } from "../helpers/utils";

const identity = (email: string, id = "id-1") => ({ id, traits: { email } });

// ── The namespace grants ownership ──────────────────────────────────────────

test("every archetype's seeded email is owned", () => {
  for (const archetype of USER_ARCHETYPES) {
    if (archetype.credentials.includes("oidc/google")) continue; // real Workspace address
    assert.ok(
      ownsIdentity(identity(archetypeEmail(archetype.ref))),
      `archetype ${archetype.ref} seeds an email cleanup would refuse to delete`,
    );
  }
});

test("the Dex static user and runtime probe identities are owned", () => {
  // Everything the plane creates outside the seeder still has to be reclaimable,
  // or a crashed run leaks it permanently.
  assert.ok(ownsIdentity(identity(DEX_USER_EMAIL)));
  assert.ok(ownsIdentity(identity(uniqueEmail("backup"))));
  assert.ok(ownsIdentity(identity(uniqueEmail("webhook"))));
  assert.ok(ownsIdentity(identity("nav-probe@test.example")));
  assert.ok(ownsIdentity(identity("matrix-verify-aal-1234@test.example")));
});

test("the domain match is case-insensitive", () => {
  assert.ok(ownsIdentity(identity("Returning-MFA@TEST.EXAMPLE")));
});

// ── Everything else is foreign ──────────────────────────────────────────────

test("a real deployment's identities are never owned", () => {
  for (const email of [
    "alice@canonical.com",
    "ubuntu-one-user@ubuntu.com",
    "admin@internal.corp",
  ]) {
    assert.equal(ownsIdentity(identity(email)), false, `${email} must survive cleanup`);
  }
});

test("near-miss domains do not satisfy the namespace", () => {
  // The predicate is a suffix match on `@test.example`. These are the shapes
  // that would slip through a sloppier `includes()` and cost someone real users.
  for (const email of [
    "evil@test.example.com",
    "evil@sub.test.example",
    "evil@nottest.example",
    "test.example@canonical.com",
    "test.example",
  ]) {
    assert.equal(ownsIdentity(identity(email)), false, `${email} must not be treated as ours`);
  }
});

test("an identity with no email trait is foreign", () => {
  assert.equal(ownsIdentity({ id: "id-1" }), false);
  assert.equal(ownsIdentity({ id: "id-1", traits: {} }), false);
});

// ── Provenance is the only route out of the namespace ───────────────────────

test("google-user is owned only when our own manifest recorded its id", () => {
  const google = identity("someone@canonical.com", "google-identity-id");

  // This is the property that keeps the seeder from deleting an operator's real
  // Workspace identity purely because an archetype claims that address.
  assert.equal(ownsIdentity(google, NO_PROVENANCE), false);

  const provenance = provenanceFromManifest({
    users: [{ ref: "google-user", identityId: "google-identity-id" }],
  });
  assert.equal(ownsIdentity(google, provenance), true);
});

test("provenance does not leak between records", () => {
  const provenance = provenanceFromManifest({ users: [{ identityId: "mine" }] });
  assert.equal(ownsIdentity(identity("other@corp.com", "theirs"), provenance), false);
});

test("a malformed or absent manifest grants nothing", () => {
  for (const input of [
    undefined,
    null,
    "not a manifest",
    42,
    {},
    { users: "nope" },
    { users: [null, 7, {}, { identityId: 5 }, { identityId: "" }] },
    { tenants: [{ name: "no id" }] },
  ]) {
    const provenance = provenanceFromManifest(input);
    assert.equal(provenance.identityIds.size, 0, `${JSON.stringify(input)} granted identity ownership`);
    assert.equal(provenance.tenantIds.size, 0, `${JSON.stringify(input)} granted tenant ownership`);
  }
});

// ── Tenants ─────────────────────────────────────────────────────────────────

test("seeded and runtime tenant names are owned", () => {
  assert.ok(ownsTenant({ id: "t1", name: `${TEST_TENANT_PREFIX}Alpha Inc` }));
  assert.ok(ownsTenant({ id: "t2", name: uniqueTenantName() }));
  assert.ok(ownsTenant({ id: "t3", name: uniqueTenantName("Webhook") }));
});

test("a deployment's own tenants are never owned", () => {
  // "Alpha Inc" was the pre-namespace seeded name: a deployment that legitimately
  // has a tenant by that name must not lose it.
  for (const name of ["Alpha Inc", "Canonical", "Acme Corp"]) {
    assert.equal(ownsTenant({ id: "t", name }), false, `tenant "${name}" must survive cleanup`);
  }
});

test("a tenant we recorded is owned regardless of its name", () => {
  const provenance = provenanceFromManifest({ tenants: [{ ref: "alpha", id: "tenant-id" }] });
  assert.equal(ownsTenant({ id: "tenant-id", name: "Renamed By Hand" }, provenance), true);
  assert.equal(ownsTenant({ id: "other-id", name: "Renamed By Hand" }, provenance), false);
});
