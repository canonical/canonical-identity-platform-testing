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
 * retrying the fill: the network must be quiet, and the flow id must be in the
 * URL on the versions that put it there. After that a dropped value is a real
 * product regression and must fail loudly, so the fill is asserted once and
 * never retried.
 */
export async function enterEmail(page: Page, email: string): Promise<void> {
  // The flow id reaches the URL only on login-ui versions that perform the
  // shallow router.replace(?flow=…). Waiting for it unconditionally made this
  // helper time out on a deployment that never does — measured on teal
  // (login-ui <= v0.25.0, 2026-08-28): the URL stays /ui/login forever, so a
  // BROKEN DEPLOYMENT was reported as a 15s wait inside a harness helper.
  // Race it against the condition that actually matters, a quiet network;
  // fillSettledField remains the loud guard for a value that does not stick.
  await Promise.race([
    page.waitForURL(/[?&]flow=/, { timeout: 15_000 }).catch(() => {}),
    page.waitForLoadState("networkidle"),
  ]);

  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await fillSettledField(page, page.getByLabel("Email"), email);

  // Which server refused, and with what. The identifier submit is the one hop
  // where a 5xx renders NOTHING in the UI (teal: 500 `invalid password` with an
  // empty alert region), so without this the only symptom is "Continue is still
  // visible" — a description of the page, not of the fault.
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
