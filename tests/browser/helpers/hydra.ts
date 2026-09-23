// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";
import { OIDC_CONSUMER_URL, HYDRA_PUBLIC_URL, LOGIN_UI_URL } from "./config";

export async function buildAuthorizeUrl(
  page: Page,
  extraParams: Record<string, string>,
): Promise<string> {
  await page.goto(OIDC_CONSUMER_URL + "/");
  const link = page.getByRole("link", { name: "Authorize application" });
  await expect(link).toBeVisible();

  const href = await link.getAttribute("href");
  if (!href) throw new Error("authorize link has no href");

  // The consumer runs in Docker and links to hydra:4444, which the host browser cannot resolve.
  const url = new URL(href);
  if (url.hostname === "hydra") {
    url.hostname = "localhost";
  }
  const expectedOrigins = [HYDRA_PUBLIC_URL, LOGIN_UI_URL].map((u) => new URL(u).origin);
  if (!expectedOrigins.includes(url.origin)) {
    throw new Error(
      `OIDC consumer at ${OIDC_CONSUMER_URL} issues authorize URLs on ${url.origin}, ` +
      `but this run targets ${expectedOrigins.join(" / ")}. The consumer belongs to a different ` +
      `deployment — point OIDC_CONSUMER_URL at a consumer configured for this one ` +
      `(the urls/juju matrix backends start theirs on 127.0.0.1:4447).`,
    );
  }
  // oidc_debug may inject a default max_age; callers that need it pass { max_age: "0" }.
  url.searchParams.delete("max_age");
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function startOIDCFlowWithParams(
  page: Page,
  extraParams: Record<string, string>,
): Promise<void> {
  const url = await buildAuthorizeUrl(page, extraParams);
  await page.goto(url);
}
