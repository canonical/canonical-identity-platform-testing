#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Matrix-lane runner: deploy → verify → seed → test one materialized row.
//
//   node matrix/run-row.mjs <row-name> [--backend=compose|juju|urls] [--attach [--plan-only]]
//   node matrix/run-row.mjs --all      [--backend=compose|juju|urls]
//
// Contract: matrix/verify.mjs must pass before any test runs; gating reads the
// row's capabilities.json declaration (never runtime discovery); the executed
// set is compared against scripts/expected-set.ts computed from the same
// declaration, so a tier-A test that skips when expected to run fails the row.
//
// Backends: compose (`make matrix-up ROW=…`), juju (terraform apply on the row
// root; URLs discovered from the live model; JUJU_CONTROLLER required;
// MATRIX_JUJU_BROWSER=0 skips the browser leg), urls (external deployment;
// env is the whole interface, LOGIN_UI_URL required).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assertController } from "./controller-guard.mjs";
import { rowArtifacts, rowRunsOn } from "./lib.mjs";
import { resolveUrls, rowUrlEnv } from "./verify/urls.mjs";
import { classifyOutcome, collectTests, JUSTIFIED_SKIP, TIER_A_FILES } from "./verdict.mjs";
import { attachJuju, deployJuju, discoverJujuUrls } from "./juju-backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const BROWSER_DIR = path.join(REPO, "tests", "browser");

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

export { JUSTIFIED_SKIP, TIER_A_FILES };

// ── Row selection ───────────────────────────────────────────────────────────

/** Rows a run covers on `backend`; `target === null` is `--all` (every
 *  non-pinned row). `outOfScope` = bound to other backends; `noArtifact` =
 *  runnable but no materialized artefact (lib.mjs rowArtifacts). */
export function selectRows(matrix, backend, target) {
  const candidates = matrix.rows.filter((r) => (target === null ? r.kind !== "pinned" : r.name === target));
  if (candidates.length === 0) return { rows: [target], outOfScope: [], noArtifact: [] };
  const runnable = (r) => rowRunsOn(r, backend) && (backend === "urls" || rowArtifacts(r)[backend]);
  return {
    rows: candidates.filter(runnable).map((r) => r.name),
    outOfScope: candidates.filter((r) => !rowRunsOn(r, backend)),
    noArtifact: candidates.filter((r) => rowRunsOn(r, backend) && !runnable(r)),
  };
}

// ── Backend: deploy + environment ───────────────────────────────────────────

function deployCompose(rowName) {
  const up = sh("make", ["matrix-up", `ROW=${rowName}`], { cwd: REPO });
  if (up.status !== 0) process.stderr.write(up.stderr ?? "");
  return up.status === 0;
}

/** The only place insecure-TLS policy is expressed. NODE_TLS_REJECT_UNAUTHORIZED
 *  covers node fetch (verifier, seeder); BROWSER_TEST_INSECURE_TLS is read by
 *  playwright.config.ts (ignoreHTTPSErrors + chromium --ignore-certificate-errors). */
function insecureTlsEnv(on) {
  return on ? { NODE_TLS_REJECT_UNAUTHORIZED: "0", BROWSER_TEST_INSECURE_TLS: "1" } : {};
}

// Hydra sample consumer for authorization_code flows. Compose runs it as a
// service on :4446; juju/urls lanes run the same CLI in a host-network
// container on :4447 so both stacks can coexist (the seeder registers both
// redirects, tests/browser/seeder/clients.ts). --network host because the
// consumer must reach hydra's ClusterIP for the token exchange and docker's
// bridge fights the CNI's iptables rules.
const CONSUMER_NAME = "matrix-oidc-consumer";
const CONSUMER_URL = "http://127.0.0.1:4447";

/** Charmed-lane env: discovered URLs (operator env wins) plus lane TLS policy. */
function jujuEnv() {
  return {
    ...rowUrlEnv({ ...discoverJujuUrls(), OIDC_CONSUMER_URL: CONSUMER_URL }),
    // The charmed ingress serves a self-signed CA this harness created; not overridable.
    ...insecureTlsEnv(true),
    MATRIX_BACKEND: "juju",
  };
}

/** URLs-only backend: env is the whole interface. */
function urlsEnv() {
  return {
    ...rowUrlEnv(),
    // Verification stays ON by default: this lane targets real deployments. Opt in with MATRIX_INSECURE_TLS=1.
    ...insecureTlsEnv(process.env.MATRIX_INSECURE_TLS === "1"),
    MATRIX_BACKEND: "urls",
  };
}

