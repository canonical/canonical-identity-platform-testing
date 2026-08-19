// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Hydra OAuth2 helpers.
 *
 * Ported from tenant-service/tests/browser/helpers/hydra.ts.
 * Provides utilities to build custom authorize URLs with additional parameters
 * (e.g. max_age=0 for forced re-authentication).
 */

import { Page, expect } from "@playwright/test";
import { OIDC_CONSUMER_URL } from "./config";

/**
 * Extract the authorize URL from the OIDC consumer page link,
 * then append extra query parameters (e.g. { max_age: "0" }).
 *
 * Returns the full authorize URL with the extra params.
 */
export async function buildAuthorizeUrl(
  page: Page,
  extraParams: Record<string, string>,
): Promise<string> {
  await page.goto(OIDC_CONSUMER_URL + "/");
  const link = page.getByRole("link", { name: "Authorize application" });
  await expect(link).toBeVisible();

  const href = await link.getAttribute("href");
  if (!href) throw new Error("authorize link has no href");

  // The OIDC consumer runs inside Docker and generates authorize URLs using
  // the internal Docker hostname (e.g., http://hydra:4444). The browser
  // runs on the host and cannot resolve Docker hostnames, so we rewrite
  // the URL to use localhost instead.
  const url = new URL(href);
  if (url.hostname === "hydra") {
    url.hostname = "localhost";
  }
  // Strip max_age from the base URL (oidc_debug may inject a default).
  // Callers that need it pass { max_age: "0" } explicitly.
  url.searchParams.delete("max_age");
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Start an OIDC authorization-code flow with custom query parameters.
 * Navigates to the authorize URL with the extra params.
 * After this call the browser should be on the Kratos login page
 * (unless session reuse applies).
 */
export async function startOIDCFlowWithParams(
  page: Page,
  extraParams: Record<string, string>,
): Promise<void> {
  const url = await buildAuthorizeUrl(page, extraParams);
  await page.goto(url);
}
