// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** WebAuthn keys cannot be seeded: each test registers and uses a key on a CDP virtual authenticator. */

import { test } from "@playwright/test";
import { webauthnScenarios } from "../scenarios/webauthn-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { WebAuthnHelper } from "../helpers/webauthn";

test.describe("WebAuthn scenarios", () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.setup();
  });

  for (const scenario of webauthnScenarios.scenarios) {
    test(scenario.id, async ({ page }) => {
      await runScenario(page, scenario, { webauthn });
    });
  }
});
