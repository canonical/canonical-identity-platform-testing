// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test } from "../framework/test";
import { errorScenarios } from "../scenarios/error-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of errorScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
