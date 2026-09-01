// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The resend-code flow, shared by the `resend-code` intervention
 * (framework/interventions.ts) and the stale-after-resend branch of
 * "verification → verification" (framework/transitions.ts) — one place owns
 * the ordering, both consumers stay in sync.
 *
 * ORDERING IS THE WHOLE HELPER. Courier delivery is async and callers run
 * milliseconds after the address submit, so the original send is DRAINED
 * first (via the walk's pre-send cursor) and only then is the mailbox
 * snapshotted. Without the drain the snapshot can predate the original
 * mail's arrival, the post-resend wait resolves the ORIGINAL code as if it
 * were the resent one, and the walk submits a code the resend just
 * invalidated ("Verification code incorrect" — observed 2026-09-01).
 *
 * PD-10, pinned as REAL behaviour (§11, the PD-12 precedent): the cooldown
 * countdown renders (~1m30s) while the button re-enables after 90ms
 * (RESEND_CODE_TIMEOUT passed unscaled to setTimeout), and no server-side
 * limit exists either — so the immediate click SUCCEEDS today. When the fix
 * lands, the button stays disabled for the full cooldown, this click times
 * out, and the loud failure is the signal to flip this helper to
 * wait-or-assert-disabled.
 */

import { expect, Page } from "@playwright/test";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode, type MailCursor } from "./mail";

export interface ResendResult {
  /** The code from the ORIGINAL send — invalidated by the resend. */
  originalCode: string;
  /** Mailbox snapshot taken between the sends: `waitForMailCode` with this
   *  as `seen` can only resolve the RESENT mail. */
  cursor: MailCursor;
}

export async function resendVerificationCode(
  page: Page,
  email: string,
  seen: MailCursor | undefined,
): Promise<ResendResult> {
  const originalCode = await waitForMailCode({
    recipient: email,
    subject: MAIL_SUBJECTS.verification,
    seen,
  });
  const cursor = await mailCursor(email);

  await page.getByRole("button", { name: "Resend code" }).click();
  await expect(
    page.getByText(/request again in/i).first(),
    "the cooldown countdown must render after a resend",
  ).toBeVisible();

  // The resend is real: a NEW message lands for this address.
  await waitForMailCode({
    recipient: email,
    subject: MAIL_SUBJECTS.verification,
    seen: cursor,
  });

  return { originalCode, cursor };
}