/** Attach against a deployment reached only through its public ingress
 *  (MATRIX_JUJU_PUBLIC=1): the substrate layer still reads juju, but URLs are
 *  the urls interface — no discovery, no cluster IPs, live lane unless
 *  KRATOS_ADMIN_URL is set — so one out-of-band seed (MANIFEST) serves every row. */
function publicJujuEnv() {
  return {
    ...rowUrlEnv({ OIDC_CONSUMER_URL: CONSUMER_URL }),
    ...insecureTlsEnv(process.env.MATRIX_INSECURE_TLS === "1"),
    MATRIX_BACKEND: "juju",
    MATRIX_PUBLIC_URLS: "1",
  };
}

function startConsumer(u, rowEnv) {
  sh("docker", ["rm", "-f", CONSUMER_NAME]);
  // The consumer is a Go client in its own container: SSL_CERT_FILE makes the
  // run's extra CAs its entire root pool (docs/testing-spec.md §9).
  // Verification stays ON unless the lane itself runs insecure TLS (the
  // harness-created self-signed ingress of the charmed lane).
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  const insecure = rowEnv.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  const run = sh("docker", [
    "run", "-d", "--rm", "--name", CONSUMER_NAME, "--network", "host",
    ...(extraCa ? ["-v", `${path.resolve(extraCa)}:/extra-ca.pem:ro`, "--env", "SSL_CERT_FILE=/extra-ca.pem"] : []),
    "--entrypoint", "hydra", "ghcr.io/canonical/hydra:25.4.0",
    "perform", "authorization-code", "--no-open", "--no-shutdown", "--port", "4447",
    ...(insecure ? ["--skip-tls-verify"] : []),
    "--client-id", "browser-test-rp", "--client-secret", "browser-test-rp-secret",
    "--endpoint", u.hydraPublic,
    "--auth-url", `${u.loginUi}/oauth2/auth`,
    "--scope", "openid,profile,email,offline_access",
  ]);
  if (run.status !== 0) {
    process.stderr.write(run.stderr ?? "");
    return false;
  }
  return true;
}

function stopConsumer() {
  sh("docker", ["rm", "-f", CONSUMER_NAME]);
}

// ── Row execution: deploy/attach → preflight → seed → suite → verdict ────────

/** --attach configures an EXISTING deployment (terraform import + adopt/transition
 *  applies); --plan-only stops at the drift report without mutating anything. */
function deployPhase(rowName, backend, { attach, planOnly }) {
  if (attach) {
    console.log(planOnly ? "── drift gate (attach, plan-only)" : "── attach (adopt + transition)");
    return attachJuju(rowName, { planOnly });
  }
  if (backend === "urls") {
    console.log("── deploy: SKIPPED (urls backend - external deployment, declaration gating still applies)");
    return true;
  }
  console.log("── deploy");
  const ok = backend === "juju" ? deployJuju(rowName) : deployCompose(rowName);
  if (!ok) console.error("✗ deploy failed");
  return ok;
}

/** The deployment must MATCH the declaration or nothing runs. The verifier runs
 *  in-process, so the lane's TLS policy must reach process.env (node reads
 *  NODE_TLS_REJECT_UNAUTHORIZED per connection) — for this call only: `--all`
 *  must not carry one row's insecure policy into the next row or its children. */
