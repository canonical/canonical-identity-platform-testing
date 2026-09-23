// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test } from "@playwright/test";
import { accountLinkingScenarios } from "../scenarios/account-linking-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of accountLinkingScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
