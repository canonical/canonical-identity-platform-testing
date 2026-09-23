// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Expected run/skip set for a declared capabilities file, using the same suite data and
// `satisfies()` the runner applies. Tier-B specs (runtime predicates) are not listed;
// the matrix runner judges them by the skip-reason allowlist instead.

import * as fs from "node:fs";
import { satisfies } from "../framework/requires";
import type { ActiveConfig } from "../framework/active-config";
import type { ScenarioSuite } from "../framework/scenario-types";
import { getExecutionLane } from "../helpers/config";

import { accountLinkingScenarios } from "../scenarios/account-linking-scenarios";
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

// oidc.spec.ts selects its suite at collection time from the sequencing flag; mirrored here.
const TIER_A: [string, ScenarioSuite][] = [
  ["specs/account-linking.spec.ts", accountLinkingScenarios],
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
