// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Requires Chrome (channel: 'chrome') with anti-detection args, a real Workspace test
// account with TOTP 2FA, and the "google-user" seeder archetype (seeder/archetypes.ts).

import { Page, expect } from "@playwright/test";
import { generateTotpCode } from "./totp";

export async function enterGoogleEmail(page: Page, email: string): Promise<void> {
  const emailInput = page.locator("#identifierId");
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  await page.getByRole("button", { name: "Next" }).click();
}

export async function enterGooglePassword(page: Page, password: string): Promise<void> {
  const passwordInput = page.locator('input[type="password"]:visible').first();
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);

  await page.getByRole("button", { name: "Next" }).click();
}

export async function enterGoogleTotp(page: Page, totpSecret: string): Promise<void> {
  const code = await generateTotpCode(totpSecret);

  const totpInput = page.locator("#totpPin");
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await totpInput.fill(code);

  await page.getByRole("button", { name: "Next" }).click();
}

// Post-TOTP pages Google may show (confirm "Next", consent "Allow", interstitial "Do this later"), then leave Google.
export async function confirmGoogleIdentity(page: Page): Promise<void> {
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

  try {
    const allowButton = page.getByRole("button", { name: /allow/i });
    await expect(allowButton).toBeVisible({ timeout: 5_000 });
    await expect(allowButton).toBeEnabled({ timeout: 5_000 });
    await allowButton.click();
  } catch {
    // no consent page
  }

  try {
    const doThisLater = page.getByText("Do this later");
    await expect(doThisLater).toBeVisible({ timeout: 5_000 });
    await doThisLater.click();
  } catch {
    // no interstitial
  }

  await page.waitForURL(
    (url) => !url.toString().includes("accounts.google.com"),
    { timeout: 30_000 },
  );
}

export async function dismissGoogleInterstitial(page: Page): Promise<void> {
  const doThisLater = page.getByText("Do this later");
  const isVisible = await doThisLater.isVisible().catch(() => false);

  if (isVisible) {
    await doThisLater.click();
  }
}

// Clicks "Sign in with Google" on the 1FA page and waits for the hop to Google; the caller handles the rest.
export async function clickGoogleLoginButton(page: Page): Promise<void> {
  const googleButton = page.getByRole("button", { name: /sign in with google/i });
  await expect(googleButton).toBeVisible({ timeout: 10_000 });

  // "domcontentloaded": an existing Google session redirects back too fast for "load".
  await Promise.all([
    page.waitForURL(/accounts\.google\.com/, { timeout: 15_000, waitUntil: "domcontentloaded" }),
    googleButton.click(),
  ]);
}
