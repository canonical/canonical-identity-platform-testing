// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test } from "../framework/test";
import { resilienceScenarios } from "../scenarios/resilience-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of resilienceScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
