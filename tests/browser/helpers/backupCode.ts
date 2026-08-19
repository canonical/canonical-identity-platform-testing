// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Backup recovery code helpers.
 *
 * Ported from login-ui/ui/tests/helpers/backupCode.ts.
 */

import { Page, expect } from "@playwright/test";

/** Click a button by exact name. */
export async function clickButton(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", {
      name,
      exact: true,
    })
    .click();
}

/** Verify identity using a backup recovery code. */
export async function verifyBackupCode(
  page: Page,
  backupCode: string,
): Promise<void> {
  // PageLayout renders the page title into both the <h1> and Next.js's route
  // announcer (<p role="alert" id="__next-route-announcer__">), and clicking
  // "Use backup code instead" does a shallow router.push that populates it.
  // getByText would therefore always resolve 2 elements here.
  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
  await page.getByLabel("Backup recovery code").fill(backupCode);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
