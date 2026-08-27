// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Google OIDC scenario-driven browser tests.
 *
 * The Google test identity is seeded by the seeder (see
 * tests/browser/seeder/archetypes.ts — "google-user") which creates
 * a Kratos identity with a pre-linked OIDC credential. The test reads
 * the user from the manifest — it does NOT use the Kratos admin API.
 *
 * Google credentials come from environment variables:
 *   - GOOGLE_TEST_EMAIL
 *   - GOOGLE_TEST_PASSWORD
 *   - GOOGLE_TEST_TOTP_SECRET
 *   - GOOGLE_TEST_SUBJECT_ID (the Google `sub` claim — used by the
 *     seeder to link the OIDC credential)
 *
 * These tests require:
 *   - The `google-oidc` Playwright project (uses real Chrome with anti-detection)
 *   - Chrome installed on the test machine
 *   - The `canonical-internal` profile with Google OIDC provider configured
 *   - A Google Cloud project with OAuth2 client credentials
 *
 * The redirect URI to register in Google Cloud Console is:
 *   http://localhost:4433/self-service/methods/oidc/callback/google
 */

import { test } from "@playwright/test";
import { googleOidcScenarios } from "../scenarios/google-oidc-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { readManifest } from "../framework/manifest";
import {
  googleCredentialsAvailable,
  isOidcProviderInProfile,
  isOidcSequencingEnabled,
} from "../helpers/config";
import { WebAuthnHelper } from "../helpers/webauthn";

// Skip the entire file if Google credentials are not available
test.describe("Google OIDC", () => {
  test.skip(!googleCredentialsAvailable(), "Google credentials not available (set GOOGLE_TEST_EMAIL, GOOGLE_TEST_PASSWORD, GOOGLE_TEST_TOTP_SECRET, GOOGLE_TEST_SUBJECT_ID)");
  test.skip(
    !isOidcProviderInProfile("google") && !isOidcProviderInProfile("google_canonical"),
    "Google OIDC provider not in active profile",
  );

  // Set up a CDP-based virtual authenticator for WebAuthn ceremonies.
  // This is needed for the OIDC sequencing flow where the user must
  // register a security key after authenticating via Google.
  // We use the Chrome DevTools Protocol (CDP) directly because
  // Playwright's addVirtualAuthenticator() does NOT work with
  // channel: 'chrome' (real Chrome).
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.setup();
  });

  for (const scenario of googleOidcScenarios.scenarios) {
    test(scenario.id, async ({ page }) => {
      // Exactly one variant per journey runs per profile: when sequencing is on
      // the flow diverts to setup-passkey after Google auth, so the
      // non-sequencing expected paths cannot match, and vice versa.
      //
      // `test.skip(true, …)` throws, so control does not continue — but relying
      // on that is invisible to a reader and to any future refactor that
      // catches. Return explicitly.
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
      // Credentials-absent is already handled by the file-level skip above, so
      // reaching here with no seeded google-user means the SEEDER failed —
      // throw, never `test.skip`: a missing archetype is a seeder failure, and
      // a skip for it is a quarantine in disguise that turns a partial seed
      // into a green run. The seeder is strict (R-9); this is the other half.
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
