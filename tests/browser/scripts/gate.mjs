#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The browser-suite gate for one profile.
 *
 * Runs the full suite twice against an already-running stack, re-seeding before
 * each run, and enforces the acceptance criteria on the reporter's own counts:
 *
 *   - zero unexpected failures
 *   - zero flaky (a test that only passes on retry is a failure; retries are
 *     pinned to 0 in playwright.config.ts, so this should be structurally
 *     impossible — it is asserted anyway)
 *   - zero UNJUSTIFIED skips
 *   - the same set of tests executed in both runs
 *
 * On skips: a profile deliberately deploys a subset of the platform, so a
 * scenario that needs hook-service cannot run on `core`, and one that needs a
 * credential nobody supplied cannot run anywhere. Those are the `requires:`
 * system working. What must never happen is a test skipping for a reason that
 * is really a quarantine — a disabled assertion, an unimplemented flow, a guard
 * that always fires. So a skip is allowed only when its reason matches a
 * declared capability gate, and `scripts/coverage-union.mjs` separately proves
 * that every test executes on at least one profile.
 *
 * Static checks cannot substitute for this: `--list` never runs beforeEach, so
 * it cannot see runtime `test.skip(condition, ...)` calls, and grepping the
 * source cannot tell a capability gate from a quarantine tag. Only the executed
 * run knows what actually happened.
 *
 * Usage: node scripts/gate.mjs [--runs N] [--coverage-out FILE] [-- <playwright args>]
 */

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
        // Failure evidence rides along: without it a run-1-only failure
        // leaves nothing behind once run 2 has overwritten test-results/
        // (S-10 lost three instances that way).
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

// ── Expected-collection manifest ────────────────────────────────────────────
// The reporter's own numbers only describe the tests that WERE collected, and
// the matrix's declaration-drift check covers tier A alone — so a tier-B spec
// that stops being collected (a bad `testMatch`, a file rename, a top-level
// throw during load) disappears from every count without failing anything.
// `expected-tests.json` is the checked-in answer to "how many tests should this
// tree collect, per file", and the gate diffs against it.

/** Per-spec-file collected-test counts, from the whole collected set. */
export function countByFile(tests) {
  const counts = new Map();
  for (const t of tests) {
    const file = t.id.split(" › ")[0];
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** Differences between the collected set and expected-tests.json, one line each.
 *
 *  An expected value may be a NUMBER (the file collects the same set on every
 *  profile) or an ARRAY of numbers (the file's collection legitimately varies —
 *  `oidc.spec.ts` picks its scenario suite at collection time from the declared
 *  `oidc_webauthn_sequencing_enabled`, so it collects one count with sequencing
 *  off and a different one with it on). An array still catches what this exists
 *  to catch: a file collecting 0, or any count nobody declared. */
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

// ── Entry ───────────────────────────────────────────────────────────────────
// Main-guarded so tests can import this module (and its allow-list) without
// running a gate (mirrors matrix/run-row.mjs).

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {

const profile = process.env.ACTIVE_PROFILE ?? "core";
const runResults = [];

for (let attempt = 1; attempt <= runs; attempt++) {
  console.log(`\n── browser run ${attempt}/${runs} ──`);

  // Re-seed before every run. Several scenarios permanently mutate their
  // identity — verification marks it verified, registration deletes and
  // recreates it — so a second run against the first run's leftovers is not a
  // repeat of the same experiment. The suite's contract is that the seeder owns
  // all admin-API state and specs are browser-only, so resetting belongs here
  // rather than in per-scenario cleanup hooks.
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

  // Fingerprint the SHAPE of the seed each run consumes. When two runs
  // disagree the first question is always "did they see the same seeded
  // state?", and re-deriving that afterwards is guesswork.
  //
  // Hashing the file itself is useless: every `--fresh` seed mints new
  // identity UUIDs, so the bytes differ on every run by design. What must NOT
  // differ is the shape the scenarios gate on — which archetypes exist and
  // which credentials each one carries. `totpSecret` present-vs-null is
  // precisely the kind of difference that once produced an unexplained
  // one-run divergence, so it is projected here.
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

  // Each run keeps its own artifact directory: Playwright wipes its output
  // dir on start, so with a shared one run 2 destroys run 1's traces —
  // exactly the evidence a run-1-only failure needs.
  const run = spawnSync(
    "npx",
    ["playwright", "test", "--reporter=json", `--output=test-results/run-${attempt}`, ...extraArgs],
    { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // The raw report is the whole evidence for a run-1-vs-run-2 comparison
  // (per-test durations, error bodies, attachment paths); keep it beside
  // the run's artifacts.
  const reportStart = run.stdout?.indexOf("{") ?? -1;
  if (reportStart !== -1) {
    mkdirSync(`test-results/run-${attempt}`, { recursive: true });
    writeFileSync(`test-results/run-${attempt}/report.json`, run.stdout.slice(reportStart));
  }

  if (run.stderr) process.stderr.write(run.stderr);

  let report;
  try {
    // Playwright's JSON reporter writes to stdout, but tooling noise can precede
    // it — parse from the first brace rather than assuming the whole stream.
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

// A differing seed SHAPE between runs breaks the premise of running twice: the
// two runs are then not the same experiment, and any executed-set difference
// above would be explained by the input rather than by nondeterminism in the
// suite. Identity UUIDs legitimately change per seed and are excluded from the
// fingerprint; what is compared is which archetypes exist and what credentials
// they carry.
const fingerprints = runResults.map((r) => r.manifestFingerprint);
if (new Set(fingerprints).size > 1) {
  failures.push(
    `the seeded manifest SHAPE differed between runs (${fingerprints.join(" vs ")}) — ` +
      "the runs are not the same experiment; investigate the seeder before trusting any other verdict",
  );
}

// Pass-through playwright args (--project, --grep, a file path) deliberately
// narrow collection, so the manifest cannot describe that run. The Makefile
// path passes none, which is the path CI gates on.
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
