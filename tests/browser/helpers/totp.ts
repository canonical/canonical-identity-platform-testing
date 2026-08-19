// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * TOTP (MFA) setup and code-generation helpers.
 *
 * Ported from tenant-service/tests/browser/helpers/totp.ts.
 * Uses the Web Crypto API (available in Node 20+) for HMAC-SHA1.
 * No external dependency on `oathtool` (unlike login-ui's version).
 */

import { Page, expect } from "@playwright/test";
import { clickSubmit } from "./form";

/**
 * Read the base32 TOTP secret from the setup_secure page.
 * The page must already be on /ui/setup_secure with the TOTP setup form.
 */
export async function getTotpSecretFromPage(page: Page): Promise<string> {
  // The heading "Secure your account" confirms we're on the TOTP setup page.
  // The secret's element varies by login-ui version: a data-testid node, a
  // <pre>, or (current stable) a <code> element next to the QR code.
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

/**
 * Complete TOTP setup on the setup_secure page.
 * Assumes the browser has been redirected to /ui/setup_secure after 1FA.
 * Returns the base32 secret for future code generation.
 */
export async function completeTotpSetup(page: Page): Promise<string> {
  const secret = await getTotpSecretFromPage(page);
  const code = await generateTotpCode(secret);

  const totpInput = page.getByRole("textbox", { name: "Verify code" });
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await totpInput.fill(code);
  await page.getByRole("button", { name: "Save" }).click();

  return secret;
}

/**
 * Submit a TOTP code during the login MFA step (not setup — verification).
 * Takes the base32 secret returned by `completeTotpSetup`.
 *
 * `atMs` selects the 30-second window the code is computed for. It exists so an
 * error scenario can submit a genuinely EXPIRED code (a code that was valid, in
 * a window Kratos no longer accepts) without sleeping: pass
 * `Date.now() - EXPIRED_TOTP_WINDOW_OFFSET_MS`.
 */
export async function submitTotpCode(
  page: Page,
  secret: string,
  atMs: number = Date.now(),
  opts?: { doubleSubmit?: boolean },
): Promise<void> {
  await submitTotpCodeValue(page, await generateTotpCode(secret, atMs), opts);
}

/**
 * Type a literal code into the login MFA form and submit it.
 *
 * The login MFA page shows "Verify your identity" with an "Authentication code"
 * textbox and "Sign in" button — different from the setup page's "Save" button.
 */
export async function submitTotpCodeValue(
  page: Page,
  code: string,
  opts?: { doubleSubmit?: boolean },
): Promise<void> {
  const input = page.getByRole("textbox", { name: "Authentication code" });
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(code);
  await clickSubmit(
    page,
    page.getByRole("button", { name: "Sign in", exact: true }),
    { double: opts?.doubleSubmit },
  );
}

/**
 * How far back a code has to be computed for Kratos to reject it as expired.
 *
 * Kratos validates TOTP with pquerna/otp's defaults — `totp.Validate` (period
 * 30s, skew 1, i.e. the previous, current and next window are all accepted):
 * ory/kratos@v1.3.1 selfservice/strategy/totp/login.go:138 →
 * pquerna/otp totp.Validate (Period: 30, Skew: 1). 90s back is three windows
 * out, comfortably past skew, and stays past skew wherever the current instant
 * falls inside its window.
 */
export const EXPIRED_TOTP_WINDOW_OFFSET_MS = 90_000;

/**
 * Generate a TOTP code from a base32 secret.
 * Uses the Web Crypto API (available in Node 20+) for HMAC-SHA1.
 *
 * `atMs` is the instant the code is computed for; it defaults to now. Codes are
 * a pure function of (secret, window), so a past window is deterministic — no
 * sleeping required to produce one that Kratos will reject.
 */
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

// ---------------------------------------------------------------------------
// Base32 decoding (RFC 4648)
// ---------------------------------------------------------------------------

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  // Strip whitespace and padding before decoding
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

  // Back the array with a plain ArrayBuffer: crypto.subtle.importKey takes a
  // BufferSource, which excludes SharedArrayBuffer-backed views.
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}
