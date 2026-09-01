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
import { MAIL_SUBJECTS, mailCursor, waitForMailCode } from "../helpers/mail";
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
        // ORDERING IS THE WHOLE PRIMITIVE. Courier delivery is async, and
        // this intervention fires milliseconds after the address submit — so
        // first DRAIN the original send (using the walk's own pre-send
        // cursor), and only then snapshot. Without the drain, the snapshot
        // can predate the original mail's arrival, the arrival wait below
        // resolves the ORIGINAL code as if it were the resent one, and the
        // walk then submits a code the resend just invalidated
        // ("Verification code incorrect" — observed 2026-09-01 before the
        // drain existed).
        await waitForMailCode({
          recipient: user.email,
          subject: MAIL_SUBJECTS.verification,
          seen: ctx.mailCursor,
        });
        const cursor = await mailCursor(user.email);

        // PD-10, pinned as REAL behaviour (§11, the PD-12 precedent): the
        // cooldown countdown renders (~1m30s) while the button re-enables
        // after 90ms (RESEND_CODE_TIMEOUT passed unscaled to setTimeout),
        // and no server-side limit exists either — so this immediate click
        // SUCCEEDS today. When the fix lands, the button stays disabled for
        // the full cooldown, this click times out, and the failure is the
        // signal to flip this primitive to wait-or-assert-disabled.
        await page.getByRole("button", { name: "Resend code" }).click();
        await expect(
          page.getByText(/request again in/i).first(),
          "the cooldown countdown must render after a resend",
        ).toBeVisible();

        // The resend is real: a NEW message lands for this address.
        await waitForMailCode({
          recipient: user.email,
          subject: MAIL_SUBJECTS.verification,
          seen: cursor,
        });
        ctx.mailCursor = cursor;

        // Still on the same page — the walk continues and its code-submit
        // proves the RESENT code (newest) is the one the platform accepts.
        await assertPageState(page, iv.at);
      });
      return;
  }
}
