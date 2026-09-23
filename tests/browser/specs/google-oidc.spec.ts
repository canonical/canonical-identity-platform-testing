// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Google OIDC scenarios; needs the `google-oidc` project, real Chrome, and GOOGLE_TEST_* env vars. */

import { test } from "../framework/test";
import { googleOidcScenarios } from "../scenarios/google-oidc-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { readManifest } from "../framework/manifest";
import {
  googleCredentialsAvailable,
  isOidcProviderInProfile,
  isOidcSequencingEnabled,
} from "../helpers/config";
import { WebAuthnHelper } from "../helpers/webauthn";

test.describe("Google OIDC", () => {
  test.skip(!googleCredentialsAvailable(), "Google credentials not available (set GOOGLE_TEST_EMAIL, GOOGLE_TEST_PASSWORD, GOOGLE_TEST_TOTP_SECRET, GOOGLE_TEST_SUBJECT_ID)");
  test.skip(
    !isOidcProviderInProfile("google") && !isOidcProviderInProfile("google_canonical"),
    "Google OIDC provider not in active profile",
  );

  // CDP virtual authenticator: Playwright's addVirtualAuthenticator() does not work with channel: 'chrome'.
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.setup();
  });

  for (const scenario of googleOidcScenarios.scenarios) {
    test(scenario.id, async ({ page }) => {
      const sequencingEnabled = await isOidcSequencingEnabled();
      const requiresSequencing = scenario.requires?.oidcSequencing === true;
      if (sequencingEnabled && !requiresSequencing) {
        test.skip(true, "OIDC sequencing is enabled — use google-oidc-sequencing scenario instead");
        return;
      }
      if (!sequencingEnabled && requiresSequencing) {
        test.skip(true, "OIDC sequencing is not enabled — scenario requires it");
        return;
      }

      const manifest = readManifest();
      // Missing archetype with credentials present means the seeder failed: throw, never test.skip.
      if (!manifest.users.some((u) => u.ref === "google-user")) {
        throw new Error(
          "google-user is missing from the seed manifest while Google credentials ARE available — " +
            "the seeder did not complete. Re-run `make seed-test-data-clean` and read its output.",
        );
      }

      await runScenario(page, scenario, { webauthn });
    });
  }
});
