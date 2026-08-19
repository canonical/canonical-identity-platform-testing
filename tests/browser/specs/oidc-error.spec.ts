// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OIDC authorize-error scenario-driven browser tests (testing-spec §10
 * item 9: the error matrix).
 *
 * Generated from the oidc-error scenario suite. Each scenario becomes a
 * test() call that invokes runScenario() with the scenario.
 */

import { test } from "@playwright/test";
import { oidcErrorScenarios } from "../scenarios/oidc-error-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of oidcErrorScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
