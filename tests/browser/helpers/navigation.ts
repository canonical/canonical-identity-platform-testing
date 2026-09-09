// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Agent-friendly navigation helpers.
 *
 * These helpers provide descriptive step names and clear waits,
 * making them suitable for both human-written tests and
 * agent-generated tests (via the browser-test-generation skill).
 *
 * Design principles:
 * - Every step has a human-readable description
 * - Waits are explicit and generous (agent-driven navigation may be slow)
 * - Errors include the current URL for debugging
 */

import { Page, expect } from "@playwright/test";

/**
 * Select a tenant by name on the tenant selection page.
 */
export async function selectTenant(page: Page, tenantName: string): Promise<void> {
  const button = page.getByRole("button", { name: tenantName });
  await expect(button).toBeVisible({ timeout: 5_000 });
  await button.click();
}

/**
 * List the tenant names offered on the tenant selection page.
 *
 * Options render as `listitem > button`; the only other list on the page is
 * the (empty) header navigation, so scoping to listitems isolates them.
 */
export async function listTenantOptions(page: Page): Promise<string[]> {
  const buttons = page.getByRole("listitem").getByRole("button");
  await expect(buttons.first()).toBeVisible({ timeout: 5_000 });
  return (await buttons.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

