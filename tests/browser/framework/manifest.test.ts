// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Manifest lookup semantics, pinned.
 *
 * `resolveTenantDisplayName` is the join between scenario data (which names a
 * tenant by ref) and the seeder (which namespaces the display name so cleanup
 * can tell test tenants from a deployment's own — seeder/ownership.ts). Get it
 * wrong and the tenant-selection click targets a button that does not exist,
 * which surfaces as an opaque locator timeout rather than a naming bug.
 *
 * The tenant browser journeys only run on multi-tenancy matrix rows, never in
 * the gate (all three pinned profiles are single-tenant), so this file is the
 * only place the mapping is checked on every run.
 *
 * Run: npx tsx --test framework/manifest.test.ts  (or `npm run test:unit`,
 * chained into `make check`). No stack, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTenantDisplayName } from "./manifest";
import { TEST_TENANT_PREFIX } from "../seeder/ownership";
import type { Manifest } from "../seeder/manifest-schema";

/** The tenant block the seeder actually writes, prefix and all. */
const MANIFEST = {
  profile: "mx-test",
  seededAt: "2026-08-07T00:00:00.000Z",
  users: [],
  tenants: [
    { ref: "alpha", name: `${TEST_TENANT_PREFIX}Alpha Inc`, id: "id-alpha" },
    { ref: "beta", name: `${TEST_TENANT_PREFIX}Beta LLC`, id: "id-beta" },
    { ref: "gamma", name: `${TEST_TENANT_PREFIX}Gamma Ltd`, id: "id-gamma" },
  ],
  memberships: [],
  groups: [],
} as unknown as Manifest;

test("a scenario's tenant ref resolves to the seeded display name", () => {
  // This is what tenant-scenarios.ts declares; the UI renders the prefixed name.
  assert.equal(resolveTenantDisplayName(MANIFEST, "alpha"), "iam-test Alpha Inc");
  assert.equal(resolveTenantDisplayName(MANIFEST, "beta"), "iam-test Beta LLC");
});

test("a seeded display name resolves to itself", () => {
  assert.equal(
    resolveTenantDisplayName(MANIFEST, "iam-test Gamma Ltd"),
    "iam-test Gamma Ltd",
  );
});

test("no tenant selected resolves to undefined", () => {
  // zero-tenant and single-tenant scenarios never set selectTenant.
  assert.equal(resolveTenantDisplayName(MANIFEST, undefined), undefined);
});

test("an unseeded tenant fails loudly, naming what was seeded", () => {
  // The pre-namespace literal is the regression this guards: a scenario left
  // saying "Alpha Inc" must fail with a readable message, not a locator timeout.
  assert.throws(
    () => resolveTenantDisplayName(MANIFEST, "Alpha Inc"),
    (err: Error) => {
      assert.match(err.message, /no seeded tenant matches/);
      assert.match(err.message, /alpha \(iam-test Alpha Inc\)/);
      return true;
    },
  );
});

test("an empty tenant list still produces a readable error", () => {
  const empty = { ...MANIFEST, tenants: [] } as Manifest;
  assert.throws(
    () => resolveTenantDisplayName(empty, "alpha"),
    /Seeded tenants: none/,
  );
});
