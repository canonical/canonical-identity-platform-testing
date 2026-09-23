// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** DOM-based page-state detection for login-ui, which serves many states on one URL (/ui/login?flow=...). */

import { Page, expect } from "@playwright/test";
import { DEX_URL } from "./config";

// --- Probes ---

// Probes run inside assertPageState()'s toPass() poll, so they must sample and fail fast: an
// unbounded locator call inherits actionTimeout (10s), the whole poll deadline. The OIDC
// consumer callback page has no <h1> at all.
const TITLE_PROBE_TIMEOUT_MS = 500;

async function pageTitleText(page: Page): Promise<string> {
  return (
    (await page
      .locator("h1")
      .first()
      .textContent({ timeout: TITLE_PROBE_TIMEOUT_MS })
      .catch(() => "")) ?? ""
  );
}

// --- Page state types ---

export type PageState =
  | { type: "login-email" }
  | { type: "login-password" }
  | { type: "login-totp-verify" }
  | { type: "login-webauthn-verify" }
  | { type: "login-backup-code-verify" }
  | { type: "setup-secure" }
  | { type: "setup-secure-linked" }
  | { type: "setup-passkey" }
  | { type: "setup-backup-codes" }
  | { type: "setup-complete" }
  | { type: "tenant-selection" }
  | { type: "device-code" }
  | { type: "device-complete" }
  | { type: "connected-accounts" }
  | { type: "oidc-callback" }
  | { type: "oidc-callback-error" }
  | { type: "error-page" }
  | { type: "provider:dex:login" }
  | { type: "provider:dex:consent" }
  | { type: "provider:google:login" }
  | { type: "provider:google:password" }
  | { type: "provider:google:totp" }
  | { type: "provider:google:interstitial" }
  | { type: "provider:google:confirm-identity" }
  | { type: "provider:google:consent" }
  | { type: "reset-email" }
  | { type: "reset-email-code" }
  | { type: "reset-password" }
  | { type: "verification" }
  | { type: "register-email" }
  | { type: "register-password" }
  | { type: "register-secure" }
  | { type: "register-complete" }
  | { type: "backup-code-regenerate" }
  | { type: "oidc-error-page" }
  | { type: "manage-details" }
  | { type: "unknown" };

export type PageStateType = PageState["type"];

// --- Login-page detectors (/ui/login) ---

/** "Sign in" title + email input, no password input. */
async function isIdentifierFirstPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Sign in")) return false;

  const hasIdentifier = await page
    .getByLabel(/e-?mail|identifier/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasPassword = await page
    .getByLabel(/password/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasIdentifier && !hasPassword;
}

/** Password input visible, no TOTP input or security-key button. */
async function isPasswordPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const hasPassword = await page
    .getByLabel(/password/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!hasPassword) return false;

  const hasTotpInput = await page
    .getByLabel(/totp|authenticator|authentication code/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasWebAuthnBtn = await page
    .getByRole("button", { name: /security key|hardware key/i })
    .isVisible()
    .catch(() => false);

  return !hasTotpInput && !hasWebAuthnBtn;
}

/** "Verify your identity" title + TOTP input or data-group="totp". */
async function isTotpVerifyPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Verify your identity")) return false;

  const hasTotpInput = await page
    .getByLabel(/totp|authenticator|authentication code/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasTotpGroup = await page
    .locator('[data-group="totp"]')
    .isVisible()
    .catch(() => false);

  return hasTotpInput || hasTotpGroup;
}

/** `<button name="webauthn_login_trigger">` with no password input. The button label and
 *  the h1 both vary by profile/flow, so neither is checked. */
async function isWebAuthnVerifyPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const hasPassword = await page
    .getByLabel(/password/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (hasPassword) return false;

  return await page
    .locator('button[name="webauthn_login_trigger"]')
    .isVisible()
    .catch(() => false);
}

/** URL param use_backup_code, or a lookup_secret input / data-group. */
async function isBackupCodeVerifyPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const urlObj = new URL(url);
  if (urlObj.searchParams.get("use_backup_code")) return true;

  const hasLookupSecret = await page
    .getByLabel(/backup|recovery|lookup/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (hasLookupSecret) return true;

  const hasLookupGroup = await page
    .locator('[data-group="lookup_secret"]')
    .isVisible()
    .catch(() => false);

  return hasLookupGroup;
}

// --- Recovery flow detectors ---

/** /reset_email + "Enter an email to reset your password" + email input. */
async function isResetEmailPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/reset_email")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Enter an email to reset your password")) return false;

  const hasEmailInput = await page
    .getByLabel(/e-?mail/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasEmailInput;
}

/** /reset_email + "Enter the code you received via email" + code input. */
async function isResetEmailCodePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/reset_email")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Enter the code you received via email")) return false;

  const hasCodeInput = await page
    .getByLabel(/code|recovery/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasCodeInput;
}

/** /reset_password + "New password" and "Confirm New password" inputs. */
async function isResetPasswordPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/reset_password")) return false;

  const hasNewPassword = await page
    .getByLabel("New password", { exact: true })
    .isVisible()
    .catch(() => false);
  const hasConfirmPassword = await page
    .getByLabel("Confirm New password")
    .isVisible()
    .catch(() => false);

  return hasNewPassword && hasConfirmPassword;
}

