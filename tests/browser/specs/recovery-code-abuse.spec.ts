// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Recovery codes are bound to the issuing flow, not the account; needs two browser contexts, so hand-written. */

import { expect, test } from "../framework/test";
import { readManifest, findUserByRef } from "../framework/manifest";
import { startRecoveryFlow } from "../helpers/kratos";
import { isLiveLane, localUsersEnabled } from "../helpers/config";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode } from "../helpers/mail";
import type { Page } from "@playwright/test";

test.describe("recovery code abuse", () => {
  test.beforeEach(() => {
    test.skip(isLiveLane(), "Internal-only spec in live lane");
    test.skip(
      !localUsersEnabled(),
      "requires local users but profile does not enable password identities",
    );
  });

  /** Drive a fresh recovery flow to its code step for `email`. */
  async function startRecoveryToCodeStep(page: Page, email: string): Promise<void> {
    await startRecoveryFlow(page);
    await page.getByLabel(/e-?mail/i).first().fill(email);
    await page.getByRole("button", { name: /reset password|submit/i }).click();
    await expect(page.getByLabel("Recovery code")).toBeVisible({ timeout: 15_000 });
  }

  test("a recovery code is bound to its flow — replaying it in a second browser is rejected", async ({
    page,
    browser,
  }) => {
    const user = findUserByRef(readManifest(), "returning-mfa");

    const cursorA = await mailCursor(user.email);
    await startRecoveryToCodeStep(page, user.email);
    const codeFromA = await waitForMailCode({
      recipient: user.email,
      subject: MAIL_SUBJECTS.recovery,
      seen: cursorA,
    });

    // Waiting for B's own mail proves B is at its own code step before it gets A's code.
    const contextB = await browser.newContext();
    try {
      const pageB = await contextB.newPage();
      const cursorB = await mailCursor(user.email);
      await startRecoveryToCodeStep(pageB, user.email);
      await waitForMailCode({
        recipient: user.email,
        subject: MAIL_SUBJECTS.recovery,
        seen: cursorB,
      });

      await pageB.getByLabel("Recovery code").fill(codeFromA);
      await pageB.getByRole("button", { name: "Submit" }).click();

      await expect(
        pageB.getByText(/invalid or has already been used|invalid|already been used/i).first(),
      ).toBeVisible({ timeout: 15_000 });

      // No privilege granted: B never reaches settings or the account page.
      expect(pageB.url()).not.toContain("reset_password");
      expect(pageB.url()).not.toContain("manage_details");
      await expect(pageB.getByLabel("Recovery code")).toBeVisible();
    } finally {
      await contextB.close();
    }
  });
});
