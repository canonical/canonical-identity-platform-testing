// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { expect, Page } from "@playwright/test";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode, type MailCursor } from "./mail";

export interface ResendResult {
  originalCode: string;
  cursor: MailCursor;
}

export async function resendVerificationCode(
  page: Page,
  email: string,
  seen: MailCursor | undefined,
): Promise<ResendResult> {
  // Drain the original send first, or the post-resend wait can resolve the invalidated code.
  const originalCode = await waitForMailCode({
    recipient: email,
    subject: MAIL_SUBJECTS.verification,
    seen,
  });
  const cursor = await mailCursor(email);

  // Pinned: the cooldown renders but the button re-enables after 90ms, so this click
  // succeeds. A timeout here means upstream fixed it: assert disabled, never silently wait.
  await page.getByRole("button", { name: "Resend code" }).click();
  await expect(
    page.getByText(/request again in/i).first(),
    "the cooldown countdown must render after a resend",
  ).toBeVisible();

  await waitForMailCode({
    recipient: email,
    subject: MAIL_SUBJECTS.verification,
    seen: cursor,
  });

  return { originalCode, cursor };
}
