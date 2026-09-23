// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

// Only the SPA's own data requests can re-init a Flow. Fonts, images and stylesheets
// are excluded: login-ui pulls its font from assets.ubuntu.com, and a stalled CDN
// must not stall the suite (the reason `networkidle` is not used here).
const DATA_RESOURCE_TYPES = new Set(["document", "fetch", "xhr"]);
const QUIET_MS = 500;
const SETTLE_TIMEOUT_MS = 15_000;

const inFlight = new WeakMap<Page, Set<Request>>();

/** Idempotent. Attach before the context's first navigation (framework/test.ts does). */
export function trackDataRequests(context: BrowserContext): void {
  const watch = (page: Page) => {
    if (inFlight.has(page)) return;
    const pending = new Set<Request>();
    inFlight.set(page, pending);
    page.on("request", (r) => {
      if (DATA_RESOURCE_TYPES.has(r.resourceType())) pending.add(r);
    });
    page.on("requestfinished", (r) => pending.delete(r));
    page.on("requestfailed", (r) => pending.delete(r));
  };
  context.pages().forEach(watch);
  context.on("page", watch);
}

/** Resolve once the page's data requests have been quiet for QUIET_MS; fail naming what is still pending. */
export async function waitForDataRequestsSettled(page: Page): Promise<void> {
  const pending = inFlight.get(page);
  if (!pending) {
    throw new Error(
      "page's context is not request-tracked: import `test` from framework/test, " +
        "or call trackDataRequests() on a context made with browser.newContext()",
    );
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let quietSince = pending.size === 0 ? Date.now() : Infinity;
  while (Date.now() - quietSince < QUIET_MS) {
    if (Date.now() > deadline) {
      const urls = [...pending].map((r) => `${r.method()} ${r.url()}`).join(", ");
      throw new Error(`data requests did not settle within ${SETTLE_TIMEOUT_MS}ms; still pending: ${urls}`);
    }
    await page.waitForTimeout(50);
    if (pending.size > 0) quietSince = Infinity;
    else if (quietSince === Infinity) quietSince = Date.now();
  }
}

// Type per keystroke once data requests settle so the value lands in React state
// (a plain fill() racing Flow's re-init submits an empty field). Never retry.
export async function fillSettledField(
  page: Page,
  field: Locator,
  value: string,
): Promise<void> {
  await waitForDataRequestsSettled(page);
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
