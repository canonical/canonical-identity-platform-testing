// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";

export async function selectTenant(page: Page, tenantName: string): Promise<void> {
  const button = page.getByRole("button", { name: tenantName });
  await expect(button).toBeVisible({ timeout: 5_000 });
  await button.click();
}

// Options render as `listitem > button`; scoping to listitems skips the header nav.
export async function listTenantOptions(page: Page): Promise<string[]> {
  const buttons = page.getByRole("listitem").getByRole("button");
  await expect(buttons.first()).toBeVisible({ timeout: 5_000 });
  return (await buttons.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

