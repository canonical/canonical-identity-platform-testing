// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Reads Mailslurper's JSON API (:4437). Mail persists for the stack's lifetime and
// identities are reused, so callers snapshot a `mailCursor()` before the send.

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

export async function mailCursor(recipient: string): Promise<MailCursor> {
  return new Set((await listMail(recipient)).map((m) => m.id));
}

// Code is taken from the subject ("Use code NNNNNN to …"); bodies can carry a
// second unrelated 6-digit value, so a body regex may return the wrong one.
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

export const MAIL_SUBJECTS: Record<"recovery" | "verification", RegExp> = {
  recovery: /recover access to your account/i,
  verification: /verify your account/i,
};
