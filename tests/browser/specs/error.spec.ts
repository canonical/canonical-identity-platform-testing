// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Error scenario-driven browser tests.
 *
 * Generated from the error scenario suite.
 */

import { test } from "@playwright/test";
import { errorScenarios } from "../scenarios/error-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of errorScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
