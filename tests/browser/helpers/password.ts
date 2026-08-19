// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Password reset helpers.
 *
 * Ported from login-ui/ui/tests/helpers/password.ts.
 */

import { Page, expect } from "@playwright/test";
import { fillSettledField } from "./form";

/**
 * Enter a new password on the reset password form.
 */
export async function enterNewPassword(
  page: Page,
  password: string,
): Promise<void> {
  // "Reset password" is simultaneously the h1, the submit button and, on the
  // login page, a link — so bind to the heading rather than to any text match.
  await expect(
    page.getByRole("heading", { name: "Reset password" }),
  ).toBeVisible();

  const newPassword = page.getByLabel("New password", { exact: true });
  const confirmPassword = page.getByLabel("Confirm New password");
  await fillSettledField(page, newPassword, password);
  await fillSettledField(page, confirmPassword, password);
  // Re-assert the first field: filling the second can trigger a reconciliation
  // that clears the first, and submitting then posts an empty password.
  await expect(newPassword).toHaveValue(password);

  await page.getByRole("button", { name: "Reset password" }).click();
}

/**
 * Fill the registration password form and advance.
 *
 * The form renders two password fields — "Password" and "Confirm Password"
 * (login-ui components/Password.tsx) — and `getByRole` matches names by
 * substring, so "Password" alone is ambiguous. `Next` also stays disabled until
 * the two values match AND the first field has blurred, and filling the confirm
 * field is what produces that blur, so the order here is load-bearing.
 */
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
