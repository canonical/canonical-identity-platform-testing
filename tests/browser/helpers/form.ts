// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { expect, type Locator, type Page } from "@playwright/test";

// Type per keystroke after networkidle so the value lands in React state
// (a plain fill() racing Flow's re-init submits an empty field). Never retry.
export async function fillSettledField(
  page: Page,
  field: Locator,
  value: string,
): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect(field).toBeVisible();
  await field.pressSequentially(value, { delay: 10 });
  await expect(field).toHaveValue(value);
}

/** `double` models a double-click submit. Both outcomes pass — the second click
 *  swallowed by a guard, or landed and absorbed; the runner's next-state
 *  assertion is the judge. */
export async function clickSubmit(
  button: Locator,
  opts?: { double?: boolean },
): Promise<void> {
  await button.click();
  if (opts?.double) {
    try {
      await button.click({ timeout: 500 });
    } catch {
      // Button detached or disabled before the second click; guard worked.
    }
  }
}
