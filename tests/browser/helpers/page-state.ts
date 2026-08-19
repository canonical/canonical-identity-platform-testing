// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Page state detection for the Identity Platform login UI.
 *
 * The login-ui serves multiple page states on the same URL (/ui/login?flow=...).
 * This module provides pure async functions that detect the current page state
 * by inspecting the DOM using multiple signals: URL, page title, Kratos UI
 * node groups, and input names.
 *
 * Moved from machines/page-detectors.ts as part of removing the XState
 * model-based testing layer. The detection logic is still useful for
 * writing assertions in regular Playwright tests.
 */

import { Page, expect } from "@playwright/test";
import { DEX_URL } from "./config";

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Read the page title (<h1>) with a hard bound.
 *
 * detectPageState() runs inside assertPageState()'s toPass() poll loop, so a
 * probe must sample and fail fast, never wait. An unbounded locator call
 * inherits `use.actionTimeout` (10s), which is exactly the poll deadline — so
 * a single missing <h1> consumes the entire budget, the predicate never
 * completes even once, and the error reports the initialisers ("unknown", an
 * empty URL) rather than anything observed. The OIDC consumer callback page
 * has no <h1> at all, so every transition ending there could hang a probe that
 * started on the page being navigated away from. Waiting is toPass()'s job.
 */
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

// ---------------------------------------------------------------------------
// Page State Types (discriminated union)
// ---------------------------------------------------------------------------

export type PageState =
  | { type: "login-email" }
  | { type: "login-password" }
  | { type: "login-totp-verify" }
  | { type: "login-webauthn-verify" }
  | { type: "login-backup-code-verify" }
  | { type: "setup-secure" }
  | { type: "setup-passkey" }
  | { type: "setup-backup-codes" }
  | { type: "setup-complete" }
  | { type: "tenant-selection" }
  | { type: "consent" }
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

/**
 * String literal union of all page state type values.
 * Useful for scenario definitions and the action resolver.
 */
export type PageStateType = PageState["type"];

// ---------------------------------------------------------------------------
// Individual detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the page is the identifier-first login step (email input only).
 * Signals: title "Sign in" + input[name="identifier"] visible + no password input.
 */
export async function isIdentifierFirstPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Sign in")) return false;

  // Identifier-first has the email input but NOT the password input
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

/**
 * Check if the page is the password login step (1FA).
 * Signals: password input visible + no TOTP/WebAuthn groups.
 */
export async function isPasswordPage(page: Page): Promise<boolean> {
  const url = page.url();
  // The password page is always under /login in the login-ui
  if (!url.includes("/login")) return false;

  const hasPassword = await page
    .getByLabel(/password/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!hasPassword) return false;

  // Make sure it's not a TOTP or WebAuthn verify page (same URL, different UI)
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

/**
 * Check if the page is the TOTP verification step (2FA).
 * Signals: title "Verify your identity" + TOTP input or node group "totp".
 */
export async function isTotpVerifyPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Verify your identity")) return false;

  // Check for TOTP-specific elements
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

/**
 * Check if the page is the WebAuthn verification step (2FA).
 *
 * Detects the Kratos node, not its label. The second-factor trigger is
 * `<button name="webauthn_login_trigger">`, whose text comes from a Kratos
 * message that login-ui only rewrites when OIDC sequencing is on — so no fixed
 * label string is reliable across profiles.
 *
 * The h1 is deliberately not checked: it reads "Verify your identity" only when
 * the flow also carries a TOTP node, and names the client for a webauthn-only
 * identity. The password guard keeps the first-factor page from being misread
 * if Kratos ever emits a webauthn node alongside it.
 */
export async function isWebAuthnVerifyPage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the backup code verification step.
 * Signals: URL param use_backup_code or lookup_secret group visible.
 */
export async function isBackupCodeVerifyPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/login")) return false;

  // Check URL parameter
  const urlObj = new URL(url);
  if (urlObj.searchParams.get("use_backup_code")) return true;

  // Check for lookup_secret group elements
  const hasLookupSecret = await page
    .getByLabel(/backup|recovery|lookup/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (hasLookupSecret) return true;

  // Also check for data-group attribute
  const hasLookupGroup = await page
    .locator('[data-group="lookup_secret"]')
    .isVisible()
    .catch(() => false);

  return hasLookupGroup;
}

// ---------------------------------------------------------------------------
// Recovery flow detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the page is the recovery email entry form.
 * Signals: URL /reset_email + title "Enter an email to reset your password" + email input.
 */
export async function isResetEmailPage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the recovery code entry form (after email submitted).
 * Signals: URL /reset_email + title "Enter the code you received via email" + code input.
 */
export async function isResetEmailCodePage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the new password form (after code verified).
 * Signals: URL /reset_password + "New password" + "Confirm New password" inputs.
 */
export async function isResetPasswordPage(page: Page): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// Verification flow detection helper
// ---------------------------------------------------------------------------

/**
 * Check if the page is the email verification form.
 * Signals: URL /verification + code input + verification heading.
 */
export async function isVerificationPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/verification")) return false;

  const hasCodeInput = await page
    .getByLabel(/code/i)
    .first()
    .isVisible()
    .catch(() => false);

  return hasCodeInput;
}

