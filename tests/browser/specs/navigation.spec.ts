// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * In-page Back navigation tests.
 *
 * These are NOT part of the transition graph — they test login-ui affordances
 * the scenario runner does not model, so they stay imperative.
 *
 * They deliberately do NOT use `page.goBack()`. Browser history is not the
 * login-ui's state machine: the flow steps use `router.replace`, so most
 * transitions create no history entry at all (going back from the register or
 * recovery bootstrap lands on `about:blank`), and where an entry does exist it
 * is an artefact of the OAuth redirect chain whose replay depends on bfcache
 * eligibility. Asserting browser-back would test an anti-feature, flakily.
 *
 * What the product actually ships is two distinct in-page Back buttons:
 *   - FlowBackButton      — `router.replace` stripping `?flow=`, restarting the
 *                           flow in place without touching history.
 *   - ResetEmailBackButton — `window.history.back()`, which re-creates the login
 *                           flow, so the identifier step is what comes back.
 * One test each.
 */

import { test, expect } from "@playwright/test";
import { assertPageState } from "../helpers/page-state";
import { readManifest } from "../framework/manifest";
import { buildAuthorizeUrl } from "../helpers/hydra";
import { enterEmail } from "../helpers/login";
import { startRegistrationFlow } from "../helpers/kratos";
import { getExecutionLane, localUsersEnabled } from "../helpers/config";

// LIVE_LANE_INTERNAL_ONLY: this spec uses an internal flow bootstrap.

test.describe("In-page Back navigation", () => {
  test.beforeEach(() => {
    test.skip(getExecutionLane() === "live", "Internal-only spec in live lane");
    // Both tests drive password-flow pages (registration password step,
    // recovery reset-email) — surfaces that do not exist when the deployment
    // has no local IdP.
    test.skip(!localUsersEnabled(), "local users (password flows) not in the active profile");
  });

  test("Back on register-password restarts the registration flow", async ({
    page,
  }) => {
    await startRegistrationFlow(page);
    await assertPageState(page, "register-email");

    // Only the identifier is submitted — no identity is created, so this is
    // safe to repeat across runs.
    await page.getByLabel(/e-?mail/i).first().fill("nav-probe@test.example");
    await page.getByRole("button", { name: /next|sign up/i }).click();
    await assertPageState(page, "register-password");

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await assertPageState(page, "register-email");
  });

  test("Back on reset-email returns to the login page", async ({ page }) => {
    const user = readManifest().users.find((u) => u.ref === "returning-mfa");
    expect(
      user,
      'manifest is missing archetype "returning-mfa" — re-run make seed-test-data-clean',
    ).toBeDefined();

    await page.goto(await buildAuthorizeUrl(page, {}));
    await assertPageState(page, "login-email");

    await enterEmail(page, user!.email);
    await assertPageState(page, "login-password");

    await page.getByRole("link", { name: "Reset password" }).click();
    await assertPageState(page, "reset-email");

    // history.back() re-creates the login flow, so the identifier step is what
    // returns — not the password step the user left.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await assertPageState(page, "login-email");
  });
});
