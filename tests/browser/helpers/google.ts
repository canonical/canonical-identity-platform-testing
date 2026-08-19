// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Google OIDC login helpers.
 *
 * Automates the Google Sign-in v3 flow for browser tests:
 *   1. Enter email on the identifier page
 *   2. Enter password on the challenge page
 *   3. Enter TOTP code on the 2FA challenge page
 *   4. Dismiss the Workspace interstitial ("Don't get locked out")
 *
 * Prerequisites:
 *   - Chrome browser (channel: 'chrome') with anti-detection args
 *   - Real Google Workspace test account with TOTP 2FA configured
 *   - Environment variables: GOOGLE_TEST_EMAIL, GOOGLE_TEST_PASSWORD,
 *     GOOGLE_TEST_TOTP_SECRET, GOOGLE_TEST_SUBJECT_ID
 *   - The Google test identity must be seeded via the seeder
 *     (see tests/browser/seeder/archetypes.ts — "google-user")
 */

import { Page, expect } from "@playwright/test";
import { generateTotpCode } from "./totp";
import { GOOGLE_TEST_EMAIL, GOOGLE_TEST_PASSWORD, GOOGLE_TEST_TOTP_SECRET } from "./config";

// ---------------------------------------------------------------------------
// Individual step helpers
// ---------------------------------------------------------------------------

/**
 * Step 1: Enter email on the Google sign-in identifier page.
 *
 * Fills the email input (#identifierId) and clicks "Next".
 * The browser should then navigate to the password challenge page.
 */
export async function enterGoogleEmail(page: Page, email: string): Promise<void> {
  const emailInput = page.locator("#identifierId");
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  await page.getByRole("button", { name: "Next" }).click();
}

/**
 * Step 2: Enter password on the Google sign-in password challenge page.
 *
 * Fills the password input and clicks "Next".
 * The browser should then navigate to the TOTP challenge page (if 2FA is enabled).
 */
export async function enterGooglePassword(page: Page, password: string): Promise<void> {
  const passwordInput = page.locator('input[type="password"]:visible').first();
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);

  await page.getByRole("button", { name: "Next" }).click();
}

/**
 * Step 3: Enter TOTP code on the Google 2FA challenge page.
 *
 * Generates a TOTP code from the base32 secret, fills #totpPin,
 * and clicks "Next".
 */
export async function enterGoogleTotp(page: Page, totpSecret: string): Promise<void> {
  const code = await generateTotpCode(totpSecret);

  const totpInput = page.locator("#totpPin");
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await totpInput.fill(code);

  await page.getByRole("button", { name: "Next" }).click();
}

/**
 * Step 4: Confirm identity and complete remaining Google pages.
 *
 * After TOTP verification, Google may show:
 *   1. Identity confirmation page (/signin/oauth/id) — click "Next"
 *   2. Consent page (/signin/oauth/legacy/consent) — click "Allow"
 *   3. Interstitial (/interstitials/) — click "Do this later"
 *
 * This function handles all of these pages in sequence, waiting for
 * the browser to leave Google's domain (redirect to Kratos callback).
 */
export async function confirmGoogleIdentity(page: Page): Promise<void> {
  // Click "Next" on the identity confirmation page
  const nextButton = page.getByRole("button", { name: /next|continue/i });
  const nextVisible = await nextButton.isVisible().catch(() => false);
  if (nextVisible) {
    await nextButton.click();
  } else {
    const submitButton = page.locator('button[type="submit"]').first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click();
    }
  }

  // Handle consent page if it appears
  try {
    const allowButton = page.getByRole("button", { name: /allow/i });
    await expect(allowButton).toBeVisible({ timeout: 5_000 });
    await expect(allowButton).toBeEnabled({ timeout: 5_000 });
    await allowButton.click();
  } catch {
    // No consent page — continue
  }

  // Handle interstitial if it appears
  try {
    const doThisLater = page.getByText("Do this later");
    await expect(doThisLater).toBeVisible({ timeout: 5_000 });
    await doThisLater.click();
  } catch {
    // No interstitial — continue
  }

  // Wait for redirect back to the platform (leave Google's domain)
  await page.waitForURL(
    (url) => !url.toString().includes("accounts.google.com"),
    { timeout: 30_000 },
  );
}

