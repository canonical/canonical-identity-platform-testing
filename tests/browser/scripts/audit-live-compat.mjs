#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const specsDir = path.join(root, "specs");
const scenariosDir = path.join(root, "scenarios");

/**
 * Simple live-lane compatibility audit.
 *
 * It intentionally focuses on active specs (excluding archive/) and checks
 * for known unsafe patterns in live runs.
 */
const forbiddenPatterns = [
  {
    name: "hardcoded localhost URL",
    re: /https?:\/\/localhost/i,
  },
  {
    name: "direct kratos helper import in spec",
    re: /from\s+["'][^"']*helpers\/kratos["']/,
  },
  {
    name: "direct recovery bootstrap call",
    re: /startRecoveryFlow\s*\(/,
  },
  {
    name: "direct verification bootstrap call",
    re: /startVerificationFlow\s*\(/,
  },
  {
    name: "direct registration bootstrap call",
    re: /startRegistrationFlow\s*\(/,
  },
];

function walkSpecs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "archive") continue;
      out.push(...walkSpecs(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(specsDir)) {
  console.error(`Specs directory not found: ${specsDir}`);
  process.exit(1);
}
if (!fs.existsSync(scenariosDir)) {
  console.error(`Scenarios directory not found: ${scenariosDir}`);
  process.exit(1);
}

const files = walkSpecs(specsDir);
const violations = [];

for (const filePath of files) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("LIVE_LANE_INTERNAL_ONLY")) {
    continue;
  }
  for (const pattern of forbiddenPatterns) {
    if (pattern.re.test(content)) {
      violations.push({
        file: path.relative(root, filePath),
        issue: pattern.name,
      });
    }
  }
}

for (const entry of fs.readdirSync(scenariosDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith("-scenarios.ts")) continue;
  const filePath = path.join(scenariosDir, entry.name);
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("defineScenarioSuite(") && !content.includes("defaultLanes")) {
    violations.push({
      file: path.relative(root, filePath),
      issue: "missing defaultLanes on scenario suite",
    });
  }
}

if (violations.length > 0) {
  console.error("Live compatibility audit failed:");
  for (const v of violations) {
    console.error(`- ${v.file}: ${v.issue}`);
  }
  process.exit(1);
}

console.log(`Live compatibility audit passed (${files.length} active spec files checked).`);
