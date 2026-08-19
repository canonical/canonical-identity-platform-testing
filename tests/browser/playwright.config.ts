// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { PlaywrightTestConfig } from "@playwright/test";
import { devices } from "@playwright/test";

/**
 * Unified Playwright configuration for the Canonical Identity Platform.
 *
 * Environment variables (all optional, with sensible defaults):
 *   BASE_URL           — Base URL for the login UI (default: http://localhost:4433)
 *   OIDC_CONSUMER_URL  — OIDC consumer app URL (default: http://127.0.0.1:4446)
 *   KRATOS_ADMIN_URL   — Kratos admin API (default: http://localhost:4434)
 *   KRATOS_PUBLIC_URL  — Kratos public API (default: http://localhost:4433)
 *   HYDRA_ADMIN_URL    — Hydra admin API (default: http://localhost:4445)
 *   HYDRA_PUBLIC_URL   — Hydra public API (default: http://localhost:4444)
 *   TENANT_SERVICE_URL — Tenant service API (default: http://localhost:8081)
 *   MAIL_API_URL       — Mailslurper JSON service API (default: http://localhost:4437)
 *   DEX_URL            — Dex OIDC provider (default: http://dex:5556)
 *   BROWSER_TEST_CAPABILITIES — Declared capabilities file (matrix/rows/<row>/capabilities.json);
 *                        when set, the declaration drives all gating (static mode)
 *
 * Workers is set to 1 because Kratos state is shared across tests
 * (sessions, identities) and parallel execution causes conflicts.
 *
 * Retries are pinned to 0 in every environment. A test that only passes on
 * retry is flaky, and flakiness must fail the gate rather than be absorbed.
 */
const INSECURE_TLS = process.env.BROWSER_TEST_INSECURE_TLS === "1";

// Chromium flags every project needs. Compose ("dex" resolves to the host
// port), sandboxing, and — only when the lane opted into insecure TLS —
// --ignore-certificate-errors: `ignoreHTTPSErrors` covers navigation, but
// WebAuthn refuses ceremonies on origins with cert errors unless the BROWSER
// trusts them, and a self-signed ingress is the charmed lane's reality.
const SHARED_LAUNCH_ARGS = [
  // Map "dex" hostname to 127.0.0.1 so the browser can reach the Dex OIDC
  // provider running in Docker (exposed on host port 5556).
  "--host-resolver-rules=MAP dex 127.0.0.1",
  "--no-sandbox",
  ...(INSECURE_TLS ? ["--ignore-certificate-errors"] : []),
];

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
    baseURL: process.env.BASE_URL || "http://localhost:4433",
    // TLS verification is ON unless the lane explicitly opts out. The matrix
    // runner sets BROWSER_TEST_INSECURE_TLS=1 only for substrates that really
    // do terminate TLS with a self-signed CA (see insecureTlsEnv() in
    // matrix/run-row.mjs); the compose gate never sets it, so verification is
    // real there.
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
          // Merge, never replace: an own args array here silently drops
          // --ignore-certificate-errors, which breaks WebAuthn against the
          // charmed lane's self-signed ingress in this project only.
          args: [...SHARED_LAUNCH_ARGS, "--disable-blink-features=AutomationControlled"],
        },
      },
    },
  ],
};

export default config;
