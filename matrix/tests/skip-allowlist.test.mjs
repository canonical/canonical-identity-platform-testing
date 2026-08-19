// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// The justified-skip allow-list is shared, not duplicated. Hand-copied twins
// under a "KEEP IN SYNC" comment drift, and `gate.mjs` executes on import, so
// a drifted copy there would be invisible to tests. Both consumers are
// importable, so this asserts array IDENTITY: a copy-paste fails here instead
// of quietly changing what the gate tolerates.

import { test } from "node:test";
import assert from "node:assert/strict";

import { JUSTIFIED_SKIP as canonical } from "../../tests/browser/scripts/skip-allowlist.mjs";
import { JUSTIFIED_SKIP as fromRunner } from "../run-row.mjs";
import { JUSTIFIED_SKIP as fromGate } from "../../tests/browser/scripts/gate.mjs";

test("both consumers resolve to the one shared allow-list array", () => {
  assert.equal(fromRunner, canonical, "matrix/run-row.mjs must re-export the shared array, not a copy");
  assert.equal(fromGate, canonical, "tests/browser/scripts/gate.mjs must re-export the shared array, not a copy");
});

test("every entry is a RegExp and the list is not accidentally empty", () => {
  assert.ok(canonical.length >= 10, `expected the full allow-list, got ${canonical.length} entries`);
  for (const re of canonical) assert.ok(re instanceof RegExp, `not a RegExp: ${String(re)}`);
});

test("the reason shapes satisfies() actually produces are allow-listed", () => {
  // The runner prefixes every satisfies() reason with "Skipped: ", and every
  // reason from framework/requires.ts starts with "requires ".
  for (const reason of [
    "Skipped: requires multiTenancy=true, ActiveConfig=false",
    "Skipped: requires mailApi=true, ActiveConfig mail_api=false",
    'Skipped: scenario not compatible with lane "live" (supported: internal)',
  ]) {
    assert.ok(canonical.some((re) => re.test(reason)), `not allow-listed: ${reason}`);
  }
});

test("a quarantine-shaped reason is NOT allow-listed", () => {
  for (const reason of [
    "not yet implemented",
    "currently disabled",
    "",
    "flaky on CI",
    "google-user not found in manifest — run `make seed-test-data` first",
  ]) {
    assert.ok(!canonical.some((re) => re.test(reason)), `wrongly allow-listed: ${reason}`);
  }
});
