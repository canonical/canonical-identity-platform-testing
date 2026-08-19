#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Cross-profile coverage check.
 *
 * Each profile is allowed to skip tests it genuinely cannot support, so no
 * single profile proves the suite is alive. What must hold is that the UNION of
 * what actually executed, across every profile, covers every test the suite
 * collects. A test that skips everywhere is dead weight pretending to be
 * coverage — this is what catches it.
 *
 * Consumes the per-profile files written by `gate.mjs --coverage-out`.
 *
 * Usage: node scripts/coverage-union.mjs <coverage.json>...
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GAPS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "known-coverage-gaps.json");

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: coverage-union.mjs <coverage.json>...");
  process.exit(2);
}

const collected = new Set();
const executed = new Set();
const executedBy = new Map();

for (const path of paths) {
  const { profile, collected: c, executed: e } = JSON.parse(readFileSync(path, "utf8"));
  for (const id of c) collected.add(id);
  for (const id of e) {
    executed.add(id);
    executedBy.set(id, [...(executedBy.get(id) ?? []), profile]);
  }
}

const { gaps } = JSON.parse(readFileSync(GAPS_FILE, "utf8"));
const known = new Map(gaps.map((g) => [g.test, g]));

const dead = [...collected].filter((id) => !executed.has(id)).sort();
const unexpectedlyDead = dead.filter((id) => !known.has(id));
// An entry that has started running again is just as wrong as a missing one:
// it means the register is stale and is now hiding nothing.
const staleExceptions = [...known.keys()].filter((id) => executed.has(id)).sort();

console.log(`\n═══ Cross-profile coverage (${paths.length} profiles) ═══`);
console.log(`collected: ${collected.size}   executed somewhere: ${executed.size}`);

const onlyOnce = [...executedBy.entries()].filter(([, p]) => p.length === 1);
if (onlyOnce.length > 0) {
  console.log(`\nExecuted on exactly one profile (${onlyOnce.length}):`);
  for (const [id, profiles] of onlyOnce.sort()) {
    console.log(`  ${id} — ${profiles[0]}`);
  }
}

const accepted = dead.filter((id) => known.has(id));
if (accepted.length > 0) {
  console.log(`\nUncovered but accepted (${accepted.length}) — see known-coverage-gaps.json:`);
  for (const id of accepted) {
    console.log(`  ${id}`);
    console.log(`    reason:      ${known.get(id).reason}`);
    console.log(`    unblocked by: ${known.get(id).unblocked_by}`);
  }
}

let failed = false;

if (unexpectedlyDead.length > 0) {
  failed = true;
  console.error(
    `\n✗ ${unexpectedlyDead.length} test(s) skipped on EVERY profile and NOT in known-coverage-gaps.json:`,
  );
  for (const id of unexpectedlyDead) console.error(`  ${id}`);
  console.error("  Either make one profile able to run them, or add an entry naming what unblocks them.");
}

if (staleExceptions.length > 0) {
  failed = true;
  console.error(`\n✗ ${staleExceptions.length} known-gap entr(ies) now execute — remove them from known-coverage-gaps.json:`);
  for (const id of staleExceptions) console.error(`  ${id}`);
}

if (failed) process.exit(1);

console.log(
  `\n✓ every collected test executes on at least one profile, ` +
    `except ${accepted.length} accepted and documented gap(s)`,
);
