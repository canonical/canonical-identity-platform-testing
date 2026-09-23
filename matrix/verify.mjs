#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Preflight verifier: the RUNNING deployment must match a matrix row's
// declaration before any test may run, or declaration-driven gating would
// silently shrink the executed set after a failed reconfiguration.
//
//   node matrix/verify.mjs <row-name> [--backend=compose|juju|urls]
//
// Layers (matrix/verify/): substrate (did the override/var-file land?),
// probes (does it BEHAVE as declared? the only independent witness),
// self-report (/api/v0/app-config; truthful keys fatal, the rest drift).
// Exit 0 = matches; 1 = drift, every line names dimension/expected/observed; 2 = usage.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rowRunsOn } from "./lib.mjs";
import { assertController } from "./controller-guard.mjs";
import { resolveUrls } from "./verify/urls.mjs";
import { resetResults, recordedResults } from "./verify/record.mjs";
import { verifyCompose, verifyComposeStatusEndpoints, verifyJuju } from "./verify/substrate.mjs";
import { verifyBehavior } from "./verify/probes.mjs";
import { verifySelfReport } from "./verify/self-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function verifyRow(rowName, backend = process.env.MATRIX_BACKEND ?? "compose", rowEnv = {}) {
  // Row env is a PARAMETER and results reset per row: `run-row --all` must not leak row 1 into row 2.
  const u = resolveUrls(rowEnv, backend);
  resetResults();
  const matrix = JSON.parse(fs.readFileSync(path.join(HERE, "matrix.json"), "utf-8"));
  const row = matrix.rows.find((r) => r.name === rowName);
  if (!row) throw new Error(`no such row: ${rowName} (see matrix/matrix.json)`);
  if (row.kind === "pinned") throw new Error(`${rowName} is a pinned profile — it runs through \`make gate\`, not the matrix lane`);
  if (!rowRunsOn(row, backend)) {
    throw new Error(`${rowName} is bound to the ${row.backends.join("|")} backend — its capabilities describe an external target no ${backend} deployment can render`);
  }
  const rawCaps = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "capabilities.json"), "utf-8"));
  // Backend-divergent keys live under a `juju` sub-object; flatten for the active backend.
  const caps = backend === "juju" ? { ...rawCaps, ...(rawCaps.juju ?? {}) } : rawCaps;

  console.log(`Verifying deployment against row: ${rowName} (backend: ${backend})`);
  console.log(`  ${Object.entries(row.dims).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  if (backend === "urls") {
    console.log("layer 1: SKIPPED (urls backend - no substrate access)");
  } else if (backend === "juju") {
    // Refuse juju commands unless the RESOLVED controller is the allowed one (controller-guard.mjs).
    assertController();
    const tfvars = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "juju.tfvars.json"), "utf-8"));
    verifyJuju(row.dims, tfvars);
  } else {
    verifyCompose(row.dims);
    await verifyComposeStatusEndpoints(row.dims, u);
  }
  await verifyBehavior(row.dims, caps, u, backend);
  await verifySelfReport(caps, u);

  const results = recordedResults();
  const failures = results.filter((r) => !r.ok && !r.warn);
  const warnings = results.filter((r) => !r.ok && r.warn);
  console.log(
    `\n${failures.length === 0 ? "✓" : "✗"} ${results.length} checks: ` +
      `${results.filter((r) => r.ok).length} ok, ${failures.length} failed, ${warnings.length} warning(s)`,
  );
  if (failures.length > 0) {
    console.error(`✗ deployment does not match declaration '${rowName}' — refusing to test against it:`);
    for (const f of failures) console.error(`    [${f.layer}] ${f.check}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  return failures.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const backendArg = args.find((a) => a.startsWith("--backend="))?.split("=")[1];
  const rowName = args.find((a) => !a.startsWith("--"));
  if (!rowName) {
    console.error("usage: node matrix/verify.mjs <row-name> [--backend=compose|juju|urls]");
    process.exit(2);
  }
  verifyRow(rowName, backendArg ?? process.env.MATRIX_BACKEND ?? "compose").then((ok) => process.exit(ok ? 0 : 1), (err) => {
    console.error(String(err));
    process.exit(2);
  });
}
