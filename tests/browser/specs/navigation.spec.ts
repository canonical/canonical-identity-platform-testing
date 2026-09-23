// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** In-page Back buttons (FlowBackButton, ResetEmailBackButton); never page.goBack(): flow steps use router.replace, so history is not the state machine. */

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
    test.skip(!localUsersEnabled(), "local users (password flows) not in the active profile");
  });

  test("Back on register-password restarts the registration flow", async ({
    page,
  }) => {
    await startRegistrationFlow(page);
    await assertPageState(page, "register-email");

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

    // history.back() re-creates the login flow, so the identifier step returns, not the password step.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await assertPageState(page, "login-email");
  });
});