/**
 * Step 6: Dismiss the Google Workspace interstitial page.
 *
 * After TOTP verification, Google may show a "Don't get locked out"
 * interstitial. This clicks "Do this later" to dismiss it.
 */
export async function dismissGoogleInterstitial(page: Page): Promise<void> {
  // The interstitial may or may not appear. Wait briefly for it.
  const doThisLater = page.getByText("Do this later");
  const isVisible = await doThisLater.isVisible().catch(() => false);

  if (isVisible) {
    await doThisLater.click();
  }
}

// ---------------------------------------------------------------------------
// Orchestrated login
// ---------------------------------------------------------------------------

/**
 * Complete the full Google OIDC login flow.
 *
 * Orchestrates: enter email → wait for password page → enter password →
 * wait for TOTP page → enter TOTP → dismiss interstitial → wait for
 * redirect back to the login-ui.
 *
 * Uses credentials from environment variables by default, or accepts
 * explicit parameters.
 */
export async function loginWithGoogle(
  page: Page,
  email?: string,
  password?: string,
  totpSecret?: string,
): Promise<void> {
  const e = email ?? GOOGLE_TEST_EMAIL;
  const p = password ?? GOOGLE_TEST_PASSWORD;
  const t = totpSecret ?? GOOGLE_TEST_TOTP_SECRET;

  if (!e || !p || !t) {
    throw new Error(
      "Google credentials not available. Set GOOGLE_TEST_EMAIL, " +
      "GOOGLE_TEST_PASSWORD, and GOOGLE_TEST_TOTP_SECRET environment variables.",
    );
  }

  // Step 1: Enter email
  await enterGoogleEmail(page, e);

  // Step 2: Wait for password page and enter password
  await page.waitForURL(/\/challenge\/pwd/, { timeout: 15_000 });
  await enterGooglePassword(page, p);

  // Step 3: Wait for TOTP page and enter code
  await page.waitForURL(/\/challenge\/totp/, { timeout: 15_000 });
  await enterGoogleTotp(page, t);

  // Step 4: Dismiss interstitial if it appears
  // The interstitial URL contains /interstitials/ — wait briefly
  try {
    await page.waitForURL(/\/interstitials\//, { timeout: 5_000 });
    await dismissGoogleInterstitial(page);
  } catch {
    // Interstitial didn't appear — that's fine, continue
  }

  // Wait for redirect back to the platform (login-ui or callback)
  // Google redirects to Kratos's callback URL which then redirects
  // to the login-ui or directly to the OIDC callback
  await page.waitForURL(
    (url) => !url.toString().includes("accounts.google.com"),
    { timeout: 30_000 },
  );
}

/**
 * Initiate Google OIDC login from the Kratos login page.
 *
 * Clicks the "Sign in with Google" button on the 1FA page (after
 * the identifier-first step). The identity must already exist in
 * Kratos (seeded via the seeder — "google-user" archetype) so the identifier-first
 * flow shows the OIDC provider buttons.
 *
 * After clicking, the browser redirects to Google's sign-in page.
 * If Google has an existing session (from a previous login), it
 * auto-selects the session and redirects back immediately — the
 * browser briefly visits accounts.google.com then returns to the
 * login-ui or OIDC callback.
 *
 * This function clicks the button and waits for the initial navigation
 * to Google. The caller is responsible for handling what happens after
 * (entering credentials, confirming identity, or waiting for redirect
 * back to the login-ui).
 */
export async function clickGoogleLoginButton(page: Page): Promise<void> {
  const googleButton = page.getByRole("button", { name: /sign in with google/i });
  await expect(googleButton).toBeVisible({ timeout: 10_000 });

  // Click the Google button and wait for navigation to accounts.google.com.
  // The OIDC redirect goes through Kratos → Hydra → Google, which may
  // take a few seconds. We use Promise.all to click and wait concurrently.
  //
  // When Google has an existing session, the browser visits accounts.google.com
  // briefly and then auto-redirects back. waitForURL with "domcontentloaded"
  // is more reliable than the default "load" for catching fast redirects.
  await Promise.all([
    page.waitForURL(/accounts\.google\.com/, { timeout: 15_000, waitUntil: "domcontentloaded" }),
    googleButton.click(),
  ]);
}
