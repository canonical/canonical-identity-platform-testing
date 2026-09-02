// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Dex OIDC login helpers.
 *
 * Ported from tenant-service/tests/browser/helpers/dex.ts.
 * Dex runs as a static OIDC provider in the dev Docker Compose stack.
 * The browser reaches it via Chromium's --host-resolver-rules
 * (mapping "dex" → 127.0.0.1, port 5556).
 */

import { Page, expect } from "@playwright/test";
import { createIdentityWithOIDC } from "./kratos";
import { DEX_USER_EMAIL, DEX_USER_ID, DEX_USER_PASSWORD } from "./test-credentials";

/**
 * Register a Kratos identity pre-linked with Dex OIDC credentials.
 *
 * The identity must exist AND have OIDC credentials before the
 * identifier-first login page will show the "Sign in with Dex" button
 * (account enumeration mitigation is off).
 */
export async function registerDexIdentity(): Promise<string> {
  return createIdentityWithOIDC({
    email: DEX_USER_EMAIL,
    provider: "dex",
    subject: DEX_USER_ID,
  });
}

/**
 * Complete the Dex login form (email + password).
 *
 * Assumes the browser has been redirected to Dex's authorization page.
 * With skipApprovalScreen enabled, Dex redirects back immediately
 * after successful login.
 */
export async function loginWithDex(page: Page, email: string = DEX_USER_EMAIL): Promise<void> {
  // Wait for the Dex login form
  const emailInput = page.locator("#login");
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  const passwordInput = page.locator("#password");
  await passwordInput.fill(DEX_USER_PASSWORD);

  await page.locator("button[type=submit]").click();
}

/**
 * Click the "Sign in with Dex" button on the Kratos 1FA page.
 *
 * Must be called AFTER entering the email via `enterEmail()` — the
 * identifier-first flow only shows OIDC buttons on the 1FA page,
 * not on the initial identifier page.
 */
export async function clickDexLoginButton(page: Page): Promise<void> {
  // End-anchored regex. The button's accessible name INCLUDES the logo
  // img alt text ("dex logo Sign in with Dex"), so a full anchor never
  // matches; plain substring matching is ambiguous on providers=2 rows
  // ("Sign in with dex" is a substring of the dex2 button's name too).
  // Ending the match at "dex" excludes "…dex2" and stays case-insensitive.
  const dexButton = page.getByRole("button", { name: /sign in with dex$/i });
  await expect(dexButton).toBeVisible({ timeout: 10_000 });
  // Click and wait for navigation to Dex's page
  await Promise.all([
    page.waitForURL(/:5556|dex:/, { timeout: 15_000 }).catch(() => {
      // If the URL pattern doesn't match (e.g., error redirect), just continue
    }),
    dexButton.click(),
  ]);
}
