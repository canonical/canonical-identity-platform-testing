// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Dex static accounts, pinned across both stacks.
 *
 * The seeder derives each `oidc/dex` archetype's kratos federated subject from
 * `dexUserId`, and the account-linking / tenant scenarios sign into dex as the
 * seeded addresses. The compose stack reads docker/dex/config.yml; the juju
 * lane reads matrix/backends/juju/manifests/dex.yaml.tpl. Nothing else checks
 * that the two carry the same accounts with the same userIDs, so a drift only
 * shows up as a red browser leg on one backend.
 *
 * Run: npx tsx --test seeder/dex-accounts.test.ts  (or `npm run test:unit`,
 * chained into `make check`). No stack, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { archetypeEmail } from "./ownership";
import { USER_ARCHETYPES } from "./archetypes";

const REPO_ROOT = resolve(__dirname, "../../..");
const COMPOSE_CONFIG = resolve(REPO_ROOT, "docker/dex/config.yml");
const JUJU_MANIFEST = resolve(
  REPO_ROOT,
  "matrix/backends/juju/manifests/dex.yaml.tpl",
);

/**
 * email → userID for every entry of a file's `staticPasswords:` block. Both
 * files spell entries identically (`- email: "…"` opens one, `userID: "…"` is
 * optional inside it), so a regex walk is enough; there is no YAML parser in
 * the tree. The block ends at the next key indented no deeper than
 * `staticPasswords:` itself.
 */
function staticPasswords(path: string): Record<string, string | undefined> {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s*staticPasswords:\s*$/.test(line));
  assert.ok(start >= 0, `${path}: no staticPasswords block`);
  const depth = lines[start].search(/\S/);
  const accounts: Record<string, string | undefined> = {};
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (line.search(/\S/) <= depth) break;
    const email = /^- email: "([^"]+)"$/.exec(trimmed);
    if (email) {
      current = email[1];
      assert.ok(!(current in accounts), `${path}: duplicate ${current}`);
      accounts[current] = undefined;
      continue;
    }
    const userId = /^userID: "([^"]+)"$/.exec(trimmed);
    if (userId) {
      assert.ok(current, `${path}: userID before any email`);
      accounts[current] = userId[1];
    }
  }
  assert.ok(Object.keys(accounts).length > 0, `${path}: staticPasswords block is empty`);
  return accounts;
}

const compose = staticPasswords(COMPOSE_CONFIG);
const juju = staticPasswords(JUJU_MANIFEST);

test("the juju manifest carries the same dex accounts as the compose stack", () => {
  assert.deepEqual(juju, compose);
});

test("every dex archetype's userID is a static dex account under its email", () => {
  const dexArchetypes = USER_ARCHETYPES.filter((a) => a.dexUserId);
  assert.ok(dexArchetypes.length > 0, "no archetype declares dexUserId");
  for (const archetype of dexArchetypes) {
    const email = archetypeEmail(archetype.ref);
    assert.equal(
      compose[email],
      archetype.dexUserId,
      `archetype ${archetype.ref}: dex account ${email} does not carry dexUserId`,
    );
  }
});
