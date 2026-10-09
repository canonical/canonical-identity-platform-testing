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

/** One browser-history traversal back to the nearest earlier entry whose URL contains `urlPart`.
 *  The caller names the page the Back button lands on when the entries in between were never
 *  interacted with (Chrome skips those); `page.goBack()` would stop on each of them. The runner's
 *  state poll waits for the navigation. Chromium only (CDP). */
export async function backToHistoryEntry(page: Page, urlPart: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    const target = entries
      .slice(0, currentIndex)
      .reverse()
      .find((entry) => entry.url.includes(urlPart));
    if (!target) {
      throw new Error(
        `backToHistoryEntry: no earlier history entry with URL containing "${urlPart}" ` +
        `(history: ${entries.slice(0, currentIndex + 1).map((e) => e.url.split("?")[0]).join(" → ")})`,
      );
    }
    await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Opens the login request's address again (`/ui/login?login_challenge=…`), with the challenge read
 *  from the browser history. Chromium only (CDP). */
export async function reopenLoginRequest(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  let target: URL | undefined;
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    for (const entry of entries.slice(0, currentIndex + 1).reverse()) {
      const url = URL.canParse(entry.url) ? new URL(entry.url) : undefined;
      if (url?.searchParams.has("login_challenge") && url.pathname.endsWith("/login")) {
        target = url;
        break;
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (!target) {
    throw new Error("reopenLoginRequest: no login page with a login_challenge in the browser history");
  }
  const challenge = target.searchParams.get("login_challenge") as string;
  await page.goto(`${target.origin}${target.pathname}?login_challenge=${encodeURIComponent(challenge)}`, {
    waitUntil: "load",
  });
}
