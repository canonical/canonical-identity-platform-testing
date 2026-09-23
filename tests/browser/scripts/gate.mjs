#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Runs the suite `--runs` times (default 2) against a running stack, re-seeding before each run.
// Exit 1 on any unexpected failure, any flaky test (retries are pinned to 0), any skip whose reason
// is not in JUSTIFIED_SKIP, an executed set or seed shape that differs between runs, or collection
// drift from expected-tests.json. Exit 2 on bad arguments.
// Usage: node scripts/gate.mjs [--runs N] [--coverage-out FILE] [-- <playwright args>]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { JUSTIFIED_SKIP } from "./skip-allowlist.mjs";

const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const runs = flagValue("--runs") === undefined ? 2 : Number(flagValue("--runs"));
const coverageOut = flagValue("--coverage-out");
const passThroughAt = argv.indexOf("--");
const extraArgs = passThroughAt === -1 ? [] : argv.slice(passThroughAt + 1);

if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer, got: ${flagValue("--runs")}`);
  process.exit(2);
}

export { JUSTIFIED_SKIP };

/** Per-test outcome, keyed by "file › title". */
function collectTests(report) {
  const results = [];

  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const testCase of spec.tests ?? []) {
        const annotations = [
          ...(testCase.annotations ?? []),
          ...(testCase.results ?? []).flatMap((r) => r.annotations ?? []),
        ];
        const failed = (testCase.results ?? []).filter((r) => r.status !== "passed" && r.status !== "skipped");
        results.push({
          id: `${spec.file} › ${spec.title}`,
          status: testCase.status,
          reason: annotations
            .filter((a) => a.type === "skip")
            .map((a) => a.description ?? "")
            .join(" | "),
          failures: failed.map((r) => ({
            startTime: r.startTime,
            durationMs: r.duration,
            message: (r.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, ""),
            attachments: (r.attachments ?? []).filter((a) => a.path).map((a) => `${a.name}: ${a.path}`),
          })),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };

  for (const suite of report.suites ?? []) walk(suite);
  return results;
}

// --- Expected-collection manifest ---
// A tier-B spec that stops being collected (bad `testMatch`, rename, load throw) vanishes from
// every count; expected-tests.json is the checked-in per-file count the gate diffs against.

/** Per-spec-file collected-test counts, from the whole collected set. */
export function countByFile(tests) {
  const counts = new Map();
  for (const t of tests) {
    const file = t.id.split(" › ")[0];
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** Drift lines vs expected-tests.json; a value is a number or an array of allowed counts. */
export function manifestDrift(tests, manifestPath) {
  const expected = JSON.parse(readFileSync(manifestPath, "utf8")).files;
  const actual = countByFile(tests);
  const drift = [];
  for (const [file, count] of Object.entries(expected)) {
    const allowed = Array.isArray(count) ? count : [count];
    const got = actual.get(file) ?? 0;
    if (!allowed.includes(got)) {
      drift.push(`${file}: expected ${allowed.join(" or ")} test(s), collected ${got}`);
    }
  }
  for (const [file, got] of actual) {
    if (!(file in expected)) drift.push(`${file}: not in the manifest, collected ${got} test(s)`);
  }
  return drift;
}

// --- Entry ---
// Main-guarded so tests can import the allow-list without running a gate.

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {

const profile = process.env.ACTIVE_PROFILE ?? "core";
const runResults = [];

for (let attempt = 1; attempt <= runs; attempt++) {
  console.log(`\n── browser run ${attempt}/${runs} ──`);

  // Re-seed before every run: several scenarios permanently mutate their identity, so a run
  // against the previous run's leftovers is not the same experiment.
  const seed = spawnSync(
    "npx",
    ["tsx", "seeder/seed.ts", "--fresh", "--profile", profile],
    { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (seed.status !== 0) {
    process.stdout.write(seed.stdout ?? "");
    process.stderr.write(seed.stderr ?? "");
    console.error(`✗ seeding failed before run ${attempt} — cannot gate`);
    process.exit(1);
  }
  console.log(`seeded profile ${profile}`);

  // Fingerprint the seed SHAPE (which archetypes exist, which credentials they carry), not the
  // bytes: every `--fresh` seed mints new identity UUIDs.
  let manifestFingerprint = "<unreadable>";
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"),
    );
    const shape = (manifest.users ?? [])
      .map((u) => [
        u.ref,
        `pw=${Boolean(u.password)}`,
        `totp=${Boolean(u.totpSecret)}`,
        `tenants=${(u.tenantRefs ?? []).length}`,
      ].join("|"))
      .sort()
      .concat(Object.keys(manifest.oauthClients ?? {}).sort().map((c) => `client:${c}`))
      .join("\n");
    manifestFingerprint = createHash("sha256").update(shape).digest("hex").slice(0, 12);
  } catch (err) {
    console.warn(`could not fingerprint manifest.json: ${err.message}`);
  }
  console.log(`manifest shape ${manifestFingerprint}`);

  // Per-run output dir: Playwright wipes its output dir on start.
  const run = spawnSync(
    "npx",
    ["playwright", "test", "--reporter=json", `--output=test-results/run-${attempt}`, ...extraArgs],
    { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Keep the raw report beside the run's artifacts.
  const reportStart = run.stdout?.indexOf("{") ?? -1;
  if (reportStart !== -1) {
    mkdirSync(`test-results/run-${attempt}`, { recursive: true });
    writeFileSync(`test-results/run-${attempt}/report.json`, run.stdout.slice(reportStart));
  }

  if (run.stderr) process.stderr.write(run.stderr);

  let report;
  try {
    // Tooling noise can precede the JSON report; parse from the first brace.
    const start = run.stdout?.indexOf("{") ?? -1;
    report = JSON.parse(start === -1 ? "{}" : run.stdout.slice(start));
  } catch {
    if (run.stdout) process.stdout.write(run.stdout);
    console.error("Could not parse the Playwright JSON report — treating as failure.");
    process.exit(run.status ?? 1);
  }

  if ((report.errors ?? []).length > 0) {
    for (const error of report.errors) {
      console.error(`✗ run-level error: ${error.message}`);
    }
    process.exit(1);
  }

  const stats = report.stats ?? {};
  const tests = collectTests(report);
  const executed = tests.filter((t) => t.status !== "skipped");

  console.log(
    `passed=${stats.expected ?? 0} failed=${stats.unexpected ?? 0} ` +
      `flaky=${stats.flaky ?? 0} skipped=${stats.skipped ?? 0} executed=${executed.length}`,
  );

  for (const t of tests) {
    if (t.status === "skipped") {
      const justified = JUSTIFIED_SKIP.some((re) => re.test(t.reason));
      console.log(`  skipped${justified ? "" : " (UNJUSTIFIED)"}: ${t.id} — ${t.reason || "<no reason given>"}`);
    } else if (t.status !== "expected") {
      console.log(`  ${t.status}: ${t.id}`);
      for (const f of t.failures) {
        console.log(`    started ${f.startTime} (${f.durationMs} ms)`);
        for (const line of f.message.split("\n").slice(0, 12)) console.log(`    | ${line}`);
        for (const a of f.attachments) console.log(`    ${a}`);
      }
    }
  }

  runResults.push({ attempt, stats, tests, executed, manifestFingerprint });
}

console.log("\n═══ Gate verdict ═══");

const failures = [];

for (const { attempt, stats, tests } of runResults) {
  if ((stats.unexpected ?? 0) > 0) {
    failures.push(
      `run ${attempt}: ${stats.unexpected} failed — ` +
        tests.filter((t) => t.status === "unexpected").map((t) => t.id).join(", "),
    );
  }
  if ((stats.flaky ?? 0) > 0) {
    failures.push(
      `run ${attempt}: ${stats.flaky} flaky — ` +
        tests.filter((t) => t.status === "flaky").map((t) => t.id).join(", "),
    );
  }
  const unjustified = tests.filter(
    (t) => t.status === "skipped" && !JUSTIFIED_SKIP.some((re) => re.test(t.reason)),
  );
  if (unjustified.length > 0) {
    failures.push(
      `run ${attempt}: ${unjustified.length} unjustified skip(s) — ` +
        unjustified.map((t) => `${t.id} (${t.reason || "no reason"})`).join(", "),
    );
  }
}

const executedSets = runResults.map((r) => r.executed.map((t) => t.id).sort().join("\n"));
if (new Set(executedSets).size > 1) {
  failures.push(
    `the set of executed tests differed between runs (${runResults
      .map((r) => r.executed.length)
      .join(" vs ")}) — the suite is not deterministic`,
  );
}

// A differing seed shape means the runs are not the same experiment.
const fingerprints = runResults.map((r) => r.manifestFingerprint);
if (new Set(fingerprints).size > 1) {
  failures.push(
    `the seeded manifest SHAPE differed between runs (${fingerprints.join(" vs ")}) — ` +
      "the runs are not the same experiment; investigate the seeder before trusting any other verdict",
  );
}

// Pass-through playwright args narrow collection, so the manifest cannot describe that run.
if (extraArgs.length > 0) {
  console.log(`manifest diff skipped — custom playwright args narrow collection (${extraArgs.join(" ")})`);
} else {
  const drift = manifestDrift(runResults[0].tests, new URL("../expected-tests.json", import.meta.url));
  if (drift.length > 0) {
    failures.push(
      `collected tests do not match expected-tests.json — ${drift.join("; ")} ` +
        "(if the change was intentional, regenerate the manifest: " +
        "npx playwright test --list --reporter=json)",
    );
  }
}

if (coverageOut) {
  writeFileSync(
    coverageOut,
    JSON.stringify(
      {
        profile,
        collected: runResults[0].tests.map((t) => t.id),
        executed: runResults[0].executed.map((t) => t.id),
      },
      null,
      2,
    ),
  );
  console.log(`coverage written to ${coverageOut}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

const skipped = runResults[0].tests.length - runResults[0].executed.length;
console.log(
  `✓ ${runResults[0].executed.length} tests passed in all ${runs} runs on ${profile} ` +
    `— no failures, no flakes, ${skipped} capability-gated skip(s)`,
);

}
