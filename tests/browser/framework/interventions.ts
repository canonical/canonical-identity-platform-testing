// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Intervention primitives — the executable half of `Intervention` data.
 *
 * Each primitive is a deterministic browser perturbation ("weird user
 * behavior") applied at a named point of a scenario walk:
 *
 *  - "reload"             F5. The platform persists `?flow=` via
 *                         router.replace on every flow page, so every state
 *                         must survive a reload — this primitive re-asserts
 *                         the SAME state afterwards.
 *  - "replay-current-url" Re-navigate to the exact current URL. At the RP
 *                         callback this re-sends the authorization code, so
 *                         the expected terminal is the consumer's error
 *                         surface (single-use enforcement, RFC 6749 §10.5).
 *  - "history-back"       Walk browser history backwards (bounded) until the
 *                         URL contains `untilUrl`, then let the platform
 *                         auto-resolve and assert the declared terminal.
 *                         Client-side bounces (consent auto-redirects, login
 *                         skip chains) are settled between steps.
 *
 * Scenarios never call these — they declare `interventions:` and the runner
 * dispatches here, mirroring the transitions/claim-assertions split.
 */

import { test, expect, Page } from "@playwright/test";
import { assertPageState } from "../helpers/page-state";
import { resendVerificationCode } from "../helpers/resend";
import { deleteIdentityCredentialType } from "../helpers/kratos";
import type { ManifestUser } from "../seeder/manifest-schema";
import type { StateIntervention } from "./scenario-types";
import { assertInternalLane, type ActionContext } from "./transitions";

/** Upper bound on history-back steps. A login journey produces a handful of
 *  real history entries (consumer → authorize → login-ui → consent → callback);
 *  ten is comfortably past any legitimate chain, so hitting it means the
 *  target entry does not exist — fail loudly, never spin. */
const MAX_HISTORY_BACKS = 10;

/** Let a client-side redirect chain settle after a history move. Bounded:
 *  a page with no pending redirect passes immediately via `load`. */
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
          // goBack() returning null with no URL change means history is
          // exhausted (or the entry was same-document); if a client-side
          // bounce moved us FORWARD again, keep backing — the loop bound
          // still terminates the walk.
          if (nav === null) break;
        }
        if (!reached) {
          throw new Error(
            `history-back: no history entry with URL containing "${iv.untilUrl}" ` +
            `within ${MAX_HISTORY_BACKS} steps (ended on ${page.url()})`,
          );
        }
        // From the rewound entry the platform auto-resolves (session + stale
        // challenge chains redirect on their own). Assert the declared
        // terminal — assertPageState polls, so the redirect chain may still
        // be in flight here.
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
          // Real browser Back — no router involvement. On the push-based
          // method switch this is a same-document popstate; goBack() may
          // return null there, which is fine: the state assertion is the
          // judge, and it polls.
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
        // The ordering contract (drain original → snapshot → click → wait)
        // and the PD-10 pin both live in helpers/resend.ts, shared with the
        // stale-after-resend branch of "verification → verification".
        const { cursor } = await resendVerificationCode(page, user.email, ctx.mailCursor);
        // Re-anchor the walk: its code-submit can now only resolve the
        // RESENT mail, and reaching the terminal proves the newest code is
        // the one the platform accepts.
        ctx.mailCursor = cursor;
        await assertPageState(page, iv.at);
      });
      return;

    case "drop-totp-out-of-band":
      await test.step(`Intervention: drop TOTP credential out-of-band at ${iv.at}`, async () => {
        assertInternalLane(ctx, "Out-of-band TOTP credential removal (admin API)");
        // The admin-side perturbation class (wave 2's concurrent-session-revoke
        // sibling): between two states of the walk, the identity loses its
        // totp credential — what the SUBSEQUENT states observe is the
        // scenario's assertion. The page is untouched.
        if (!user.identityId) {
          throw new Error(`drop-totp-out-of-band: no identityId for user "${user.ref}"`);
        }
        await deleteIdentityCredentialType(user.identityId, "totp");
        await assertPageState(page, iv.at);
      });
      return;
  }
}
