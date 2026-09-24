// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Requires Chrome (channel: 'chrome') with anti-detection args, a real Workspace test
// account with TOTP 2FA, and the "google-user" seeder archetype (seeder/archetypes.ts).

import { Page, Request, errors, expect } from "@playwright/test";
import { generateTotpCode } from "./totp";

export async function enterGoogleEmail(page: Page, email: string): Promise<void> {
  const emailInput = page.locator("#identifierId");
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  await page.getByRole("button", { name: "Next" }).click();
}

export async function enterGooglePassword(page: Page, password: string): Promise<void> {
  const passwordInput = page.locator('input[type="password"]:visible').first();
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);

  await page.getByRole("button", { name: "Next" }).click();
}

export async function enterGoogleTotp(page: Page, totpSecret: string): Promise<void> {
  const code = await generateTotpCode(totpSecret);

  const totpInput = page.locator("#totpPin");
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await totpInput.fill(code);

  await page.getByRole("button", { name: "Next" }).click();
}

// Post-TOTP pages Google may show (confirm "Next", consent "Allow", interstitial "Do this later"), then leave Google.
export async function confirmGoogleIdentity(page: Page): Promise<void> {
  const nextButton = page.getByRole("button", { name: /next|continue/i });
  const nextVisible = await nextButton.isVisible().catch(() => false);
  if (nextVisible) {
    await nextButton.click();
  } else {
    const submitButton = page.locator('button[type="submit"]').first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click();
    }
  }

  try {
    const allowButton = page.getByRole("button", { name: /allow/i });
    await expect(allowButton).toBeVisible({ timeout: 5_000 });
    await expect(allowButton).toBeEnabled({ timeout: 5_000 });
    await allowButton.click();
  } catch {
    // no consent page
  }

  try {
    const doThisLater = page.getByText("Do this later");
    await expect(doThisLater).toBeVisible({ timeout: 5_000 });
    await doThisLater.click();
  } catch {
    // no interstitial
  }

  await page.waitForURL(
    (url) => !url.toString().includes("accounts.google.com"),
    { timeout: 30_000 },
  );
}

export async function dismissGoogleInterstitial(page: Page): Promise<void> {
  const doThisLater = page.getByText("Do this later");
  const isVisible = await doThisLater.isVisible().catch(() => false);

  if (isVisible) {
    await doThisLater.click();
  }
}

const GOOGLE_HOP_TIMEOUT_MS = 15_000;

// Clicks "Sign in with Google" on the 1FA page and waits for the hop to Google; the caller handles the rest.
export async function clickGoogleLoginButton(page: Page): Promise<void> {
  const googleButton = page.getByRole("button", { name: /sign in with google/i });
  await expect(googleButton).toBeVisible({ timeout: 10_000 });

  const submit = watchLoginSubmit(page);
  try {
    // "domcontentloaded": an existing Google session redirects back too fast for "load".
    await Promise.all([
      page.waitForURL(/accounts\.google\.com/, { timeout: GOOGLE_HOP_TIMEOUT_MS, waitUntil: "domcontentloaded" }),
      googleButton.click(),
    ]);
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    // A bare waitForURL timeout reads the same for a slow page, a product bug and a deployment
    // whose Kratos cannot reach the provider; what the login submit got tells them apart.
    throw new Error(`Google sign-in never reached accounts.google.com: ${submit.describe()}`);
  } finally {
    submit.stop();
  }
}

/** Records the provider login submit (POST /self-service/login) that the button click sends. */
function watchLoginSubmit(page: Page): { describe(): string; stop(): void } {
  let sent = false;
  let status: number | undefined;
  let location = "";
  let failure: string | undefined;
  const isSubmit = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname.endsWith("/self-service/login");
  const onRequest = (r: Request) => { if (isSubmit(r)) sent = true; };
  const onFailed = (r: Request) => { if (isSubmit(r)) failure = r.failure()?.errorText ?? "unknown error"; };
  const onResponse = (res: { request(): Request; status(): number; headers(): Record<string, string> }) => {
    if (!isSubmit(res.request())) return;
    status = res.status();
    const to = res.headers()["location"];
    location = to ? ` → ${new URL(to, res.request().url()).host}` : "";
  };
  page.on("request", onRequest);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  const seconds = GOOGLE_HOP_TIMEOUT_MS / 1000;
  return {
    describe: () => {
      if (!sent) return "the click sent no login submit (POST /self-service/login)";
      if (status !== undefined) {
        return `the login submit (POST /self-service/login) answered HTTP ${status}${location}, but the page stayed on ${new URL(page.url()).host}`;
      }
      if (failure) return `the login submit (POST /self-service/login) failed in the browser: ${failure}`;
      return `the login submit (POST /self-service/login) got no response within ${seconds}s — Kratos never answered with the redirect to the provider`;
    },
    stop: () => {
      page.off("request", onRequest);
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
    },
  };
}
