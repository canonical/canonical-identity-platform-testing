// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * WebAuthn scenario-driven browser tests.
 *
 * Generated from the WebAuthn scenario suite. WebAuthn keys cannot be seeded —
 * each test registers and uses a key within the same browser context.
 *
 * The virtual authenticator is installed over the Chrome DevTools Protocol via
 * `WebAuthnHelper`, the same mechanism `google-oidc.spec.ts` uses. Playwright
 * has no `context.addVirtualAuthenticator()` — that is a Puppeteer API, and the
 * previous `typeof … !== "function"` guard was therefore always true, silently
 * skipping both tests on every run.
 */

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
