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
import { OIDC_CONSUMER_URL } from "./config";

/**
 * Navigate to the OIDC consumer app and start a new authorization flow.
 * This is the standard entry point for most E2E tests.
 */
export async function navigateToOIDCConsumer(page: Page): Promise<void> {
  await page.goto(OIDC_CONSUMER_URL + "/");
  await expect(page.getByRole("link", { name: "Authorize application" })).toBeVisible();
}

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

/**
 * Wait for the OIDC callback page to load.
 * Returns the callback URL for further inspection.
 */
export async function waitForOIDCCallback(page: Page): Promise<string> {
  await page.waitForURL(/\/callback\?/, { timeout: 30_000 });
  return page.url();
}

/**
 * Navigate to the backup codes setup page.
 * Requires an active session.
 */
export async function navigateToBackupCodesSetup(page: Page): Promise<void> {
  await page.goto("/ui/setup_backup_codes");
}

/**
 * Get the current page state as a human-readable description.
 * Useful for agent debugging and step-by-step test generation.
 */
export async function describeCurrentPage(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title();
  const headings = await page.locator("h1, h2").allTextContents();
  return `URL: ${url}\nTitle: ${title}\nHeadings: ${headings.join(" | ")}`;
}
