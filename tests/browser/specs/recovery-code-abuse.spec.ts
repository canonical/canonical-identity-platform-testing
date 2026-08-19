// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Recovery-code abuse: the cross-browser case.
 *
 * Hand-written rather than declared as a Scenario because it needs TWO browser
 * contexts at once — the scenario runner walks one page — which is the standing
 * exception for behaviour the state-transition model cannot express (the other
 * is browser back/forward, now covered by interventions).
 *
 * What it defends: recovery codes are bound to the FLOW that issued them
 * (`UseRecoveryCode(ctx, f.ID, code)` matches per-flow), not to the account. A
 * user who starts recovery on their phone and types the emailed code into a
 * fresh recovery flow on their laptop is therefore rejected — and the message
 * they get says "invalid or already used", which names neither the real cause
 * nor a remedy. That is a real support-load path, and nothing asserted it.
 *
 * The in-flow half of the same mechanism (max_submissions cap) is declared as
 * `recovery:code-brute-force-cap`; this spec covers only what needs two
 * browsers.
 */

import { expect, test } from "@playwright/test";
import { readManifest, findUserByRef } from "../framework/manifest";
import { startRecoveryFlow } from "../helpers/kratos";
import { isLiveLane, localUsersEnabled } from "../helpers/config";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode } from "../helpers/mail";
import type { Page } from "@playwright/test";

test.describe("recovery code abuse", () => {
  test.beforeEach(() => {
    // Internal-only: bootstraps a Kratos flow directly and reads Mailslurper.
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

    // Browser A: start recovery and read the code Kratos emails for ITS flow.
    const cursorA = await mailCursor(user.email);
    await startRecoveryToCodeStep(page, user.email);
    const codeFromA = await waitForMailCode({
      recipient: user.email,
      subject: MAIL_SUBJECTS.recovery,
      seen: cursorA,
    });

    // Browser B: an independent recovery flow for the same identity. Waiting
    // for B's own mail is what proves B is genuinely at its own code step
    // before we feed it A's code.
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

      // Rejected, visibly: Kratos cannot find that code for THIS flow.
      await expect(
        pageB.getByText(/invalid or has already been used|invalid|already been used/i).first(),
      ).toBeVisible({ timeout: 15_000 });

      // And no privilege was granted: B never reaches the settings page, and no
      // session lands it on the self-serve account page.
      expect(pageB.url()).not.toContain("reset_password");
      expect(pageB.url()).not.toContain("manage_details");
      await expect(pageB.getByLabel("Recovery code")).toBeVisible();
    } finally {
      await contextB.close();
    }
  });
});
