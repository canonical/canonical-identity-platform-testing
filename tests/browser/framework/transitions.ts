// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The transition table — every known state transition and the action that
 * drives the browser through it — plus the types that describe it.
 *
 * The table is a flat (fromState → toState) lookup, not a graph library: the
 * number of meaningful transitions is small, and a scenario declares the path
 * it expects rather than asking anything to search for one. Each entry uses the
 * user context from the manifest and the scenario's action context.
 *
 * If the UI changes (a button is renamed) you update one entry, not every
 * scenario. To add a transition: add the entry, import the helper it needs, and
 * the action resolver picks it up automatically.
 */

import { Page, expect } from "@playwright/test";
import { enterEmail, enterPassword } from "../helpers/login";
import {
  EXPIRED_TOTP_WINDOW_OFFSET_MS,
  completeTotpSetup,
  submitTotpCode,
  submitTotpCodeValue,
} from "../helpers/totp";
import { clickDexLoginButton, loginWithDex } from "../helpers/dex";
import { clickGoogleLoginButton, confirmGoogleIdentity, enterGoogleEmail, enterGooglePassword, enterGoogleTotp, dismissGoogleInterstitial } from "../helpers/google";
import { GOOGLE_TEST_EMAIL, GOOGLE_TEST_PASSWORD, GOOGLE_TEST_TOTP_SECRET } from "../helpers/config";
import { startOIDCFlow, startOIDCFlowWithParams, expectOIDCFlowComplete, startDeviceAuth, expectDeviceTokenPending } from "../helpers/oidc";
// The oidc.ts starter waits for a login/consent/callback entry URL; error-path
// starts terminate on /ui/oidc_error or the RP error page instead, so they use
// the raw navigation from helpers/hydra.
import { startOIDCFlowWithParams as startAuthorizeNavigation } from "../helpers/hydra";
import { verifyBackupCode } from "../helpers/backupCode";
import { selectTenant } from "../helpers/navigation";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode } from "../helpers/mail";
import { enterNewPassword, fillRegistrationPassword } from "../helpers/password";
import { startRecoveryFlow, startVerificationFlow, startRegistrationFlow } from "../helpers/kratos";
import { LOGIN_UI_URL } from "../helpers/config";
import { DEFAULT_TEST_PASSWORD } from "../helpers/test-credentials";
import type { ExecutionLane } from "../helpers/config";
import type { MailCursor } from "../helpers/mail";
import type { WebAuthnHelper } from "../helpers/webauthn";
import type { ManifestUser } from "../seeder/manifest-schema";

// ---------------------------------------------------------------------------
// Transition action types
// ---------------------------------------------------------------------------

/** Additional context passed to action functions. */
export interface ActionContext {
  /** Active test execution lane. */
  lane?: ExecutionLane;
  /** OIDC flow parameters (e.g., { max_age: "0" }). */
  flowParams?: Record<string, string>;
  /** Tenant name to select (for multi-tenant scenarios). */
  selectTenant?: string;
  /** TOTP secret generated during setup (stored here for later use). */
  totpSecret?: string;
  /**
   * Which 30-second TOTP window an error self-transition computes its code for.
   * Unset → a wrong code ("000000"). "expired" → a well-formed code from a
   * window Kratos no longer accepts, so the two TOTP error scenarios exercise
   * two different rejections instead of the same one twice.
   */
  totpCodeWindow?: "expired";
  /** Backup code generated during setup (stored here for later use). */
  backupCode?: string;
  /** RFC 8628 device_code minted by "start → device-code" — the runner
   *  redeems it at the token endpoint after the walk reaches
   *  device-complete (device tokens arrive by RP polling, not a callback). */
  deviceCode?: string;
  /** Set by the runner when a "double-submit" intervention targets the
   *  transition being executed. The transition's action MUST forward it to
   *  its submit helper and acknowledge via doubleSubmitConsumed — the runner
   *  fails the test when the flag was set but not consumed, so an unsupported
   *  transition cannot silently downgrade the intervention to a no-op. */
  doubleSubmit?: boolean;
  /** Acknowledgement that the executed action honored doubleSubmit. */
  doubleSubmitConsumed?: boolean;
  /** New password for recovery/registration flows. */
  newPassword?: string;
  /** The password the seeder gave this user, snapshotted by the runner before
   *  any transition mutates `user.password` — what a settings restore pass
   *  submits to leave a shared identity exactly as seeded. */
  seededPassword?: string;
  /** Mailslurper message ids present before an email was triggered. */
  mailCursor?: MailCursor;
  /** Google test account email (for Google OIDC transitions). */
  googleEmail?: string;
  /** Google test account password (for Google OIDC transitions). */
  googlePassword?: string;
  /** Google test account TOTP secret base32 (for Google OIDC transitions). */
  googleTotpSecret?: string;
  /** WebAuthn virtual authenticator helper (for WebAuthn ceremonies). */
  webauthn?: WebAuthnHelper;
}

/** A function that drives the browser from one state to the next. */
export type ActionFunction = (
  page: Page,
  user: ManifestUser,
  ctx: ActionContext,
) => Promise<void>;

/** A transition action with a human-readable description. */
export interface TransitionAction {
  /** Human-readable description (used in test.step() reporting). */
  description: string;
  /** The action function that drives the browser. */
  action: ActionFunction;
}

/** Key format: "fromState → toState" */
export type TransitionKey = `${string} → ${string}`;

/** The transition table. */
export type TransitionTable = Record<TransitionKey, TransitionAction>;

function assertInternalLane(ctx: ActionContext, feature: string): void {
  if (ctx.lane === "live") {
    throw new Error(`${feature} is not available in live lane`);
  }
}

/**
 * A well-formed recovery code that Kratos did not issue.
 *
 * Codes are 4–8 digits (helpers/mail.ts reads them out of the courier
 * subject), so an all-zero value has the right shape and is rejected on
 * lookup rather than on validation — which is the rejection the code-abuse
 * scenario is about. A collision with a real issued code would make the
 * scenario fail loudly on an unexpected state, never pass silently.
 */
