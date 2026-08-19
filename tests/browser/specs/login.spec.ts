// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Login scenario-driven browser tests.
 *
 * Generated from the login scenario suite. Each scenario becomes a
 * test() call that invokes runScenario() with the scenario.
 */

import { test } from "@playwright/test";
import { loginScenarios } from "../scenarios/login-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of loginScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
