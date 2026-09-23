// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";

export async function clickButton(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", {
      name,
      exact: true,
    })
    .click();
}

// Two entry shapes ("Sign in" after TOTP method switch, "Use backup recovery code"
// when lookup_secret is the only factor); wait on the field, heading text is ambiguous.
export async function verifyBackupCode(
  page: Page,
  backupCode: string,
): Promise<void> {
  const field = page.getByLabel("Backup recovery code");
  await expect(field).toBeVisible();
  await field.fill(backupCode);
  await page
    .getByRole("button", { name: "Use backup recovery code", exact: true })
    .or(page.getByRole("button", { name: "Sign in", exact: true }))
    .first()
    .click();
}
