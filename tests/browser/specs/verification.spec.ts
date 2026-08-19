// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Verification scenario-driven browser tests.
 *
 * Generated from the verification scenario suite.
 * Tests Kratos email verification flows using Mailslurper for code retrieval.
 */

import { test } from "@playwright/test";
import { verificationScenarios } from "../scenarios/verification-scenarios";
import { runScenario } from "../framework/scenario-runner";

for (const scenario of verificationScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    await runScenario(page, scenario);
  });
}