async function preflightPhase(rowName, backend, rowEnv) {
  const { verifyRow } = await import("./verify.mjs");
  console.log("── preflight");
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (rowEnv.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = rowEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  try {
    return await verifyRow(rowName, backend, rowEnv);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

/** Seed fresh against the row. In the live-lane subset nothing can be seeded,
 *  so the suite runs with BROWSER_TEST_LANE=live. */
function seedPhase(rowName, capsPath, rowEnv, liveLane) {
  fs.copyFileSync(capsPath, path.join(BROWSER_DIR, "active-config.json"));
  if (liveLane) {
    console.log("── seed: SKIPPED (no KRATOS_ADMIN_URL - live-lane subset)");
    return true;
  }
  console.log("── seed");
  const seed = sh("npx", ["tsx", "seeder/seed.ts", "--fresh", "--profile", rowName], {
    cwd: BROWSER_DIR,
    env: { ...process.env, ...rowEnv },
  });
  if (seed.status !== 0) {
    process.stdout.write(seed.stdout ?? "");
    process.stderr.write(seed.stderr ?? "");
    console.error("✗ seeding failed");
    return false;
  }
  return true;
}

/** Expected execution set from the same declaration + satisfies(), computed in
 *  the same lane the run uses (getExecutionLane() reads BROWSER_TEST_LANE). */
function expectedSet(capsPath, laneEnv) {
  const res = sh("npx", ["tsx", "scripts/expected-set.ts", capsPath], {
    cwd: BROWSER_DIR,
    env: { ...process.env, ...laneEnv },
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? "");
    console.error("✗ expected-set computation failed");
    return null;
  }
  return JSON.parse(res.stdout);
}

/** Single Playwright run (retries pinned to 0 by the config). Returns per-test
 *  outcomes, or null when the run itself is unusable. */
function playwrightRun(capsPath, rowEnv, laneEnv) {
  const run = sh("npx", ["playwright", "test", "--reporter=json"], {
    cwd: BROWSER_DIR,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...rowEnv,
      ...(rowEnv.LOGIN_UI_URL ? { BASE_URL: rowEnv.LOGIN_UI_URL } : {}),
      ...laneEnv,
      BROWSER_TEST_CAPABILITIES: capsPath,
    },
  });
  let report;
  try {
    const start = run.stdout?.indexOf("{") ?? -1;
    report = JSON.parse(start === -1 ? "{}" : run.stdout.slice(start));
  } catch {
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    console.error("✗ could not parse the Playwright JSON report");
    return null;
  }
  if ((report.errors ?? []).length > 0) {
    for (const e of report.errors) console.error(`✗ run-level error: ${e.message}`);
    return null;
  }
  return collectTests(report);
}

/** Browser suite under the row's declaration, with the RP consumer container
 *  where the lane needs one. Returns `{ tests, expected }` or null. */
function suitePhase(rowName, backend, capsPath, rowEnv, liveLane) {
  const u = resolveUrls(rowEnv, backend);
  // juju always runs the consumer; urls runs it unless OIDC_CONSUMER_URL names an external one.
  const wantConsumer = backend === "juju" || (backend === "urls" && !!u.hydraPublic && !u.oidcConsumer);
  if (wantConsumer) {
    if (!startConsumer(u, rowEnv)) {
      console.error("✗ could not start the OIDC consumer container");
      return null;
    }
    if (backend === "urls") rowEnv.OIDC_CONSUMER_URL = CONSUMER_URL;
  } else if (backend === "urls") {
    console.log("── consumer: SKIPPED (urls backend, no HYDRA_PUBLIC_URL) — authorization_code journeys will fail unless OIDC_CONSUMER_URL points at an externally running consumer");
  }
  try {
    const laneEnv = liveLane ? { BROWSER_TEST_LANE: "live" } : {};
    const expected = expectedSet(capsPath, laneEnv);
    if (!expected) return null;
    console.log(`── test (expecting ${expected.run.length} scenario executions, ${expected.skip.length} declared skips)`);
    const tests = playwrightRun(capsPath, rowEnv, laneEnv);
    return tests ? { tests, expected } : null;
  } finally {
    if (wantConsumer) stopConsumer();
  }
}

/** Expected-set verdict: executed set vs declaration, every problem named. */
function verdictPhase(rowName, tests, expected) {
  const failures = classifyOutcome(tests, expected);
  const executed = tests.filter((t) => t.status !== "skipped").length;
  const skipped = tests.length - executed;
  if (failures.length > 0) {
    console.error(`✗ row ${rowName}: ${failures.length} problem(s) (${executed} executed, ${skipped} skipped):`);
    for (const f of failures) console.error(`    ${f}`);
    return false;
  }
  console.log(`✓ row ${rowName}: ${executed} executed (matching the declaration exactly), ${skipped} declared skips, 0 failures`);
  return true;
}

async function runRow(rowName, backend) {
  const capsPath = path.join(HERE, "rows", rowName, "capabilities.json");
  if (!fs.existsSync(capsPath)) {
    console.error(`✗ no such materialized row: ${rowName}`);
    return false;
  }
  console.log(`\n═══ matrix row: ${rowName} (${backend}) ═══`);

  const attach = process.argv.includes("--attach");
  const planOnly = process.argv.includes("--plan-only");
  if (!deployPhase(rowName, backend, { attach, planOnly })) return false;
  if (attach && planOnly) return true;

  // Row env is threaded explicitly, never merged into process.env: `--all`
  // would otherwise make row 1's discovered URLs sticky for later rows.
  const publicJuju = backend === "juju" && attach && process.env.MATRIX_JUJU_PUBLIC === "1";
  const rowEnv = publicJuju ? publicJujuEnv() : backend === "juju" ? jujuEnv() : backend === "urls" ? urlsEnv() : {};
  if (!(await preflightPhase(rowName, backend, rowEnv))) return false;

  // Without an admin URL the run is the live-lane subset: nothing is seeded, MANIFEST is read.
  const liveLane = (backend === "urls" || publicJuju) && !resolveUrls(rowEnv, backend).kratosAdmin;
  if (!seedPhase(rowName, capsPath, rowEnv, liveLane)) return false;

  // Deploy + preflight + seed are the deployment-validation contract; skipping
  // the browser leg is loud, never silent.
  if (backend === "juju" && process.env.MATRIX_JUJU_BROWSER === "0") {
    console.log("── browser leg: SKIPPED (MATRIX_JUJU_BROWSER=0)");
    console.log(`✓ row ${rowName}: deployed, verified against declaration, seeded (${backend})`);
    return true;
  }

  const outcome = suitePhase(rowName, backend, capsPath, rowEnv, liveLane);
  if (!outcome) return false;
  return verdictPhase(rowName, outcome.tests, outcome.expected);
}

// ── Entry (main-guarded so matrix/tests/ can import the pure functions) ─────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {

const args = process.argv.slice(2);
const backend = args.find((a) => a.startsWith("--backend="))?.split("=")[1] ?? process.env.MATRIX_BACKEND ?? "compose";
const target = args.find((a) => !a.startsWith("--"));
const all = args.includes("--all");
if (!target && !all) {
  console.error("usage: node matrix/run-row.mjs <row-name> [--backend=compose|juju|urls] [--attach [--plan-only]] | --all [--backend=…]");
  process.exit(2);
}
// Value-checked controller guard, reached before the watchdog spawn and any
// terraform/juju process (terraform-provider-juju resolves the controller the same way).
if (backend === "juju") {
  assertController();
}
if (backend === "urls" && !process.env.LOGIN_UI_URL) {
  console.error("✗ urls backend requires LOGIN_UI_URL to be set explicitly (the urls backend has no discovery — env is the whole interface)");
  process.exit(2);
}
// Checked here, not in publicJujuEnv(): by then the attach applies have already run.
if (backend === "juju" && args.includes("--attach") && process.env.MATRIX_JUJU_PUBLIC === "1" && !process.env.LOGIN_UI_URL) {
  console.error("✗ MATRIX_JUJU_PUBLIC=1 needs LOGIN_UI_URL (the deployment's public ingress)");
  process.exit(2);
}
if (args.includes("--attach") && backend !== "juju") {
  console.error("✗ --attach is a juju-backend mode (attaches to an existing charmed deployment)");
  process.exit(2);
}

const matrix = JSON.parse(fs.readFileSync(path.join(HERE, "matrix.json"), "utf-8"));
const { rows, outOfScope, noArtifact } = selectRows(matrix, backend, all ? null : target);
if (outOfScope.length > 0 && !all) {
  const row = outOfScope[0];
  console.error(`✗ ${row.name} is bound to the ${row.backends.join("|")} backend (its declared capabilities describe an external target no ${backend} deployment can render) — run it with --backend=${row.backends[0]}`);
  process.exit(2);
}
if (noArtifact.length > 0 && !all) {
  const row = noArtifact[0];
  console.error(`✗ ${row.name} has no ${backend} artefact under matrix/rows/${row.name}/ (a null dimension is a pinned profile's off-charm shape the ${backend} lane cannot render — see lib.mjs rowArtifacts) — pick a row whose every dimension is on-model`);
  process.exit(2);
}

// Juju rows run under the observer-only model journal (matrix/watchdog.mjs);
// spawned here so no invocation path can forget it. It never mutates the model.
let watchdog = null;
if (backend === "juju") {
  watchdog = spawn(process.execPath, [path.join(HERE, "watchdog.mjs")], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

// Nightly baseline: postgres survives reconfiguration, so one volume-dropping
// reset makes the night deterministic. Only `--all` + compose: a single-row run
// never tears down an operator's stack, and the charmed backend is never touched.
if (all && backend === "compose") {
  const first = rows[0];
  console.log(`── nightly baseline: docker compose down --volumes, then up (row ${first})`);
  const reset = sh("make", ["matrix-baseline", `ROW=${first}`], { cwd: REPO });
  if (reset.status !== 0) {
    process.stdout.write(reset.stdout ?? "");
    process.stderr.write(reset.stderr ?? "");
    console.error("✗ nightly baseline reset failed — refusing to run the lane on unknown state");
    process.exit(1);
  }
}

const verdicts = [];
try {
  for (const row of rows) {
    verdicts.push({ row, ok: await runRow(row, backend) });
  }
} finally {
  watchdog?.kill("SIGTERM");
}

if (all) {
  console.log("\n═══ matrix verdict ═══");
  for (const v of verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.row}`);
  // Out of scope is not a skip: listed so the lane's row list equals the model's (docs/testing-spec.md §4).
  for (const r of outOfScope) console.log(`  — ${r.name} (bound to the ${r.backends.join("|")} backend; not a ${backend} row)`);
  for (const r of noArtifact) console.log(`  — ${r.name} (no ${backend} artefact materialized; a null dimension is off-charm)`);
}
process.exit(verdicts.every((v) => v.ok) ? 0 : 1);

}