// ---------------------------------------------------------------------------
// Registration flow detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the page is the registration email entry form.
 * Signals: URL /register or /register_email + title "Create an account" + email input.
 */
export async function isRegisterEmailPage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the registration password creation form.
 * Signals: URL /register (the real flow URL; /register_password is a static
 * mock the flow never navigates to) + title "Create a password" + password input.
 */
export async function isRegisterPasswordPage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the registration MFA setup form.
 * Signals: URL /register_secure + title "Secure your account".
 */
export async function isRegisterSecurePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register_secure")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Secure your account")) return false;

  return true;
}

/**
 * Check if the page is the registration complete page.
 * Signals: URL /register_complete + title "Account setup complete".
 */
export async function isRegisterCompletePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/register_complete")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Account setup complete")) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Other page detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the page is the backup code regeneration prompt.
 * Signals: URL /backup_codes_regenerate + title "Backup code sign in successful".
 */
export async function isBackupCodeRegeneratePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/backup_codes_regenerate")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Backup code sign in successful")) return false;

  return true;
}

/**
 * Check if the page is the OIDC error page.
 * Signals: URL /oidc_error + title "Sign in failed".
 */
export async function isOidcErrorPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("/oidc_error")) return false;

  const titleText = await pageTitleText(page);
  if (!titleText?.includes("Sign in failed")) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Google OIDC detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the page is the Google sign-in email entry page.
 * Signals: URL accounts.google.com + #identifierId visible.
 */
export async function isGoogleLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;

  const hasIdentifier = await page
    .locator("#identifierId")
    .isVisible()
    .catch(() => false);

  return hasIdentifier;
}

/**
 * Check if the page is the Google sign-in password entry page.
 * Signals: URL /challenge/pwd + password input visible.
 */
export async function isGooglePasswordPage(page: Page): Promise<boolean> {
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

/**
 * Check if the page is the Google TOTP 2FA challenge page.
 * Signals: URL /challenge/totp + #totpPin visible.
 */
export async function isGoogleTotpPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/challenge/totp")) return false;

  const hasTotpPin = await page
    .locator("#totpPin")
    .isVisible()
    .catch(() => false);

  return hasTotpPin;
}

/**
 * Check if the page is the Google OAuth consent page.
 * Signals: URL /signin/oauth/legacy/consent on accounts.google.com.
 */
export async function isGoogleConsentPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/signin/oauth/legacy/consent")) return false;

  return true;
}

/**
 * Check if the page is the Google OAuth identity confirmation page.
 * Signals: URL /signin/oauth/id on accounts.google.com.
 * This page appears after TOTP verification in some Google OAuth flows.
 */
export async function isGoogleConfirmIdentityPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/signin/oauth/id")) return false;

  return true;
}

/**
 * Check if the page is the Google Workspace interstitial
 * ("Don't get locked out" page).
 * Signals: URL /interstitials/ + "Don't get locked out" text.
 */
export async function isGoogleInterstitialPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("accounts.google.com")) return false;
  if (!url.includes("/interstitials/")) return false;

  const hasText = await page
    .getByText("Don't get locked out")
    .isVisible()
    .catch(() => false);

  return hasText;
}

// ---------------------------------------------------------------------------
// URL-based detection for distinct-URL pages
// ---------------------------------------------------------------------------

function urlContains(page: Page, substring: string): boolean {
  return page.url().includes(substring);
}

/** Does the current URL's query carry an OAuth `error` parameter?
 *  RFC 6749 §4.1.2.1 puts it in the query for the authorization-code flow;
 *  implicit-style responses put it in the fragment, so check both. */
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

/** The hydra CLI consumer's tokenUserError template: `<h1>An error occurred</h1>`
 *  plus the error name/description. Rendered for exchange failures, where the
 *  URL still carries `?code=` rather than `?error=`. */
