// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Login page helpers — drive the identifier-first login flow.
 *
 * Ported from tenant-service/tests/browser/helpers/login.ts and
 * login-ui/ui/tests/helpers/login.ts.
 *
 * The identifier-first flow has two steps:
 *   1. Enter email → backend identifies user (may redirect to tenant selection)
 *   2. Enter password → backend authenticates user (1FA)
 *
 * Use `enterEmail` / `enterPassword` individually when tenant selection
 * happens between the two steps, or `loginWithPassword` as a convenience
 * for users where tenant selection is automatic (zero-tenant / single-tenant).
 */

import { Page, expect } from "@playwright/test";
import { clickSubmit, fillSettledField } from "./form";

/**
 * Step 1: Enter email in the identifier-first form and submit.
 * After this, the page may navigate to:
 *   - The password form (zero/single-tenant: auto-selected)
 *   - The tenant selection page (multi-tenant: needs manual selection)
 *   - An OIDC provider button page (user has linked OIDC credentials)
 *   - A webauthn verify page (user has security key configured)
 *
 * login-ui rebuilds `renderFlow` as a fresh object on every render
 * (pages/login.tsx) and Flow.componentDidUpdate resets every field value
 * whenever that object identity changes (components/Flow.tsx -> initializeValues).
 * Two events land shortly after the form first paints and each triggers that
 * reset: the `/api/v0/app-config` fetch, and the shallow
 * `router.replace(?flow=<id>)`. Filling inside that window silently discards
 * the value, Continue submits an empty identifier, and Kratos re-renders the
 * same step with "Please enter your email address.".
 *
 * Both events are observable, so we wait for them to settle rather than
 * retrying the fill: the flow id must be in the URL and the network must be
 * quiet. After that a dropped value is a real product regression and must fail
 * loudly, so the fill is asserted once and never retried.
 */
export async function enterEmail(page: Page, email: string): Promise<void> {
  await page.waitForURL(/[?&]flow=/, { timeout: 15_000 });

  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await fillSettledField(page, page.getByLabel("Email"), email);
  await continueButton.click();

  // The identifier step re-renders in place rather than navigating, so the
  // disappearance of Continue is what marks the transition. A validation
  // message means the identifier was rejected — surface that instead of
  // walking on to a step that never arrived.
  await expect(
    page.getByText(
      /Please enter your email address\.|Enter a valid email address\./,
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeHidden({ timeout: 10_000 });
}

/**
 * Step 2: Enter password and submit. Call this after tenant selection (if any)
 * has completed and the password form is visible.
 */
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
    page,
    page.getByRole("button", { name: "Sign in", exact: true }),
    { double: opts?.doubleSubmit },
  );
}

/**
 * Complete the email + password login through the Kratos identifier-first UI.
 * Works for zero-tenant and single-tenant users where tenant selection is
 * automatic. For multi-tenant users, use enterEmail + manual selection +
 * enterPassword instead.
 */
export async function loginWithPassword(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await enterEmail(page, email);
  await enterPassword(page, password);
}
