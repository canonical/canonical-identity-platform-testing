// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Recovery scenario-driven browser tests.
 *
 * Generated from the recovery scenario suite.
 * Tests password reset flows using Mailslurper for code retrieval.
 */

import { test } from "@playwright/test";
import { recoveryScenarios } from "../scenarios/recovery-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of recoveryScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