async function callbackBodyShowsError(page: Page): Promise<boolean> {
  return (
    (await page
      .getByRole("heading", { name: "An error occurred" })
      .count()
      .catch(() => 0)) > 0
  );
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * Detect the current page state by inspecting the DOM.
 *
 * Uses a multi-signal strategy:
 * 1. URL-based detection for pages with distinct URLs
 * 2. Title + DOM inspection for pages sharing /ui/login
 *
 * Returns a discriminated union with a `type` field for exhaustive checking.
 *
 * @example
 * ```ts
 * const state = await detectPageState(page);
 * if (state.type === "login-email") {
 *   // on the identifier-first page
 * }
 * ```
 */
export async function detectPageState(page: Page): Promise<PageState> {
  // --- External OIDC provider pages (check by URL before login-ui) ---

  const currentUrl = page.url();
  // Dex may be addressed by compose hostname (dex:5556, resolved via
  // host-resolver-rules) or by an arbitrary DEX_URL (charmed lane: a NodePort
  // like http://<node>:30556) — match the configured base URL too.
  const has5556 = currentUrl.includes(":5556");
  const hasDexColon = currentUrl.includes("dex:");
  const hasDexBase = currentUrl.startsWith(`${DEX_URL}/`) || currentUrl === DEX_URL;
  const hasGoogle = currentUrl.includes("accounts.google.com");

  // Google OIDC pages — check specific page type
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
    // On Google but can't identify the specific page
    return { type: "unknown" };
  }

  if (has5556 || hasDexColon || hasDexBase) {
    // On Dex's page — check if it's the login form or consent
    // Use multiple signals: #login input, heading text, or form action
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
    // A callback carrying `error=` is an OAuth FAILURE, not a completed flow.
    // Detecting it as `oidc-callback` made `/callback?error=access_denied`
    // satisfy every final-state check, so a consent/accept failure at the last
    // step recorded a pass. Distinct terminal state instead.
    if (hasCallbackError(page)) return { type: "oidc-callback-error" };
    // Second error presentation: a code REPLAY keeps `?code=` in the URL but
    // the consumer fails the exchange and renders its error page ("Unable to
    // exchange code…", "States do not match"). URL sniffing alone misread
    // that as a completed flow — check the rendered surface too.
    if (await callbackBodyShowsError(page)) return { type: "oidc-callback-error" };
    return { type: "oidc-callback" };
  }

  if (urlContains(page, "/ui/error")) {
    return { type: "error-page" };
  }

  if (urlContains(page, "/ui/setup_secure")) {
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

  if (urlContains(page, "/ui/consent")) {
    return { type: "consent" };
  }

  // Self-serve account page. login-ui lands here whenever a flow is initialised
  // while a satisfying session already exists (handleFlowError:
  // session_already_available -> ./manage_details).
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

  // Tenant selection: distinct heading
  const hasTenantHeading = await page
    .getByRole("heading", { name: "Select a tenant" })
    .isVisible()
    .catch(() => false);
  if (hasTenantHeading) {
    return { type: "tenant-selection" };
  }

  // Backup code verify: URL param or lookup_secret elements
  if (await isBackupCodeVerifyPage(page)) {
    return { type: "login-backup-code-verify" };
  }

  // TOTP verify: "Verify your identity" + TOTP input
  if (await isTotpVerifyPage(page)) {
    return { type: "login-totp-verify" };
  }

  // WebAuthn verify: "Verify your identity" + WebAuthn button
  if (await isWebAuthnVerifyPage(page)) {
    return { type: "login-webauthn-verify" };
  }

  // Identifier-first: "Sign in" + email input, no password
  if (await isIdentifierFirstPage(page)) {
    return { type: "login-email" };
  }

  // Password: password input visible
  if (await isPasswordPage(page)) {
    return { type: "login-password" };
  }

  return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// State assertion helper
// ---------------------------------------------------------------------------

/**
 * Assert that the page is in the expected state.
 *
 * @example
 * ```ts
 * await assertPageState(page, "login-email");
 * ```
 */
export async function assertPageState(
  page: Page,
  expected: PageState["type"],
): Promise<void> {
  // The login-ui is a React SPA — after navigation the shell loads first,
  // then React mounts and renders the form.  Use Playwright's toPass()
  // to poll the detection function until the SPA has rendered enough
  // to be identifiable.  No fixed sleeps.
  let lastActual: string = "unknown";
  let lastUrl: string = "";
  let lastError: string = "";
  try {
    await expect(async () => {
      // Capture the URL FIRST. If detection ever stalls, the error must still
      // report where the browser actually was rather than the initialisers.
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
