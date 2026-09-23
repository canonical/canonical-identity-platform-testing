// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test } from "@playwright/test";
import { settingsScenarios } from "../scenarios/settings-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of settingsScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
