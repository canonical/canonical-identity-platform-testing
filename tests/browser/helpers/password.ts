// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";
import { fillSettledField } from "./form";

export async function enterNewPassword(
  page: Page,
  password: string,
): Promise<void> {
  // "Reset password" is also the submit button and a link; bind to the heading.
  await expect(
    page.getByRole("heading", { name: "Reset password" }),
  ).toBeVisible();

  const newPassword = page.getByLabel("New password", { exact: true });
  const confirmPassword = page.getByLabel("Confirm New password");
  await fillSettledField(page, newPassword, password);
  await fillSettledField(page, confirmPassword, password);
  // Filling the second field can reconcile away the first; re-assert it.
  await expect(newPassword).toHaveValue(password);

  await page.getByRole("button", { name: "Reset password" }).click();
}

// `exact`: "Password" substring-matches "Confirm Password". Order matters: Next enables on blur.
export async function fillRegistrationPassword(
  page: Page,
  password: string,
): Promise<void> {
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(password);
  await page
    .getByRole("textbox", { name: "Confirm Password", exact: true })
    .fill(password);

  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled({ timeout: 10_000 });
  await next.click();
}
