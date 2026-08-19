// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Resilience scenario-driven browser tests (weird user behavior: refresh,
 * double-click, callback replay, history-back).
 *
 * Generated from the resilience scenario suite. Each scenario becomes a
 * test() call that invokes runScenario() with the scenario.
 */

import { test } from "@playwright/test";
import { resilienceScenarios } from "../scenarios/resilience-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of resilienceScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
