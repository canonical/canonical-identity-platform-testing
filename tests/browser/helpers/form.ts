// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Form-entry helpers for the login-ui.
 *
 * The login-ui renders Kratos flows through a controlled React form: its `Flow`
 * component keeps a value map and re-initialises it from the flow's node values
 * whenever the flow object identity changes. Several things change that
 * identity shortly after a step paints — the `/api/v0/app-config` fetch, the
 * shallow `router.replace(?flow=…)`, and the response to the previous submit.
 *
 * A plain `locator.fill()` racing that reconciliation writes the DOM value but
 * not React state, so the form submits an EMPTY field and the flow either
 * re-renders the same step or is rejected by Kratos for a missing property.
 * That race is the single root cause behind several long-standing "the page
 * just didn't advance" failures across login, recovery and verification.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Fill a login-ui form field so the value survives into React state.
 *
 * Waits for in-flight requests to settle first (that is what triggers the
 * reconciliation), types per character so each keystroke fires its own change
 * event, then asserts the value stuck. Deliberately does NOT retry: once the
 * flow has settled, a dropped value is a real regression and must fail loudly.
 */
export async function fillSettledField(
  page: Page,
  field: Locator,
  value: string,
): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect(field).toBeVisible();
  await field.pressSequentially(value, { delay: 10 });
  await expect(field).toHaveValue(value);
}

/**
 * Click a submit button, optionally twice in quick succession.
 *
 * The double click models the canonical "weird user behavior" on a slow
 * network. The contract under test is user-visible: a double click must
 * never break the journey. Two outcomes are acceptable and both pass:
 *  - the UI guard (Flow.tsx drops re-entrant submits while isLoading) or the
 *    ensuing navigation removes/disables the button, so the second click
 *    cannot land — double submission is impossible;
 *  - the second click lands and the platform absorbs it without derailing
 *    the walk (the runner's NEXT state assertion is the real judge).
 * What must NOT happen is the walk ending somewhere else — a swallowed
 * second POST bouncing the user to manage_details, a raw CSRF error page —
 * and that is exactly what the runner's following assertions fail on.
 */
export async function clickSubmit(
  page: Page,
  button: Locator,
  opts?: { double?: boolean },
): Promise<void> {
  await button.click();
  if (opts?.double) {
    try {
      await button.click({ timeout: 500 });
    } catch {
      // Button detached or disabled before the second click could land —
      // the guard worked; nothing to do.
    }
  }
}
