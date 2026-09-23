// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { PlaywrightTestConfig } from "@playwright/test";
import { devices } from "@playwright/test";

const INSECURE_TLS = process.env.BROWSER_TEST_INSECURE_TLS === "1";

// `ignoreHTTPSErrors` covers navigation only; WebAuthn refuses origins with cert errors unless the browser trusts them.
const SHARED_LAUNCH_ARGS = [
  "--host-resolver-rules=MAP dex 127.0.0.1",
  "--no-sandbox",
  ...(INSECURE_TLS ? ["--ignore-certificate-errors"] : []),
];

// workers: 1 / fullyParallel: false — Kratos state is shared across tests. retries: 0 — a test
// that only passes on retry is flaky and must fail the gate. None of these three ever change.
const config: PlaywrightTestConfig = {
  globalSetup: require.resolve("./framework/global-setup"),
  testDir: "./specs",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    actionTimeout: 10_000,
    baseURL: process.env.BASE_URL || process.env.LOGIN_UI_URL || "http://localhost",
    ignoreHTTPSErrors: INSECURE_TLS,
    video: "retain-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: [...SHARED_LAUNCH_ARGS] },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /google-oidc/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "google-oidc",
      testMatch: /google-oidc/,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        launchOptions: {
          // Merge, never replace: an own args array here silently drops --ignore-certificate-errors.
          args: [...SHARED_LAUNCH_ARGS, "--disable-blink-features=AutomationControlled"],
        },
      },
    },
  ],
};

export default config;