// --- Verification flow detector ---

/** /verification + code input. */
async function isVerificationPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/verification")) return false;

  const hasCodeInput = await page
    .getByLabel(/code/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasCodeInput;
}

// --- Registration flow detectors ---

/** /register + "Create an account" / "Create your account" + email input. */
async function isRegisterEmailPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Create an account") && !titleText?.includes("Create your account")) return false;

  const hasEmailInput = await page
    .getByLabel(/e-?mail/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasEmailInput;
}

/** /register (not /register_password, a static mock) + "Create a password" + password input. */
async function isRegisterPasswordPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Create a password")) return false;

  const hasPasswordInput = await page
    .getByLabel(/password/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasPasswordInput;
}

/** /register_secure + "Secure your account". */
async function isRegisterSecurePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register_secure")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Secure your account")) return false;

  return true;
}

/** /register_complete + "Account setup complete". */
async function isRegisterCompletePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register_complete")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Account setup complete")) return false;

  return true;
}

// --- Other login-ui detectors ---

/** /backup_codes_regenerate + "Backup code sign in successful". */
async function isBackupCodeRegeneratePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/backup_codes_regenerate")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Backup code sign in successful")) return false;

  return true;
}

/** /oidc_error + "Sign in failed". */
async function isOidcErrorPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/oidc_error")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Sign in failed")) return false;

  return true;
}

// --- Google OIDC detectors ---

/** accounts.google.com + #identifierId. */
async function isGoogleLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;

  const hasIdentifier = await page
    .locator("#identifierId")
    .isVisible()
    .catch(() => false);

  return hasIdentifier;
}

/** accounts.google.com/challenge/pwd + visible password input. */
async function isGooglePasswordPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/challenge/pwd")) return false;

  const hasPassword = await page
    .locator('input[type="password"]:visible')
    .first()
    .isVisible()
    .catch(() => false);

  return hasPassword;
}

/** accounts.google.com/challenge/totp + #totpPin. */
async function isGoogleTotpPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/challenge/totp")) return false;

  const hasTotpPin = await page
    .locator("#totpPin")
    .isVisible()
    .catch(() => false);

  return hasTotpPin;
}

/** accounts.google.com/signin/oauth/legacy/consent. */
async function isGoogleConsentPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/signin/oauth/legacy/consent")) return false;

  return true;
}

/** accounts.google.com/signin/oauth/id (identity confirmation after TOTP). */
async function isGoogleConfirmIdentityPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/signin/oauth/id")) return false;

  return true;
}

/** accounts.google.com/interstitials/ + "Don't get locked out". */
async function isGoogleInterstitialPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/interstitials/")) return false;

  const hasText = await page
    .getByText("Don't get locked out")
    .isVisible()
    .catch(() => false);

  return hasText;
}

// --- URL-based detection ---

function urlContains(page: Page, substring: string): boolean {
  return page.url().includes(substring);
}

/** Matches the compose hostname (dex:5556) or the configured DEX_URL (charmed lane NodePort). */
export function isDexUrl(href: string): boolean {
  return href.startsWith(`${DEX_URL}/`) || href === DEX_URL || /:5556|dex:/.test(href);
}

/** OAuth `error` in the query (RFC 6749 §4.1.2.1) or the fragment. */
function hasCallbackError(page: Page): boolean {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (url.searchParams.has("error")) return true;
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  return new URLSearchParams(fragment).has("error");
}

/** hydra CLI consumer tokenUserError template: `<h1>An error occurred</h1>`; URL still has `?code=`. */
async function callbackBodyShowsError(page: Page): Promise<boolean> {
  return (
    (await page
      .getByRole("heading", { name: "An error occurred" })
      .count()
      .catch(() => 0)) > 0
  );
}

// --- Main detection ---

