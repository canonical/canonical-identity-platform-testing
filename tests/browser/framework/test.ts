// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test as base, type BrowserContext } from "@playwright/test";
import { trackDataRequests } from "../helpers/form";

export { expect } from "@playwright/test";

// Every spec imports `test` from here so each context is tracked before its first
// navigation; contexts made with `browser.newContext()` call trackDataRequests() themselves.
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ context }, use) => {
    trackDataRequests(context);
    await use(context);
  },
});
