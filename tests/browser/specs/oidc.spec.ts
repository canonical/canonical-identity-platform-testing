// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Suite picked at collection time by sequencing state, so each profile runs exactly one test per journey. */

import { test } from "../framework/test";
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