const WRONG_RECOVERY_CODE = "000000";

async function submitWrongRecoveryCode(page: Page): Promise<void> {
  await page.getByLabel("Recovery code").fill(WRONG_RECOVERY_CODE);
  await page.getByRole("button", { name: "Submit" }).click();
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

export const TRANSITION_TABLE: TransitionTable = {
  // ── Starting the flow ─────────────────────────────────────────────────
  //
  // The "start" pseudo-state represents the initial navigation to the OIDC
  // consumer app. The action starts the flow and the browser lands on the
  // first page state (login-email, oidc-callback for session reuse, etc.).

  "start → login-email": {
    description: "Start OIDC authorization code flow",
    action: async (page, _user, ctx) => {
      await startOIDCFlowWithParams(page, ctx.flowParams ?? {});
    },
  },

  "start → oidc-callback": {
    description: "Start OIDC flow (session reuse — auto-completes)",
    action: async (page, _user, ctx) => {
      await startOIDCFlowWithParams(page, ctx.flowParams ?? {});
      await expectOIDCFlowComplete(page);
    },
  },

  "start → tenant-selection": {
    description: "Start OIDC flow (session exists, multi-tenant — tenant selection)",
    action: async (page, _user, ctx) => {
      await startOIDCFlowWithParams(page, ctx.flowParams ?? {});
    },
  },

  // Error-path starts: a deliberately malformed authorize request. Hydra
  // splits on redirect-URI validity (writeAuthorizeError): an unvalidatable
  // client_id/redirect_uri 302s to urls.error → login-ui /ui/oidc_error,
  // while a validatable request carries its ?error= back to the RP callback.
  // The malformation itself is scenario data — flowParams overrides
  // (buildAuthorizeUrl replaces query params via searchParams.set).
  "start → oidc-error-page": {
    description: "Start OIDC flow with a malformed authorize request (unvalidatable client/redirect)",
    action: async (page, _user, ctx) => {
      await startAuthorizeNavigation(page, ctx.flowParams ?? {});
      await page.waitForLoadState("load");
    },
  },

  "start → oidc-callback-error": {
    description: "Start OIDC flow expecting an RP-side error redirect",
    action: async (page, _user, ctx) => {
      await startAuthorizeNavigation(page, ctx.flowParams ?? {});
      await page.waitForLoadState("load");
    },
  },

  // ── Identifier-first transitions ───────────────────────────────────────
  //
  // The login-email page is the first screen users see. From here they can
  // go to the password form, tenant selection, or an external OIDC provider.

  "login-email → login-password": {
    description: "Enter email and continue",
    action: async (page, user) => {
      await enterEmail(page, user.email);
    },
  },

  "login-email → tenant-selection": {
    description: "Enter email and continue (tenant selection follows)",
    action: async (page, user) => {
      await enterEmail(page, user.email);
    },
  },

  "login-email → provider:dex:login": {
    description: "Enter email, then click Dex login button",
    action: async (page, user) => {
      await enterEmail(page, user.email);
      await clickDexLoginButton(page);
    },
  },

  "login-email → provider:google:login": {
    description: "Enter email, then click Google login button",
    action: async (page, user) => {
      await enterEmail(page, user.email);
      await clickGoogleLoginButton(page);
    },
  },

  // ── Password step transitions ──────────────────────────────────────────
  //
  // After entering a password, the next state depends on the user's
  // attributes and the platform config:
  //   - No TOTP configured + MFA on → setup-secure (first-time TOTP setup)
  //   - TOTP configured + MFA on → login-totp-verify
  //   - MFA off → oidc-callback (direct completion)

  "login-password → setup-secure": {
    description: "Enter password (first-time login → TOTP setup)",
    action: async (page, user) => {
      await enterPassword(page, user.password!);
    },
  },

  "login-password → login-totp-verify": {
    description: "Enter password (returning user → TOTP verify)",
    action: async (page, user, ctx) => {
      await enterPassword(page, user.password!, { doubleSubmit: ctx.doubleSubmit });
      if (ctx.doubleSubmit) ctx.doubleSubmitConsumed = true;
    },
  },

  "login-password → login-backup-code-verify": {
    description: "Enter password (lookup secret flow → backup code verify)",
    action: async (page, user) => {
      await enterPassword(page, user.password!);
    },
  },

  "login-password → oidc-callback": {
    description: "Enter password (MFA off → direct callback)",
    action: async (page, user) => {
      await enterPassword(page, user.password!);
    },
  },

  // Error case: wrong password — stays on login-password. The scenario declares
  // `expectError: true`, which is what makes the runner read the error message
  // rather than only re-detecting the page.
  "login-password → login-password": {
    description: "Enter wrong password (error — stays on password page)",
    action: async (page, _user) => {
      await enterPassword(page, "Wrong-Password-456!");
    },
  },

  // ── TOTP setup transitions ─────────────────────────────────────────────

  "setup-secure → setup-complete": {
    description: "Complete TOTP setup — page auto-redirects to setup-complete",
    action: async (page, _user, ctx) => {
      const secret = await completeTotpSetup(page);
      // Store the secret for later use in TOTP verification
      ctx.totpSecret = secret;
    },
  },

  // ── Passkey (WebAuthn) setup transitions ────────────────────────────────
  //
  // Two ways in. With OIDC sequencing on (canonical-internal) login-ui
  // redirects here itself after an external OIDC login. Without it
  // (canonical-portal) nothing in the login journey points at
  // /ui/setup_passkey, and the page is reached the way a user reaches it: the
  // "Security key" entry of the self-serve navigation, which renders this same
  // page and rewrites the URL to ./setup_passkey?flow=<id>.
  //
  // The CDP-based virtual authenticator (WebAuthnHelper) must be set up
  // before these transitions are executed (handled in the spec file's
  // beforeEach and passed via ctx.webauthn).

  "start → setup-passkey": {
    description: "Open the self-service security-key page",
    action: async (page) => {
      // return_to is what Kratos redirects to once the key is registered.
      // kratos.yml declares no settings after-hooks, so without it Kratos falls
      // back to selfservice.flows.settings.ui_url — which points at
      // /ui/reset_password, not at anything passkey-shaped.
      const returnTo = `${LOGIN_UI_URL}/ui/setup_complete`;
      await page.goto(
        `${LOGIN_UI_URL}/ui/setup_passkey?return_to=${encodeURIComponent(returnTo)}`,
      );
      // The page creates its own settings flow; if the session cannot open one
      // it bounces to /ui/login instead, so wait for the form, not the URL.
      await expect(
        page.locator('[name="webauthn_register_displayname"]'),
      ).toBeVisible({ timeout: 15_000 });
    },
  },

  // With OIDC/WebAuthn sequencing on (canonical-internal), login-ui intercepts
  // after OIDC 1FA and steps the user up to a security key before releasing the
  // callback — so Dex login lands on the passkey pages, not the callback.
  "provider:dex:login → setup-passkey": {
    description: "Log in with Dex; sequencing diverts to security-key enrolment",
    action: async (page) => {
      await loginWithDex(page);
    },
  },

  "provider:dex:login → login-webauthn-verify": {
    description: "Log in with Dex; sequencing diverts to security-key verification",
    action: async (page) => {
      await loginWithDex(page);
    },
  },

  "setup-passkey → setup-complete": {
    description: "Register security key on passkey setup page — auto-redirects to setup-complete",
    action: async (page, _user, ctx) => {
      // Ensure the CDP virtual authenticator is active
      await ctx.webauthn?.setup();

      // Enter a name for the security key
      const nameInput = page.locator('[name="webauthn_register_displayname"]');
      await expect(nameInput).toBeVisible({ timeout: 10_000 });
      await nameInput.fill("Test Security Key");

      // Click "Add security key" — the CDP virtual authenticator with
      // automaticPresenceSimulation auto-responds to navigator.credentials.create()
      const addBtn = page.getByRole("button", { name: /add security key/i });
      await expect(addBtn).toBeVisible({ timeout: 10_000 });
      await addBtn.click();

      // Wait for the key to be registered (the page updates to show the key)
      // Then wait for redirect to setup-complete
      await page.waitForURL(/\/ui\/setup_complete/, { timeout: 30_000 });
    },
  },

  "setup-passkey → login-webauthn-verify": {
    description: "Register security key on passkey setup page — redirect to webauthn verify",
    action: async (page, _user, ctx) => {
      // Ensure the CDP virtual authenticator is active
      await ctx.webauthn?.setup();

      // Enter a name for the security key
      const nameInput = page.locator('[name="webauthn_register_displayname"]');
      await expect(nameInput).toBeVisible({ timeout: 10_000 });
      await nameInput.fill("Test Security Key");

      // Click "Add security key" — the CDP virtual authenticator with
      // automaticPresenceSimulation auto-responds to navigator.credentials.create()
      const addBtn = page.getByRole("button", { name: /add security key/i });
      await expect(addBtn).toBeVisible({ timeout: 10_000 });
      await addBtn.click();

      // After the WebAuthn ceremony completes, the settings flow is updated
      // and the page shows the registered key. The PasskeySequencedSignIn
      // component shows a "Sign in" button that redirects back to the login
      // flow for AAL2 verification.
      const signInBtn = page.locator('button:has-text("Sign in")').last();
      await expect(signInBtn).toBeVisible({ timeout: 15_000 });
      await signInBtn.click();

      // Wait for navigation away from the setup_passkey page.
      // The redirect goes back to the login flow with aal=aal2.
      await page.waitForURL(
        (url) => !url.toString().includes("/ui/setup_passkey"),
        { timeout: 30_000 },
      );
    },
  },

  "setup-passkey → oidc-callback": {
    description: "Register security key on passkey setup page — auto-redirects to OIDC callback",
    action: async (page, _user, ctx) => {
      // Ensure the CDP virtual authenticator is active
      await ctx.webauthn?.setup();

      // Enter a name for the security key
      const nameInput = page.locator('[name="webauthn_register_displayname"]');
      await expect(nameInput).toBeVisible({ timeout: 10_000 });
      await nameInput.fill("Test Security Key");

      // Click "Add security key" — the CDP virtual authenticator with
      // automaticPresenceSimulation auto-responds to navigator.credentials.create()
      const addBtn = page.getByRole("button", { name: /add security key/i });
      await expect(addBtn).toBeVisible({ timeout: 10_000 });
      await addBtn.click();

      // In the OIDC sequencing flow, after the WebAuthn ceremony completes,
      // the login-ui automatically redirects to the OIDC callback.
      // Wait for navigation away from the setup_passkey page.
      await page.waitForURL(
        (url) => !url.toString().includes("/ui/setup_passkey"),
        { timeout: 30_000 },
      );
    },
  },

  // ── Setup complete ─────────────────────────────────────────────────────

  "setup-complete → oidc-callback": {
    description: "Account setup complete — flow auto-continues to callback",
    action: async (_page) => {
      // No action needed — the page auto-redirects after setup completion
    },
  },

  // ── TOTP verify transitions ────────────────────────────────────────────

  "login-totp-verify → oidc-callback": {
    description: "Submit TOTP code",
    action: async (page, user, ctx) => {
      const secret = user.totpSecret ?? ctx.totpSecret;
      if (!secret) {
        throw new Error(
          "TOTP secret not available. Either the user must have totpSecret in the manifest, " +
          "or a previous phase must have set ctx.totpSecret via TOTP setup."
        );
      }
      await submitTotpCode(page, secret, Date.now(), { doubleSubmit: ctx.doubleSubmit });
      if (ctx.doubleSubmit) ctx.doubleSubmitConsumed = true;
    },
  },
  // ── Device flow (RFC 8628) ─────────────────────────────────────────────
  // The device half is an API call: startDeviceAuth() mints the
  // device_code/user_code pair with the manifest's RP client (public
  // endpoint + client_secret_post, so it runs on the live lane) and the
  // browser enters at hydra's own verification_uri_complete — exactly where
  // a real device's link/QR points. Hydra redirects to /ui/device_code with
  // the user code prefilled.
  "start → device-code": {
    description: "Mint a device_code with the manifest RP and open hydra's verification URL",
    action: async (page, _user, ctx) => {
      const auth = await startDeviceAuth(page);
      ctx.deviceCode = auth.deviceCode;
      // The property that makes the grant safe: possession of the
      // device_code alone yields NO tokens — hydra must answer
      // authorization_pending until the browser journey completes.
      await expectDeviceTokenPending(page, auth.deviceCode);
      await page.goto(auth.verificationUriComplete);
      await expect(page.getByRole("heading", { name: "Enter code to continue" })).toBeVisible();
    },
  },

  // Error self-transition (R-2 pattern): a user code hydra never issued.
  // login-ui's BFF answers its NOT_FOUND_ERROR_DESC ("invalid, expired or
  // already used") but the page collapses it to a generic "Something went
  // wrong, please try again" (observed 2026-08-31, login-ui:stable — the
  // S-8 message-collapse class; registered in config-model upstreamFindings).
  // The runner's expectError assertion needs only a visible, non-empty error.
  "device-code → device-code": {
    description: "Submit a user code hydra never issued (error — stays on the device page)",
    action: async (page) => {
      const field = page.getByRole("textbox");
      await field.clear();
      // Well-formed shape (8 chars), impossible value: hydra's user codes are
      // mixed-case base62 and an outstanding code equal to this literal would
      // be a collision, not a behaviour.
      await field.fill("wrongcod");
      await page.getByRole("button", { name: "Next" }).click();
    },
  },

  // The code arrives prefilled from the URL; Next hands the accepted
  // device_challenge to hydra, which opens a login_challenge journey.
  "device-code → login-email": {
    description: "Confirm the prefilled user code — hydra opens the login journey",
    action: async (page) => {
      await page.getByRole("button", { name: "Next" }).click();
    },
  },

  // Terminal: after the second factor, login-ui accepts the device session
  // and lands on urls.device.success (/ui/device_complete, "Sign in
  // successful … successfully connected"). No callback follows — the runner
  // polls the token endpoint with ctx.deviceCode instead.
  "login-totp-verify → device-complete": {
    description: "Submit TOTP — the device journey terminates on /ui/device_complete",
    action: async (page, user, ctx) => {
      const secret = user.totpSecret ?? ctx.totpSecret;
      if (!secret) {
        throw new Error(
          "TOTP secret not available. The user must have totpSecret in the manifest, " +
          "or a previous phase must have set ctx.totpSecret."
        );
      }
      await submitTotpCode(page, secret);
    },
  },

  "login-totp-verify → reset-password": {
    description: "Submit TOTP to clear the AAL2 gate on the recovery settings flow",
    action: async (page, user, ctx) => {
      const secret = user.totpSecret ?? ctx.totpSecret;
      if (!secret) {
        throw new Error(
          "TOTP secret not available for the AAL2 step of the recovery flow. " +
          "The identity must have totpSecret in the manifest.",
        );
      }
      await submitTotpCode(page, secret);
    },
  },

  "login-totp-verify → login-backup-code-verify": {
    description: "Switch to backup code verification",
    action: async (page) => {
      await page.getByRole("button", { name: "Use backup code instead" }).click();
    },
  },

  // Error case: rejected TOTP code — stays on login-totp-verify. Which kind of
  // rejection is the scenario's choice (`totpCodeWindow`); the scenario also
  // declares `expectError: true` so the runner reads the message.
  "login-totp-verify → login-totp-verify": {
    description: "Submit a rejected TOTP code (error — stays on verify page)",
    action: async (page, user, ctx) => {
      if (ctx.totpCodeWindow !== "expired") {
        await submitTotpCodeValue(page, "000000");
        return;
      }
      const secret = ctx.totpSecret ?? user.totpSecret;
      if (!secret) {
        throw new Error(
          `No TOTP secret for user "${user.ref}", so no expired code can be ` +
          "computed. Declare `user.totpConfigured: true` on the scenario, or " +
          "drop `totpCodeWindow: \"expired\"`.",
        );
      }
      // A code from a window Kratos rejects, computed rather than waited for.
      await submitTotpCode(page, secret, Date.now() - EXPIRED_TOTP_WINDOW_OFFSET_MS);
    },
  },

  // ── Tenant selection transitions ───────────────────────────────────────

  "tenant-selection → login-password": {
    description: "Select tenant",
    action: async (page, _user, ctx) => {
      const tenantName = ctx.selectTenant;
      if (!tenantName) {
        throw new Error(
          "Tenant name not specified. Set ctx.selectTenant or user.selectTenant in the scenario."
        );
      }
      await selectTenant(page, tenantName);
    },
  },

  "tenant-selection → login-totp-verify": {
    description: "Select tenant (MFA on, TOTP configured → TOTP verify)",
    action: async (page, _user, ctx) => {
      const tenantName = ctx.selectTenant;
      if (!tenantName) {
        throw new Error(
          "Tenant name not specified. Set ctx.selectTenant or user.selectTenant in the scenario."
        );
      }
      await selectTenant(page, tenantName);
    },
  },

  "tenant-selection → oidc-callback": {
    description: "Select tenant (session reuse — auto-completes after selection)",
    action: async (page, _user, ctx) => {
      const tenantName = ctx.selectTenant;
      if (!tenantName) {
        throw new Error(
          "Tenant name not specified. Set ctx.selectTenant or user.selectTenant in the scenario."
        );
      }
      await selectTenant(page, tenantName);
    },
  },

  // ── External provider (Dex) transitions ────────────────────────────────

  "provider:dex:login → oidc-callback": {
    description: "Login with Dex",
    action: async (page, user) => {
      await loginWithDex(page);
    },
  },

  "provider:dex:consent → oidc-callback": {
    description: "Accept Dex consent (auto-redirects)",
    action: async (_page) => {
      // Dex with skipApprovalScreen auto-redirects — no action needed
    },
  },

  // ── External provider (Google) transitions ─────────────────────────────

  "provider:google:login → provider:google:password": {
    description: "Enter Google email",
    action: async (page) => {
      if (!GOOGLE_TEST_EMAIL) {
        throw new Error("GOOGLE_TEST_EMAIL environment variable not set");
      }
      await enterGoogleEmail(page, GOOGLE_TEST_EMAIL);
    },
  },

  "provider:google:login → login-webauthn-verify": {
    description: "Google session reuse — auto-redirects to webauthn verify",
    action: async (page) => {
      // Google session persists from a previous phase. After clickGoogleLoginButton
      // navigated to accounts.google.com, Google auto-selects the session and
      // redirects back to the Kratos callback, which then redirects to the login-ui
      // for AAL2 (webauthn verify). We just need to wait for the browser to come
      // back to the login-ui.
      await page.waitForURL(
        (url) => {
          const s = url.toString();
          return s.includes("/ui/") && !s.includes("accounts.google.com");
        },
        { timeout: 30_000 },
      );
    },
  },

  "provider:google:password → provider:google:totp": {
    description: "Enter Google password",
    action: async (page) => {
      if (!GOOGLE_TEST_PASSWORD) {
        throw new Error("GOOGLE_TEST_PASSWORD environment variable not set");
      }
      await enterGooglePassword(page, GOOGLE_TEST_PASSWORD);
    },
  },

  "provider:google:totp → provider:google:confirm-identity": {
    description: "Enter Google TOTP code",
    action: async (page) => {
      if (!GOOGLE_TEST_TOTP_SECRET) {
        throw new Error("GOOGLE_TEST_TOTP_SECRET environment variable not set");
      }
      await enterGoogleTotp(page, GOOGLE_TEST_TOTP_SECRET);
    },
  },

  "provider:google:totp → provider:google:interstitial": {
    description: "Enter Google TOTP code (no identity confirmation — direct to interstitial)",
    action: async (page) => {
      if (!GOOGLE_TEST_TOTP_SECRET) {
        throw new Error("GOOGLE_TEST_TOTP_SECRET environment variable not set");
      }
      await enterGoogleTotp(page, GOOGLE_TEST_TOTP_SECRET);
    },
  },

  "provider:google:totp → oidc-callback": {
    description: "Enter Google TOTP code (no interstitial — direct callback)",
    action: async (page) => {
      if (!GOOGLE_TEST_TOTP_SECRET) {
        throw new Error("GOOGLE_TEST_TOTP_SECRET environment variable not set");
      }
      await enterGoogleTotp(page, GOOGLE_TEST_TOTP_SECRET);
    },
  },

  "provider:google:confirm-identity → provider:google:consent": {
    description: "Confirm Google identity (proceed to consent)",
    action: async (page) => {
      await confirmGoogleIdentity(page);
    },
  },

  "provider:google:confirm-identity → provider:google:interstitial": {
    description: "Confirm Google identity (proceed to interstitial)",
    action: async (page) => {
      await confirmGoogleIdentity(page);
    },
  },

  "provider:google:confirm-identity → oidc-callback": {
    description: "Confirm Google identity (direct to callback)",
    action: async (page) => {
      await confirmGoogleIdentity(page);
    },
  },

  "provider:google:confirm-identity → setup-passkey": {
    description: "Confirm Google identity (OIDC sequencing — redirect to passkey setup)",
    action: async (page) => {
      await confirmGoogleIdentity(page);
    },
  },

  "provider:google:confirm-identity → login-webauthn-verify": {
    description: "Confirm Google identity (OIDC sequencing — redirect to webauthn verify)",
    action: async (page) => {
      await confirmGoogleIdentity(page);
    },
  },

  // NOTE: consent and interstitial are handled internally by confirmGoogleIdentity.
  // These transitions exist for the transition validator but the action is a no-op
  // since confirmGoogleIdentity already navigated past these pages.
  "provider:google:consent → provider:google:interstitial": {
    description: "Allow Google consent (proceed to interstitial) — handled by confirmGoogleIdentity",
    action: async (_page) => {
      // Already handled by confirmGoogleIdentity
    },
  },

  "provider:google:consent → oidc-callback": {
    description: "Allow Google consent (direct to callback) — handled by confirmGoogleIdentity",
    action: async (_page) => {
      // Already handled by confirmGoogleIdentity
    },
  },

  "provider:google:interstitial → oidc-callback": {
    description: "Dismiss Google interstitial",
    action: async (page) => {
      await dismissGoogleInterstitial(page);
    },
  },

  // ── Backup code verify transitions ─────────────────────────────────────

  "login-backup-code-verify → oidc-callback": {
    description: "Submit backup recovery code",
    action: async (page, user, ctx) => {
      const code = ctx.backupCode ?? user.backupCode;
      if (!code) {
        throw new Error(
          "Backup code not available. Either the user must have backupCode in the manifest, " +
          "or a previous phase must have set ctx.backupCode."
        );
      }
      await verifyBackupCode(page, code);
    },
  },
  // The identity's ONLY second factor is lookup_secret (the post-unlink
  // state): enforced MFA accepts the code and then walks straight into TOTP
  // re-enrolment instead of completing to the callback (observed 2026-08-31
  // on login-ui:stable). "setup-secure → setup-complete" then captures the
  // fresh secret into ctx.totpSecret for later phases.
  "login-backup-code-verify → setup-secure": {
    description: "Submit backup code (no TOTP on the identity — enforced MFA walks into re-enrolment)",
    action: async (page, user, ctx) => {
      const code = ctx.backupCode ?? user.backupCode;
      if (!code) {
        throw new Error(
          "Backup code not available. Either the user must have backupCode in the manifest, " +
          "or a previous phase must have set ctx.backupCode."
        );
      }
      await verifyBackupCode(page, code);
    },
  },

  // Error self-transition (R-2 pattern): submit a code an earlier phase
  // already spent. Kratos rejects it visibly ("This backup code was already
  // used") and the flow stays put — the runner's expectError assertion reads
  // the message.
  "login-backup-code-verify → login-backup-code-verify": {
    description: "Submit an already-used backup code (error — stays on the backup code page)",
    action: async (page, user, ctx) => {
      const code = ctx.backupCode ?? user.backupCode;
      if (!code) {
        throw new Error(
          "Backup code not available. Either the user must have backupCode in the manifest, " +
          "or a previous phase must have set ctx.backupCode."
        );
      }
      await verifyBackupCode(page, code);
    },
  },

  // No consent-screen transition exists on purpose: login-ui auto-accepts
  // every consent request (remember=true, all scopes), so /ui/consent is
  // unreachable in this deployment and coverage was decided against
  // (docs/testing-spec.md §10 item 12). The provider consent states
  // (provider:dex:consent, provider:google:consent) are third-party IdP
  // surfaces and are unaffected.

  // ── Recovery flow transitions ──────────────────────────────────────────
  //
  // The recovery flow starts from the login page (click "Reset password")
  // or directly navigating to the recovery page. It uses Mailslurper
  // (via page.context()) to read the recovery code from email.

  "start → reset-email": {
    description: "Navigate to the recovery flow entry page",
    action: async (page, _user, ctx) => {
      assertInternalLane(ctx, "Recovery flow bootstrap");
      await startRecoveryFlow(page);
    },
  },

  "login-password → reset-email": {
    description: 'Click "Reset password" link on the login page',
    action: async (page) => {
      await page.getByRole("link", { name: "Reset password" }).click();
    },
  },

  "reset-email → reset-email-code": {
    description: "Enter email and submit the recovery form",
    action: async (page, user, ctx) => {
      // Snapshot the mailbox first: Mailslurper keeps mail across runs and this
      // identity is reused, so the code read afterwards must be one that did
      // not exist yet.
      ctx.mailCursor = await mailCursor(user.email);
      await page.getByLabel(/e-?mail/i).first().fill(user.email);
      await page.getByRole("button", { name: /reset password|submit/i }).click();
    },
  },

  "reset-email-code → login-totp-verify": {
    description:
      "Read the recovery code from Mailslurper and submit it. The resulting " +
      "session is only AAL1, so Kratos gates the settings flow behind an " +
      "aal=aal2 login before it will serve the reset-password page.",
    action: async (page, user, ctx) => {
      assertInternalLane(ctx, "Recovery email code retrieval");
      const code = await waitForMailCode({
        recipient: user.email,
        subject: MAIL_SUBJECTS.recovery,
        seen: ctx.mailCursor,
      });
      await page.getByLabel("Recovery code").fill(code);
      await page.getByRole("button", { name: "Submit" }).click();
    },
  },

  // ── Recovery code abuse ────────────────────────────────────────────────
  //
  // Kratos counts code submissions per flow and refuses past `max_submissions`
  // (default 5), invalidating the flow. The wrong-codes scenario deliberately
  // stays WITHIN the cap (recovery-scenarios.ts has the full evidence), so
  // there is exactly ONE transition here, the in-place rejection. Covering the
  // cap-trip itself (submission 6) needs a `reset-email-code → reset-email`
  // sibling and a final hop — blocked on the login-ui BFF nil-deref on that
  // path (pkg/kratos/service.go:737).
  "reset-email-code → reset-email-code": {
    description: "Submit a wrong recovery code (rejected — stays on the code step)",
    action: async (page) => {
      await submitWrongRecoveryCode(page);
    },
  },

  "reset-password → manage-details": {
    description:
      "Enter new password and submit — the settings flow carries " +
      "return_to=/ui/login, and login-ui bounces an already-authenticated " +
      "session on to ./manage_details",
    action: async (page, user, ctx) => {
      const newPassword = ctx.newPassword ?? "New-Secure-Password-456!";
      await enterNewPassword(page, newPassword);
      // Later phases (and the restore-password cleanup) must use the password
      // we just set, not the seeded one. readManifest() is per-test, so
      // mutating the ManifestUser is scoped to this test.
      ctx.newPassword = newPassword;
      user.password = newPassword;
    },
  },

  // ── Settings pages (the authenticated self-service hub) ────────────────
  //
  // /ui/manage_details is login-ui's settings hub; its nav routes to
  // manage_password (→ /ui/reset_password, heading "Change password"),
  // manage_backup_codes (→ /ui/setup_backup_codes) and manage_secure
  // (→ /ui/setup_secure). Every surface REUSES a URL the login/recovery
  // journeys already own, so no new page states exist — only these
  // transitions. All of them assume a live AAL2 session from an earlier
  // phase; none needs an admin API, so the settings scenarios run on the
  // live lane.

  "start → manage-details": {
    description:
      "Open the settings hub with a live session (login-ui serves it directly; " +
      "an earlier phase must have authenticated)",
    action: async (page) => {
      await page.goto(`${LOGIN_UI_URL}/ui/manage_details`);
    },
  },

  "manage-details → reset-password": {
    description: 'Open "Password" in the settings nav (lands on the Change password form)',
    action: async (page) => {
      await page.getByRole("link", { name: "Password", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    },
  },

  // Success is a SELF-transition: the form stays on /ui/reset_password with a
  // fresh flow id and a "Password was changed successfully" banner (observed
  // 2026-08-27 on iam.orange). The weak-password rejection is asserted here
  // too, as a prefix, because both outcomes live on the same state pair and
  // the transition table holds one action per pair.
  //
  // First traversal: submit a weak password (must be rejected VISIBLY), then a
  // new strong one; mutate user.password so later phases and the
  // restore-password cleanup authenticate with what is now true.
  // Second traversal (ctx.newPassword already set): submit the SEEDED password
  // back — the scenario's own path restores the shared identity, so a
  // completed walk leaves the deployment exactly as the seeder made it.
  "reset-password → reset-password": {
    description:
      "Change the password from settings: weak value rejected visibly, then " +
      "the real change (first pass) or the seeded-password restore (second pass)",
    action: async (page, user, ctx) => {
      const newField = page.getByLabel("New password", { exact: true });
      const confirmField = page.getByLabel("Confirm New password");
      const changeBtn = page.getByRole("button", { name: "Change password" });

      // Policy floor: too short, no uppercase, no digit. The UI's rejection is
      // DISABLING the submit (aria-disabled) — click-based probing would hang
      // on actionability, so the disabled state IS the visible-rejection
      // assertion. Kept inside the change scenario because a second
      // "reset-password → reset-password" action cannot exist.
      await newField.fill("abc");
      await confirmField.fill("abc");
      await expect(changeBtn).toBeDisabled();

      const restoring = ctx.newPassword !== undefined;
      if (restoring && !ctx.seededPassword) {
        throw new Error("settings restore pass: ctx.seededPassword is unset — the runner must snapshot it");
      }
      const target = restoring ? ctx.seededPassword! : "Settings-New-Password-789!";
      await newField.fill(target);
      await confirmField.fill(target);
      await expect(changeBtn).toBeEnabled();
      await changeBtn.click();
      await expect(page.getByText("Password was changed successfully")).toBeVisible();

      ctx.newPassword = restoring ? undefined : target;
      user.password = target;
    },
  },

  "manage-details → setup-backup-codes": {
    description: 'Open "Backup codes" in the settings nav',
    action: async (page) => {
      await page.getByRole("link", { name: "Backup codes", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Backup codes" })).toBeVisible();
    },
  },

  // Also a self-transition: /ui/setup_backup_codes re-renders in place for
  // BOTH of its operations, so one action serves two walks, branched on
  // ctx.backupCode (the "reset-password → reset-password" change/restore
  // precedent):
  //
  //  - First traversal (ctx.backupCode unset): create (or regenerate) codes
  //    and HARVEST one into ctx.backupCode. The page has two entry shapes —
  //    "Create backup codes" when none exist, "View backup codes"/
  //    "Deactivate backup codes" when some do. Newer login-ui (observed
  //    2026-08-31 on :stable) renders the fresh codes as CANDIDATES: nothing
  //    is stored until the "I saved the backup codes" checkbox enables the
  //    commit button — a code harvested without that click authenticates
  //    nowhere ("Invalid backup code"). Older login-ui (orange's
  //    v0.24–v0.25) commits on create and shows no checkbox. The action
  //    drives whichever shape renders. A later freshSession phase signing in
  //    with the harvested code is the only assertion that the codes this
  //    page hands out are real.
  //
  //  - Second traversal (ctx.backupCode set): DEACTIVATE the codes through
  //    the confirmation dialog and require the page to collapse to its
  //    no-codes shape. Server-side credential removal is the
  //    "backup-codes-deactivated" post check's contract, not this action's —
  //    after deactivation the login UI stops OFFERING the backup-code
  //    method, so no browser walk can reach a rejection.
  "setup-backup-codes → setup-backup-codes": {
    description: "Create backup codes and capture one (first pass) or deactivate them (second pass)",
    action: async (page, _user, ctx) => {
      const viewBtn = page.getByRole("button", { name: "View backup codes" });
      const createBtn = page.getByRole("button", { name: /^Create( new)? backup codes$/ });
      const deactivateBtn = page.getByRole("button", { name: "Deactivate backup codes" });

      if (ctx.backupCode) {
        // Deactivate pass. The dialog repeats the trigger button's accessible
        // name, so scope the confirm click to the dialog.
        await deactivateBtn.click();
        const dialog = page.getByRole("dialog", { name: "Deactivate backup codes" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Deactivate backup codes" }).click();
        await expect(page.getByRole("button", { name: "Create backup codes", exact: true })).toBeVisible();
        await expect(deactivateBtn).not.toBeVisible();
        return;
      }

      // Create pass. Wait for the page to settle on either entry shape before
      // branching — isVisible() does not wait.
      await expect(createBtn.or(viewBtn).first()).toBeVisible();
      if (await viewBtn.isVisible()) {
        await viewBtn.click();
      }
      await createBtn.click();

      // Unused codes render as 8-char lowercase alphanumerics; consumed ones
      // render as the literal "Used". Freshly created ⇒ all lines are codes.
      const harvest = async () => {
        const codes = (await page.locator("main").innerText())
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[a-z0-9]{8}$/.test(l));
        if (codes.length === 0) {
          throw new Error("setup-backup-codes: created codes but none are visible to harvest");
        }
        ctx.backupCode = codes[0];
      };

      // Two post-create shapes: the candidate list behind the "I saved the
      // backup codes" confirm (newer UI), or the already-committed toolbar
      // with "Deactivate backup codes" (older UI).
      const savedCheckbox = page.getByLabel("I saved the backup codes");
      await expect(savedCheckbox.or(deactivateBtn).first()).toBeVisible();

      if (await savedCheckbox.isVisible()) {
        // Harvest from the candidate list, then COMMIT — the codes do not
        // exist server-side until this click.
        await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
        await harvest();
        // Vanilla-framework checkbox: the styled label span intercepts
        // pointer events over the input, so .check() on the input times out —
        // click the label and assert the input state instead.
        await page.getByText("I saved the backup codes").click();
        await expect(savedCheckbox).toBeChecked();
        const commitBtn = page.getByRole("button", { name: "Create backup codes", exact: true });
        await expect(commitBtn).toBeEnabled();
        await commitBtn.click();
        await expect(deactivateBtn).toBeVisible();
      } else {
        // Committed on create; open the view if the page collapsed, then
        // harvest from the stored list.
        if (await viewBtn.isVisible().catch(() => false)) {
          await viewBtn.click();
        }
        await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
        await harvest();
      }
    },
  },

  // /ui/setup_secure with TOTP already linked ("setup-secure-linked", a
  // DOM-split of the same URL — see helpers/page-state.ts). Unlinking
  // re-renders the enrolment shape in place; server-side it deletes the totp
  // credential and KEEPS lookup_secret, which is why the next login lands on
  // "login-password → login-backup-code-verify".
  "manage-details → setup-secure-linked": {
    description: 'Open "Authenticator" in the settings nav (TOTP linked — lands on the unlink shape)',
    action: async (page) => {
      await page.getByRole("link", { name: "Authenticator", exact: true }).click();
      await expect(page.getByRole("button", { name: "Unlink TOTP Authenticator App" })).toBeVisible();
    },
  },

  "setup-secure-linked → setup-secure": {
    description: "Unlink the TOTP authenticator (page re-renders the enrolment shape in place)",
    action: async (page) => {
      await page.getByRole("button", { name: "Unlink TOTP Authenticator App" }).click();
      await expect(page.getByRole("textbox", { name: "Verify code" })).toBeVisible();
    },
  },

  // ── Registration flow transitions ──────────────────────────────────────
  //
  // The registration flow starts from the registration page. It follows
  // a different path than the OIDC login flow.

  "start → register-email": {
    description: "Navigate to the registration flow entry page",
    action: async (page, _user, ctx) => {
      assertInternalLane(ctx, "Registration flow bootstrap");
      await startRegistrationFlow(page);
    },
  },

  "register-email → register-password": {
    description: "Enter email and submit the registration form",
    action: async (page, user) => {
      await page.getByLabel(/e-?mail/i).first().fill(user.email);
      await page.getByRole("button", { name: /next|sign up/i }).click();
    },
  },

  "register-password → verification": {
    description:
      "Enter valid password and submit — Kratos' verification hook returns " +
      "continue_with[show_verification_ui] and RegisterPassword.tsx follows it",
    action: async (page, _user, ctx) => {
      const password = ctx.newPassword ?? DEFAULT_TEST_PASSWORD;
      await fillRegistrationPassword(page, password);
    },
  },

  // ── Verification flow transitions ──────────────────────────────────────
  //
  // The verification flow starts from a verification link or by navigating
  // to the verification page. It uses Mailslurper to read the code.

  "start → verification": {
    description: "Bootstrap the verification flow and advance to the code step",
    action: async (page, user, ctx) => {
      assertInternalLane(ctx, "Verification flow bootstrap");
      // Snapshot before the address step, which is what triggers the email.
      ctx.mailCursor = await mailCursor(user.email);
      await startVerificationFlow(page, user.email);
    },
  },

  "verification → login-email": {
    description: "Enter the emailed verification code; Kratos returns to login",
    action: async (page, user, ctx) => {
      assertInternalLane(ctx, "Verification email code retrieval");
      const code = await waitForMailCode({
        recipient: user.email,
        subject: MAIL_SUBJECTS.verification,
        seen: ctx.mailCursor,
      });
      // The field's accessible name is "Verification code Resend code" — the
      // adjacent resend button sits inside the label — and the submit control
      // is "Continue", not "Submit".
      //
      // Type per character rather than fill(): login-ui's Flow component keeps
      // a controlled value map that it re-initialises from the flow's nodes
      // whenever the flow object identity changes. A single fill() racing that
      // reconciliation sets the DOM value but not React state, and the form
      // then POSTs without a `code` at all — which Kratos rejects as a missing
      // address. Assert the value stuck so a regression fails loudly.
      const codeField = page.getByLabel(/verification code/i);
      await codeField.pressSequentially(code, { delay: 20 });
      await expect(codeField).toHaveValue(code);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    },
  },

  // The scenario declares `expectError: true`; the runner reads the message.
  "verification → verification": {
    description: "Submit invalid verification code (error — stays on verification page)",
    action: async (page) => {
      await page.getByLabel(/verification code/i).fill("000000");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    },
  },

  // ── WebAuthn flow transitions ──────────────────────────────────────────
  //
  // WebAuthn uses the existing login flow pages but with WebAuthn-specific
  // node groups. The virtual authenticator must be set up before these
  // transitions are executed (handled in the spec file's beforeEach).

  "login-password → login-webauthn-verify": {
    description: "Enter password (WebAuthn is the 2FA method)",
    action: async (page, user) => {
      await enterPassword(page, user.password!);
    },
  },

  "login-webauthn-verify → oidc-callback": {
    description: "Authenticate with WebAuthn virtual authenticator",
    action: async (page, _user, ctx) => {
      // Ensure the CDP virtual authenticator is active
      await ctx.webauthn?.setup();

      // The CDP virtual authenticator with automaticPresenceSimulation
      // auto-responds to navigator.credentials.get(); the ceremony still needs
      // an explicit click. Match the Kratos node name, not the button label:
      // the label text varies with whether OIDC sequencing is on, and is never
      // an exact "Sign in".
      await page.locator('button[name="webauthn_login_trigger"]').click();
    },
  },

  // ── Edge case transitions ──────────────────────────────────────────────

  // Backup code regeneration prompt after using a backup code
  "login-backup-code-verify → backup-code-regenerate": {
    description: "Authenticate with backup code (shows regeneration prompt)",
    action: async (page, user, ctx) => {
      const code = ctx.backupCode ?? user.backupCode;
      if (!code) {
        throw new Error(
          "Backup code not available. Either the user must have backupCode in the manifest, " +
          "or a previous phase must have set ctx.backupCode."
        );
      }
      await verifyBackupCode(page, code);
    },
  },

  "backup-code-regenerate → oidc-callback": {
    description: 'Skip regeneration, continue to callback ("I don\'t need new codes, sign in")',
    action: async (page) => {
      await page.getByRole("button", { name: "I don't need new codes" }).click();
    },
  },
};
