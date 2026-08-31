// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Device-flow scenario-driven browser tests.
 *
 * Generated from the device scenario suite. Each scenario becomes a
 * test() call that invokes runScenario() with the scenario.
 */

import { test } from "@playwright/test";
import { deviceScenarios } from "../scenarios/device-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of deviceScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
