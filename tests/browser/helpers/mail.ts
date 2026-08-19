// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Mailslurper helpers.
 *
 * Reads mail from Mailslurper's JSON service API (:4437) instead of driving
 * its web UI (:4436): no browser page, no fixed sleeps.
 *
 * Mailslurper keeps mail for the lifetime of the stack and the recovery
 * scenarios reuse one identity on every run, so "newest message for this
 * address" is not sufficient — a stale code would be submitted and rejected.
 * Callers take a `mailCursor()` before triggering the send and pass it back
 * in, turning the wait into "a message that did not exist yet".
 */

import { expect } from "@playwright/test";
import { MAIL_API_URL } from "./config";

/** Ids of the messages already in the mailbox when the send was triggered. */
export type MailCursor = ReadonlySet<string>;

interface MailItem {
  id: string;
  dateSent: string; // "YYYY-MM-DD HH:MM:SS" — lexicographically sortable
  toAddresses: string[];
  subject: string;
  body: string;
}

/** Newest-first messages addressed to `recipient`. */
async function listMail(recipient: string): Promise<MailItem[]> {
  const res = await fetch(`${MAIL_API_URL}/mail`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`mailslurper GET /mail returned ${res.status}`);
  }
  const { mailItems } = (await res.json()) as { mailItems: MailItem[] };
  const wanted = recipient.toLowerCase();
  return mailItems
    .filter((m) => m.toAddresses.some((a) => a.toLowerCase() === wanted))
    .sort((a, b) => b.dateSent.localeCompare(a.dateSent));
}

/**
 * Snapshot the mailbox for `recipient`. Take this *before* the action that
 * triggers the email, and pass the result to getRecoveryCode /
 * getVerificationCode so stale mail from earlier runs is skipped.
 */
export async function mailCursor(recipient: string): Promise<MailCursor> {
  return new Set((await listMail(recipient)).map((m) => m.id));
}

/**
 * Poll until a message to `recipient` matching `subject` arrives that is not
 * in `seen`, then return its numeric code.
 *
 * The code is taken from the SUBJECT ("Use code NNNNNN to …"), which contains
 * exactly one number. Bodies are not reliable: some carry a second unrelated
 * 6-digit value alongside the code, so a body regex can silently return the
 * wrong one and the flow then rejects it as "Verification code incorrect".
 */
export async function waitForMailCode(opts: {
  recipient: string;
  subject: RegExp;
  seen?: MailCursor;
  timeout?: number;
}): Promise<string> {
  const { recipient, subject, seen, timeout = 30_000 } = opts;

  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const match = (await listMail(recipient)).find(
          (m) => subject.test(m.subject) && !seen?.has(m.id),
        );
        if (!match) return undefined;
        code = match.subject.match(/\b([0-9]{4,8})\b/)?.[1];
        return code;
      },
      {
        message: `no new mail matching ${subject} for ${recipient}`,
        timeout,
        intervals: [200, 300, 500, 1_000],
      },
    )
    .toBeDefined();

  return code!;
}

/** Kratos courier subjects, as sent by the running stack. */
export const MAIL_SUBJECTS: Record<"recovery" | "verification", RegExp> = {
  // "Use code NNNNNN to recover access to your account"
  recovery: /recover access to your account/i,
  // "Use code NNNNNN to verify your account"
  verification: /verify your account/i,
};
