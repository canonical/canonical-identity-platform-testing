#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { spawnSync } from "node:child_process";

const lane = (process.argv[2] || "internal").toLowerCase();
const args = process.argv.slice(3);

const env = {
  ...process.env,
  BROWSER_TEST_LANE: lane,
};

console.log(`Browser lane: ${lane}`);

const run = spawnSync(
  "npx",
  ["playwright", "test", "--reporter=json", ...args],
  { env, encoding: "utf8" },
);

if (run.stderr) {
  process.stderr.write(run.stderr);
}

let report;
try {
  report = JSON.parse(run.stdout || "{}");
} catch {
  if (run.stdout) {
    process.stdout.write(run.stdout);
  }
  console.error("Could not parse Playwright JSON report for summary output.");
  process.exit(run.status ?? 1);
}

const stats = report.stats || {};
const executed = (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0);
const skipped = stats.skipped || 0;
const incompatible = lane === "live" ? skipped : 0;

console.log("Lane execution summary:");
console.log(`- Executed: ${executed}`);
console.log(`- Skipped: ${skipped}`);
console.log(`- Incompatible: ${incompatible}`);
console.log(`- Unexpected failures: ${stats.unexpected || 0}`);
console.log(`- Flaky: ${stats.flaky || 0}`);

process.exit(run.status ?? 0);
