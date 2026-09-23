// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { Page, expect } from "@playwright/test";
import { clickSubmit } from "./form";

export async function getTotpSecretFromPage(page: Page): Promise<string> {
  // The secret's element varies by login-ui version: data-testid node, <pre>, or <code>.
  const secretEl = page.locator(
    '[data-testid="node/text/totp_secret_key/text"]',
  );
  const preEl = page.locator("pre").first();
  const codeEl = page.locator("code").first();
  let el = preEl;
  if (await secretEl.isVisible().catch(() => false)) el = secretEl;
  else if (await codeEl.isVisible().catch(() => false)) el = codeEl;
  await expect(el).toBeVisible({ timeout: 15_000 });
  return (await el.innerText()).trim();
}

export async function completeTotpSetup(page: Page): Promise<string> {
  const secret = await getTotpSecretFromPage(page);
  const code = await generateTotpCode(secret);

  const totpInput = page.getByRole("textbox", { name: "Verify code" });
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await totpInput.fill(code);
  await page.getByRole("button", { name: "Save" }).click();

  return secret;
}

// `atMs` picks the 30s window; pass `Date.now() - EXPIRED_TOTP_WINDOW_OFFSET_MS`
// to submit a genuinely expired code without sleeping.
export async function submitTotpCode(
  page: Page,
  secret: string,
  atMs: number = Date.now(),
  opts?: { doubleSubmit?: boolean },
): Promise<void> {
  await submitTotpCodeValue(page, await generateTotpCode(secret, atMs), opts);
}

export async function submitTotpCodeValue(
  page: Page,
  code: string,
  opts?: { doubleSubmit?: boolean },
): Promise<void> {
  const input = page.getByRole("textbox", { name: "Authentication code" });
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(code);
  await clickSubmit(
    page.getByRole("button", { name: "Sign in", exact: true }),
    { double: opts?.doubleSubmit },
  );
}

// Kratos accepts period 30s, skew 1 (ory/kratos@v1.3.1
// selfservice/strategy/totp/login.go:138 → pquerna/otp totp.Validate);
// 90s back is three windows out wherever the instant falls in its window.
export const EXPIRED_TOTP_WINDOW_OFFSET_MS = 90_000;

export async function generateTotpCode(
  secretBase32: string,
  atMs: number = Date.now(),
): Promise<string> {
  const secret = base32Decode(secretBase32);
  const time = Math.floor(atMs / 1000 / 30);
  const timeBuffer = new ArrayBuffer(8);
  const view = new DataView(timeBuffer);
  view.setBigUint64(0, BigInt(time));

  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const hmac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, timeBuffer),
  );

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;

  return code.toString().padStart(6, "0");
}

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const cleaned = input.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const ch of cleaned) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  // crypto.subtle.importKey takes a BufferSource, which excludes SharedArrayBuffer-backed views.
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}
