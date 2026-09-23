// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test as base, type BrowserContext } from "@playwright/test";
import { trackDataRequests } from "../helpers/form";
import { maskSecretsOnScreen } from "./secret-mask";

export { expect } from "@playwright/test";

/** Request tracking and the on-screen secret mask, before the context's first navigation. */
export async function instrumentContext(context: BrowserContext): Promise<void> {
  trackDataRequests(context);
  await maskSecretsOnScreen(context);
}

// Every spec imports `test` from here so each context is instrumented before its first
// navigation; contexts made with `browser.newContext()` call instrumentContext() themselves.
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ context }, use) => {
    await instrumentContext(context);
    await use(context);
  },
});
