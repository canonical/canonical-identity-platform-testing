#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Pairwise covering-array generator for the identity-platform config matrix.
//
//   node matrix/generate.mjs          # regenerate matrix.json + rows/
//   node matrix/generate.mjs --check  # verify artifacts match the model (CI guard)
//
// Deterministic by construction: no timestamps, stable enumeration order,
// greedy tie-breaks resolve to the first candidate in enumeration order.
// Every row — pinned (the gate profiles), seed and generated — is materialized
// as a compose override + a capabilities manifest under rows/. Rows fully on
// the model (no null dims) additionally get juju tfvars; pinned rows holding
// an off-model null value cannot be charm-produced, so they get none.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { model } from "./config-model.mjs";
import { DIMS, VALUES, composeOverride, capabilities, jujuTfvars, rowName } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROWS_DIR = path.join(HERE, "rows");
const MATRIX_PATH = path.join(HERE, "matrix.json");

// ── Validity ────────────────────────────────────────────────────────────────

function isValid(row) {
  return !model.constraints.some((c) =>
    Object.entries(c.forbid).every(([k, v]) => row[k] === v)
  );
}

function* enumerateValidRows() {
  const counters = DIMS.map(() => 0);
  for (;;) {
    const row = Object.fromEntries(DIMS.map((d, i) => [d, VALUES[d][counters[i]]]));
    if (isValid(row)) yield row;
    let i = DIMS.length - 1;
    while (i >= 0 && ++counters[i] === VALUES[DIMS[i]].length) counters[i--] = 0;
    if (i < 0) return;
  }
}

// ── Pair bookkeeping ────────────────────────────────────────────────────────

const pairKey = (d1, v1, d2, v2) =>
  d1 < d2 ? `${d1}=${v1}|${d2}=${v2}` : `${d2}=${v2}|${d1}=${v1}`;

function pairsOf(row) {
  const keys = [];
  for (let i = 0; i < DIMS.length; i++) {
    for (let j = i + 1; j < DIMS.length; j++) {
      const [a, b] = [DIMS[i], DIMS[j]];
      if (row[a] == null || row[b] == null) continue; // null = off-model, no credit
      keys.push(pairKey(a, row[a], b, row[b]));
    }
  }
  return keys;
}

// ── Build the covering array ────────────────────────────────────────────────

function build() {
  const validRows = [...enumerateValidRows()];

  // Achievable pairs = pairs present in at least one valid full row.
  const achievable = new Set();
  for (const row of validRows) for (const k of pairsOf(row)) achievable.add(k);

  // Raw-product pairs excluded by constraints, for the report.
  const excludedPairs = [];
  for (let i = 0; i < DIMS.length; i++) {
    for (let j = i + 1; j < DIMS.length; j++) {
      for (const v1 of VALUES[DIMS[i]]) {
        for (const v2 of VALUES[DIMS[j]]) {
          const k = pairKey(DIMS[i], v1, DIMS[j], v2);
          if (!achievable.has(k)) excludedPairs.push(k);
        }
      }
    }
  }

  const covered = new Set();
  const cover = (row) => {
    let fresh = 0;
    for (const k of pairsOf(row)) {
      if (achievable.has(k) && !covered.has(k)) {
        covered.add(k);
        fresh++;
      }
    }
    return fresh;
  };

  const rows = [];
  for (const p of model.pinned) {
    rows.push({ name: p.name, kind: "pinned", dims: p.dims, newPairs: cover(p.dims) });
  }
  const coveredByPinned = covered.size;

  for (const s of model.seeds) {
    if (!isValid(s.dims)) throw new Error(`seed ${s.name} violates a constraint`);
    rows.push({ name: s.name, kind: "seed", dims: s.dims, newPairs: cover(s.dims) });
  }
  const coveredBySeeds = covered.size - coveredByPinned;

  // Greedy set cover over the remaining pairs.
  while (covered.size < achievable.size) {
    let best = null;
    let bestGain = 0;
    for (const row of validRows) {
      let gain = 0;
      for (const k of pairsOf(row)) if (!covered.has(k)) gain++;
      if (gain > bestGain) {
        best = row;
        bestGain = gain;
      }
    }
    if (!best) throw new Error("no row can cover remaining pairs — constraint bug");
    rows.push({ name: rowName(best), kind: "generated", dims: best, newPairs: cover(best) });
  }

  return {
    generatedBy: "matrix/generate.mjs — edit matrix/config-model.mjs, then `make matrix-generate`",
    modelVersion: model.version,
    dimensions: Object.fromEntries(model.dimensions.map((d) => [d.id, d.values])),
    stats: {
      validRows: validRows.length,
      achievablePairs: achievable.size,
      coveredByPinned,
      coveredBySeeds,
      generatedRows: rows.filter((r) => r.kind === "generated").length,
      totalRows: rows.length,
    },
    excludedPairs,
    rows,
  };
}

// ── Emit / check ────────────────────────────────────────────────────────────

function renderAll() {
  const matrix = build();
  const files = new Map();
  files.set(MATRIX_PATH, JSON.stringify(matrix, null, 2) + "\n");
  for (const row of matrix.rows) {
    const dir = path.join(ROWS_DIR, row.name);
    files.set(path.join(dir, "docker-compose.override.yml"), composeOverride(row.name, row.kind, row.dims) + "\n");
    files.set(path.join(dir, "capabilities.json"), JSON.stringify(capabilities(row.dims), null, 2) + "\n");
    if (Object.values(row.dims).every((v) => v !== null)) {
      files.set(path.join(dir, "juju.tfvars.json"), JSON.stringify(jujuTfvars(row.dims), null, 2) + "\n");
    }
  }
  return { matrix, files };
}

const { matrix, files } = renderAll();

if (process.argv.includes("--check")) {
  const problems = [];
  for (const [file, want] of files) {
    let got = null;
    try {
      got = fs.readFileSync(file, "utf-8");
    } catch {
      problems.push(`missing: ${path.relative(HERE, file)}`);
      continue;
    }
    if (got !== want) problems.push(`stale: ${path.relative(HERE, file)}`);
  }
  if (fs.existsSync(ROWS_DIR)) {
    for (const entry of fs.readdirSync(ROWS_DIR)) {
      const dir = path.join(ROWS_DIR, entry);
      if (![...files.keys()].some((f) => f.startsWith(dir + path.sep))) {
        problems.push(`stray row not in model: rows/${entry}`);
      }
    }
  }
  if (problems.length > 0) {
    console.error("✗ matrix artifacts out of date — run `make matrix-generate`:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`✓ matrix artifacts match the model (${matrix.stats.totalRows} rows, ${matrix.stats.achievablePairs} pairs)`);
} else {
  fs.rmSync(ROWS_DIR, { recursive: true, force: true });
  for (const [file, content] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
  }
  const g = matrix.stats;
  console.log(
    `✓ wrote matrix.json + ${g.totalRows} materialized rows ` +
      `(pairs: ${g.achievablePairs} achievable, ${g.coveredByPinned} via pinned profiles, ` +
      `${g.coveredBySeeds} via seeds, rest via ${g.generatedRows} generated rows)`
  );
}
