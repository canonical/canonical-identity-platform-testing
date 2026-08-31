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

/** Verify identity using a backup recovery code.
 *
 * Two entry shapes render this form (observed 2026-08-31):
 *  - method switch from TOTP verify: heading "Verify your identity",
 *    submit button "Sign in";
 *  - direct entry for an identity whose ONLY second factor is lookup_secret
 *    (the post-unlink state): heading "Sign in", submit button
 *    "Use backup recovery code".
 * The "Backup recovery code" field is unique to the state, so waiting on it
 * replaces the old heading assertion (PageLayout renders the title into both
 * the <h1> and Next.js's route announcer, so heading text is also ambiguous).
 */
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
