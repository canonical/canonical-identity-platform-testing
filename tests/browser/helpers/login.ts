// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";
import { clickSubmit, fillSettledField, waitForDataRequestsSettled } from "./form";

export async function enterEmail(page: Page, email: string): Promise<void> {
  // `?flow=` reaches the URL only on login-ui > v0.25.0; race it with the data requests
  // settling so older versions do not report a healthy deployment as a 15s timeout.
  await Promise.race([
    page.waitForURL(/[?&]flow=/, { timeout: 15_000 }).catch(() => {}),
    waitForDataRequestsSettled(page).catch(() => {}),
  ]);

  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await fillSettledField(page, page.getByLabel("Email"), email);

  // A 5xx on the identifier submit renders nothing in the UI; capture it so the failure names the server.
  const submitted = page
    .waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/self-service\/login(\/id-first)?(\?|$)/.test(r.url()),
      { timeout: 15_000 },
    )
    .catch(() => null);
  await continueButton.click();

  const response = await submitted;
  if (response && response.status() >= 500) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `the deployment refused the identifier submit: ${response.status()} ` +
        `POST ${new URL(response.url()).pathname} -> ${body}\n` +
        `    Nothing is rendered to the user for this, so it is invisible in the UI too. ` +
        `A login-ui before v0.26.0 posts the identifier step to the GENERIC ` +
        `/self-service/login endpoint instead of /self-service/login/id-first, and kratos ` +
        `rejects that body (password: "") with exactly this.`,
    );
  }

  // The step re-renders in place; Continue disappearing marks the transition.
  // A validation message means the identifier was rejected: surface it.
  await expect(
    page.getByText(
      /Please enter your email address\.|Enter a valid email address\./,
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeHidden({ timeout: 10_000 });
}

export async function enterPassword(
  page: Page,
  password: string,
  opts?: { doubleSubmit?: boolean },
): Promise<void> {
  await fillSettledField(
    page,
    page.getByRole("textbox", { name: "Password" }),
    password,
  );
  await clickSubmit(
    page.getByRole("button", { name: "Sign in", exact: true }),
    { double: opts?.doubleSubmit },
  );
}

// Single-/zero-tenant login; multi-tenant callers use enterEmail + selection + enterPassword.
export async function loginWithPassword(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await enterEmail(page, email);
  await enterPassword(page, password);
}
