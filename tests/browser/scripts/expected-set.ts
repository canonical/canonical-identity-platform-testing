// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Compute the expected execution set for a declared capabilities file.
 *
 *   npx tsx scripts/expected-set.ts <capabilities.json>
 *
 * For the scenario-driven specs (tier A), which tests run vs. skip is a pure
 * function of the declaration: lane membership plus `satisfies(requires, …)` —
 * the exact predicates `runScenario` applies (unconditionally — `satisfies()`
 * is the runner's only gating predicate). This script imports the same suite
 * data and the same `satisfies` implementation, so it cannot drift from it.
 *
 * Specs with extra runtime predicates (google-oidc's credential checks,
 * hand-written specs) are tier B: they are NOT listed here and are judged by
 * the skip-reason allowlist in the matrix runner instead.
 *
 * Output (JSON, stdout): { lane, run: [{file, id}], skip: [{file, id, reason}] }
 */

import * as fs from "node:fs";
import { satisfies } from "../framework/requires";
import type { ActiveConfig } from "../framework/active-config";
import type { ScenarioSuite } from "../framework/scenario-types";
import { getExecutionLane } from "../helpers/config";

import { deviceScenarios } from "../scenarios/device-scenarios";
import { errorScenarios } from "../scenarios/error-scenarios";
import { oidcErrorScenarios } from "../scenarios/oidc-error-scenarios";
import { loginScenarios } from "../scenarios/login-scenarios";
import { oidcScenarios, oidcSequencingScenarios } from "../scenarios/oidc-scenarios";
import { recoveryScenarios } from "../scenarios/recovery-scenarios";
import { resilienceScenarios } from "../scenarios/resilience-scenarios";
import { registrationScenarios } from "../scenarios/registration-scenarios";
import { sessionScenarios } from "../scenarios/session-scenarios";
import { settingsScenarios } from "../scenarios/settings-scenarios";
import { tenantScenarios } from "../scenarios/tenant-scenarios";
import { verificationScenarios } from "../scenarios/verification-scenarios";
import { webauthnScenarios } from "../scenarios/webauthn-scenarios";

const capabilitiesPath = process.argv[2];
if (!capabilitiesPath) {
  console.error("usage: npx tsx scripts/expected-set.ts <capabilities.json>");
  process.exit(2);
}
const caps = JSON.parse(fs.readFileSync(capabilitiesPath, "utf-8")) as ActiveConfig;
const lane = getExecutionLane();

// Tier-A spec files and the suite each iterates. oidc.spec.ts selects its
// suite at collection time from the sequencing flag — mirrored here from the
// declaration (which IS active-config.json in matrix runs).
const TIER_A: [string, ScenarioSuite][] = [
  ["specs/device.spec.ts", deviceScenarios],
  ["specs/error.spec.ts", errorScenarios],
  ["specs/oidc-error.spec.ts", oidcErrorScenarios],
  ["specs/login.spec.ts", loginScenarios],
  ["specs/oidc.spec.ts", caps.oidc_webauthn_sequencing_enabled ? oidcSequencingScenarios : oidcScenarios],
  ["specs/recovery.spec.ts", recoveryScenarios],
  ["specs/resilience.spec.ts", resilienceScenarios],
  ["specs/registration.spec.ts", registrationScenarios],
  ["specs/session.spec.ts", sessionScenarios],
  ["specs/settings.spec.ts", settingsScenarios],
  ["specs/tenant.spec.ts", tenantScenarios],
  ["specs/verification.spec.ts", verificationScenarios],
  ["specs/webauthn.spec.ts", webauthnScenarios],
];

const run: { file: string; id: string }[] = [];
const skip: { file: string; id: string; reason: string }[] = [];

for (const [file, suite] of TIER_A) {
  for (const scenario of suite.scenarios) {
    const lanes = scenario.lanes ?? ["live", "internal"];
    if (!lanes.includes(lane)) {
      skip.push({ file, id: scenario.id, reason: `scenario not compatible with lane "${lane}"` });
      continue;
    }
    const result = satisfies(scenario.requires ?? {}, caps);
    if (result.met) {
      run.push({ file, id: scenario.id });
    } else {
      skip.push({ file, id: scenario.id, reason: result.reason ?? "requires not satisfied" });
    }
  }
}

console.log(JSON.stringify({ lane, run, skip }, null, 2));
