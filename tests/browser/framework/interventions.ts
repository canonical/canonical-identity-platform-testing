// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Executable half of `Intervention` data: deterministic browser perturbations
 *  applied at a named state of a scenario walk. Scenarios only declare
 *  `interventions:`; the runner dispatches here. */

import { test, expect, Page } from "@playwright/test";
import { assertPageState } from "../helpers/page-state";
import { resendVerificationCode } from "../helpers/resend";
import { deleteIdentityCredentialType } from "../helpers/kratos";
import type { ManifestUser } from "../seeder/manifest-schema";
import type { StateIntervention } from "./scenario-types";
import { assertInternalLane, type ActionContext } from "./transitions";

/** Past any legitimate login history chain; hitting it means the entry does not exist. */
const MAX_HISTORY_BACKS = 10;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

export async function runStateIntervention(
  page: Page,
  iv: StateIntervention,
  user: ManifestUser,
  ctx: ActionContext,
): Promise<void> {
  switch (iv.do) {
    case "reload":
      await test.step(`Intervention: reload at ${iv.at} (state must survive F5)`, async () => {
        await page.reload({ waitUntil: "load" });
        await assertPageState(page, iv.at);
      });
      return;

    case "replay-current-url":
      await test.step(`Intervention: replay current URL at ${iv.at}`, async () => {
        const url = page.url();
        await page.goto(url, { waitUntil: "load" });
        await settle(page);
        await assertPageState(page, iv.expect!);
        if (iv.expectUrlContains) {
          expect(page.url()).toContain(iv.expectUrlContains);
        }
      });
      return;

    case "history-back":
      await test.step(`Intervention: history back to "${iv.untilUrl}" from ${iv.at}`, async () => {
        let reached = false;
        for (let i = 0; i < MAX_HISTORY_BACKS; i++) {
          const nav = await page.goBack({ waitUntil: "load" }).catch(() => null);
          await settle(page);
          if (page.url().includes(iv.untilUrl!)) {
            reached = true;
            break;
          }
          // Null with no URL change means history is exhausted; a forward bounce keeps backing.
          if (nav === null) break;
        }
        if (!reached) {
          throw new Error(
            `history-back: no history entry with URL containing "${iv.untilUrl}" ` +
            `within ${MAX_HISTORY_BACKS} steps (ended on ${page.url()})`,
          );
        }
        // assertPageState polls, so the platform's auto-resolve redirect chain may still be in flight.
        await assertPageState(page, iv.expect!);
        if (iv.expectUrlContains) {
          await expect
            .poll(() => page.url(), { timeout: 10_000 })
            .toContain(iv.expectUrlContains);
        }
      });
      return;

    case "history-roundtrip":
      await test.step(
        `Intervention: browser Back → ${iv.via}, Forward → ${iv.at} (walk continues)`,
        async () => {
          // goBack() may return null on a same-document popstate; the polling state assertion is the judge.
          await page.goBack().catch(() => null);
          await settle(page);
          await assertPageState(page, iv.via!);

          await page.goForward().catch(() => null);
          await settle(page);
          await assertPageState(page, iv.at);
        },
      );
      return;
    case "resend-code":
      await test.step(`Intervention: resend code at ${iv.at}`, async () => {
        assertInternalLane(ctx, "Resend-code intervention (reads Mailslurper)");
        const { cursor } = await resendVerificationCode(page, user.email, ctx.mailCursor);
        // Re-anchor the walk so its code-submit can only resolve the resent mail.
        ctx.mailCursor = cursor;
        await assertPageState(page, iv.at);
      });
      return;

    case "drop-totp-out-of-band":
      await test.step(`Intervention: drop TOTP credential out-of-band at ${iv.at}`, async () => {
        assertInternalLane(ctx, "Out-of-band TOTP credential removal (admin API)");
        // Admin-side perturbation; the page is untouched and later states observe the loss.
        if (!user.identityId) {
          throw new Error(`drop-totp-out-of-band: no identityId for user "${user.ref}"`);
        }
        await deleteIdentityCredentialType(user.identityId, "totp");
        await assertPageState(page, iv.at);
      });
      return;
  }
}
