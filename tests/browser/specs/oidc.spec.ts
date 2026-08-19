// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OIDC scenario-driven browser tests.
 *
 * canonical-internal is the only profile that enables OIDC/WebAuthn sequencing,
 * and there every OIDC login is diverted to security-key enrolment for AAL2
 * before it can reach the callback. The suite is chosen HERE, at collection
 * time, from the app-config globalSetup already cached — that keeps exactly one
 * test per journey on every profile. Doing it with test.skip() would leave the
 * unused variant reported as skipped on every run.
 */

import { test } from "@playwright/test";
import { oidcScenarios, oidcSequencingScenarios } from "../scenarios/oidc-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { isOidcSequencingEnabledSync } from "../helpers/config";
import { WebAuthnHelper } from "../helpers/webauthn";

const suite = isOidcSequencingEnabledSync() ? oidcSequencingScenarios : oidcScenarios;

test.describe("OIDC scenarios", () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.setup();
  });

  for (const scenario of suite.scenarios) {
    test(scenario.id, async ({ page }) => {
      await runScenario(page, scenario, { webauthn });
    });
  }
});
