// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";
import { DEX_USER_EMAIL, DEX_USER_PASSWORD } from "./test-credentials";
import { isDexUrl } from "./page-state";

export async function loginWithDex(page: Page, email: string = DEX_USER_EMAIL): Promise<void> {
  const emailInput = page.locator("#login");
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  const passwordInput = page.locator("#password");
  await passwordInput.fill(DEX_USER_PASSWORD);

  await page.locator("button[type=submit]").click();
}

export async function clickDexLoginButton(page: Page): Promise<void> {
  // End-anchored: the accessible name includes the logo alt ("dex logo Sign in with Dex"), and a substring would also match dex2.
  const dexButton = page.getByRole("button", { name: /sign in with dex$/i });
  await expect(dexButton).toBeVisible({ timeout: 10_000 });
  await Promise.all([
    page.waitForURL((url) => isDexUrl(url.href), { timeout: 15_000 }).catch(() => {
    }),
    dexButton.click(),
  ]);
}