/** Order matters: URL-distinct pages first, then title/DOM for states sharing /ui/login. */
export async function detectPageState(page: Page): Promise<PageState> {
  // --- External OIDC provider pages (check by URL before login-ui) ---

  const currentUrl = page.url();
  const onDex = isDexUrl(currentUrl);
  const hasGoogle = currentUrl.includes("accounts.google.com");

  if (hasGoogle) {
    if (await isGoogleTotpPage(page)) {
      return { type: "provider:google:totp" };
    }
    if (await isGoogleConsentPage(page)) {
      return { type: "provider:google:consent" };
    }
    if (await isGoogleConfirmIdentityPage(page)) {
      return { type: "provider:google:confirm-identity" };
    }
    if (await isGoogleInterstitialPage(page)) {
      return { type: "provider:google:interstitial" };
    }
    if (await isGooglePasswordPage(page)) {
      return { type: "provider:google:password" };
    }
    if (await isGoogleLoginPage(page)) {
      return { type: "provider:google:login" };
    }
    return { type: "unknown" };
  }

  if (onDex) {
    const hasLoginForm =
      (await page
        .locator("#login")
        .isVisible()
        .catch(() => false)) ||
      (await page
        .getByRole("heading", { name: /Log in to Your Account/i })
        .isVisible()
        .catch(() => false));
    return hasLoginForm
      ? { type: "provider:dex:login" }
      : { type: "provider:dex:consent" };
  }

  // --- Distinct-URL pages (check first, they're unambiguous) ---

  if (urlContains(page, "/callback?")) {
    // `?error=` (RFC 6749) or the consumer's rendered error page (a code replay keeps
    // `?code=`) is an OAuth failure, not a completed flow.
    if (hasCallbackError(page)) return { type: "oidc-callback-error" };
    if (await callbackBodyShowsError(page)) return { type: "oidc-callback-error" };
    return { type: "oidc-callback" };
  }

  if (urlContains(page, "/ui/error")) {
    return { type: "error-page" };
  }

  if (urlContains(page, "/ui/setup_secure")) {
    // TOTP already linked renders only the "Unlink TOTP Authenticator App" button;
    // enrolment renders the QR + "Verify code" form.
    const unlinkVisible = await page
      .getByRole("button", { name: "Unlink TOTP Authenticator App" })
      .isVisible()
      .catch(() => false);
    if (unlinkVisible) {
      return { type: "setup-secure-linked" };
    }
    return { type: "setup-secure" };
  }

  if (urlContains(page, "/ui/setup_passkey")) {
    return { type: "setup-passkey" };
  }

  if (urlContains(page, "/ui/setup_backup_codes")) {
    return { type: "setup-backup-codes" };
  }

  if (urlContains(page, "/ui/setup_complete")) {
    return { type: "setup-complete" };
  }

  if (urlContains(page, "/ui/device_code")) {
    return { type: "device-code" };
  }
  if (urlContains(page, "/ui/device_complete")) {
    return { type: "device-complete" };
  }
  if (urlContains(page, "/ui/manage_connected_accounts")) {
    return { type: "connected-accounts" };
  }
  // No /ui/consent state: login-ui auto-accepts every consent request, so the page is
  // unreachable (docs/testing-spec.md §10 item 12).

  // login-ui lands here when a flow is initialised with a satisfying session already present.
  if (urlContains(page, "/ui/manage_details")) {
    return { type: "manage-details" };
  }

  // --- Recovery flow pages ---

  if (await isResetEmailCodePage(page)) {
    return { type: "reset-email-code" };
  }

  if (await isResetEmailPage(page)) {
    return { type: "reset-email" };
  }

  if (await isResetPasswordPage(page)) {
    return { type: "reset-password" };
  }

  // --- Verification flow page ---

  if (await isVerificationPage(page)) {
    return { type: "verification" };
  }

  // --- Registration flow pages ---

  if (await isRegisterCompletePage(page)) {
    return { type: "register-complete" };
  }

  if (await isRegisterSecurePage(page)) {
    return { type: "register-secure" };
  }

  if (await isRegisterPasswordPage(page)) {
    return { type: "register-password" };
  }

  if (await isRegisterEmailPage(page)) {
    return { type: "register-email" };
  }

  // --- Other pages ---

  if (await isBackupCodeRegeneratePage(page)) {
    return { type: "backup-code-regenerate" };
  }

  if (await isOidcErrorPage(page)) {
    return { type: "oidc-error-page" };
  }

  // --- Same-URL pages (/ui/login) ---

  const hasTenantHeading = await page
    .getByRole("heading", { name: "Select a tenant" })
    .isVisible()
    .catch(() => false);
  if (hasTenantHeading) {
    return { type: "tenant-selection" };
  }

  if (await isBackupCodeVerifyPage(page)) {
    return { type: "login-backup-code-verify" };
  }

  if (await isTotpVerifyPage(page)) {
    return { type: "login-totp-verify" };
  }

  if (await isWebAuthnVerifyPage(page)) {
    return { type: "login-webauthn-verify" };
  }

  if (await isIdentifierFirstPage(page)) {
    return { type: "login-email" };
  }

  if (await isPasswordPage(page)) {
    return { type: "login-password" };
  }

  return { type: "unknown" };
}

// --- State assertion ---

export async function assertPageState(
  page: Page,
  expected: PageState["type"],
): Promise<void> {
  // login-ui is a React SPA: poll until it has rendered enough to identify; no fixed sleeps.
  let lastActual: string = "unknown";
  let lastUrl: string = "";
  let lastError: string = "";
  try {
    await expect(async () => {
      // Capture the URL first so a stalled detection still reports where the browser was.
      try {
        lastUrl = page.url().substring(0, 100);
      } catch {
        lastUrl = "<error getting URL>";
      }
      let actual: PageState;
      try {
        actual = await detectPageState(page);
      } catch (detectErr) {
        lastError = String(detectErr);
        actual = { type: "unknown" };
      }
      lastActual = actual.type;
      expect(actual.type).toBe(expected);
    }).toPass({ timeout: 10_000 });
  } catch (e) {
    throw new Error(`assertPageState: expected "${expected}", got "${lastActual}" (URL: ${lastUrl})${lastError ? ` detectError: ${lastError}` : ''}\n${e}`);
  }
}
