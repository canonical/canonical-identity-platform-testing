// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** The transition table: every known (fromState → toState) pair and the action
 *  that drives the browser through it. Scenarios declare the path they expect;
 *  a UI change is fixed in one entry here, not in every scenario. */

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
import { startOIDCFlowWithParams, expectOIDCFlowComplete, startDeviceAuth, expectDeviceTokenPending } from "../helpers/oidc";
// Error-path starts terminate on /ui/oidc_error or the RP error page, which the
// oidc.ts starter never waits for; they use the raw hydra navigation instead.
import { startOIDCFlowWithParams as startAuthorizeNavigation } from "../helpers/hydra";
import { verifyBackupCode } from "../helpers/backupCode";
import { selectTenant } from "../helpers/navigation";
import { MAIL_SUBJECTS, mailCursor, waitForMailCode } from "../helpers/mail";
import { enterNewPassword, fillRegistrationPassword } from "../helpers/password";
import { startRecoveryFlow, startVerificationFlow, startRegistrationFlow } from "../helpers/kratos";
import { resendVerificationCode } from "../helpers/resend";
import { LOGIN_UI_URL } from "../helpers/config";
import { isDexUrl } from "../helpers/page-state";
import { DEFAULT_TEST_PASSWORD } from "../helpers/test-credentials";
import type { ExecutionLane } from "../helpers/config";
import type { MailCursor } from "../helpers/mail";
import type { WebAuthnHelper } from "../helpers/webauthn";
import type { ManifestUser } from "../seeder/manifest-schema";

// --- Transition action types ---

/** Additional context passed to action functions. */
export interface ActionContext {
  lane?: ExecutionLane;
  flowParams?: Record<string, string>;
  selectTenant?: string;
  totpSecret?: string;
  /** Unset → a wrong code ("000000"); "expired" → a well-formed code from a
   *  window Kratos no longer accepts. */
  totpCodeWindow?: "expired";
  /** Unset → a junk code; "stale-after-resend" → run the resend flow and submit
   *  the ORIGINAL code the resend invalidated. */
  verificationCodeSubmission?: "stale-after-resend";
  backupCode?: string;
  /** Minted by "start → device-code"; the runner redeems it at the token endpoint after device-complete. */
  deviceCode?: string;
  /** Set by the runner for a "double-submit" intervention. The action MUST forward it
   *  to its submit helper and set doubleSubmitConsumed; the runner fails the test
   *  otherwise, so an unsupported transition cannot downgrade the intervention. */
  doubleSubmit?: boolean;
  doubleSubmitConsumed?: boolean;
  newPassword?: string;
  /** Snapshotted by the runner before any transition mutates `user.password`; the settings restore pass submits it. */
  seededPassword?: string;
  mailCursor?: MailCursor;
  googleEmail?: string;
  googlePassword?: string;
  googleTotpSecret?: string;
  webauthn?: WebAuthnHelper;
}

export type ActionFunction = (
  page: Page,
  user: ManifestUser,
  ctx: ActionContext,
) => Promise<void>;

export interface TransitionAction {
  description: string;
  action: ActionFunction;
}

export type TransitionKey = `${string} → ${string}`;

export type TransitionTable = Record<TransitionKey, TransitionAction>;

/** Hard backstop behind lane metadata: every action that uses an internal-only surface calls this first. */
export function assertInternalLane(ctx: ActionContext, feature: string): void {
  if (ctx.lane === "live") {
    throw new Error(`${feature} is not available in live lane`);
  }
}

/** Well-formed (4–8 digits) but never issued: rejected on lookup, not validation,
 *  which is the rejection the code-abuse scenario is about. */
const WRONG_RECOVERY_CODE = "000000";

async function submitWrongRecoveryCode(page: Page): Promise<void> {
  await page.getByLabel("Recovery code").fill(WRONG_RECOVERY_CODE);
  await page.getByRole("button", { name: "Submit" }).click();
}

// --- Shared action bodies ---

const startOIDCFlowAction: ActionFunction = async (page, _user, ctx) => {
  await startOIDCFlowWithParams(page, ctx.flowParams ?? {});
};

const startAuthorizeErrorAction: ActionFunction = async (page, _user, ctx) => {
  await startAuthorizeNavigation(page, ctx.flowParams ?? {});
  await page.waitForLoadState("load");
};

const enterEmailAction: ActionFunction = async (page, user) => {
  await enterEmail(page, user.email);
};

// Forwards ctx.doubleSubmit unconditionally: unset means a single click.
const enterPasswordAction: ActionFunction = async (page, user, ctx) => {
  await enterPassword(page, user.password!, { doubleSubmit: ctx.doubleSubmit });
  if (ctx.doubleSubmit) ctx.doubleSubmitConsumed = true;
};

const selectTenantAction: ActionFunction = async (page, _user, ctx) => {
  const tenantName = ctx.selectTenant;
  if (!tenantName) {
    throw new Error(
      "Tenant name not specified. Set ctx.selectTenant or user.selectTenant in the scenario."
    );
  }
  await selectTenant(page, tenantName);
};

const confirmGoogleIdentityAction: ActionFunction = async (page) => {
  await confirmGoogleIdentity(page);
};

const verifyBackupCodeAction: ActionFunction = async (page, user, ctx) => {
  const code = ctx.backupCode ?? user.backupCode;
  if (!code) {
    throw new Error(
      "Backup code not available. Either the user must have backupCode in the manifest, " +
      "or a previous phase must have set ctx.backupCode."
    );
  }
  await verifyBackupCode(page, code);
};

/** Name the key and click "Add security key"; each caller waits for its own landing. */
async function registerSecurityKey(page: Page, ctx: ActionContext): Promise<void> {
  await ctx.webauthn?.setup();

  const nameInput = page.locator('[name="webauthn_register_displayname"]');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill("Test Security Key");

  const addBtn = page.getByRole("button", { name: /add security key/i });
  await expect(addBtn).toBeVisible({ timeout: 10_000 });
  await addBtn.click();
}

// --- Transition table ---

export const TRANSITION_TABLE: TransitionTable = {
  // --- Starting the flow ("start" = the initial navigation to the consumer app) ---

  "start → login-email": {
    description: "Start OIDC authorization code flow",
    action: startOIDCFlowAction,
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
    action: startOIDCFlowAction,
  },

  // Error states are only reachable from `start`; a mid-journey hop into one is an
  // illegal transition. Hydra splits on redirect-URI validity: unvalidatable client/
  // redirect → login-ui /ui/oidc_error, otherwise ?error= back to the RP callback.
  "start → oidc-error-page": {
    description: "Start OIDC flow with a malformed authorize request (unvalidatable client/redirect)",
    action: startAuthorizeErrorAction,
  },

  "start → oidc-callback-error": {
    description: "Start OIDC flow expecting an RP-side error redirect",
    action: startAuthorizeErrorAction,
  },

  // --- Identifier-first transitions ---

  "login-email → login-password": {
    description: "Enter email and continue",
    action: enterEmailAction,
  },

  "login-email → tenant-selection": {
    description: "Enter email and continue (tenant selection follows)",
    action: enterEmailAction,
  },

  "login-email → provider:dex:login": {
    description: "Enter email, then click Dex login button",
    action: async (page, user) => {
      await enterEmail(page, user.email);
      await clickDexLoginButton(page);
    },
  },

  "login-email → provider:google:login": {
    description: "Click Google login (after the email step when the page only offers providers per identity)",
    action: async (page, user) => {
      // Older login-ui builds render provider buttons on the first page; newer identifier-first
      // builds offer them only after the email step, to identities that carry the credential.
      if (!(await page.getByRole("button", { name: /sign in with google/i }).isVisible())) {
        await enterEmail(page, user.email);
      }
      await clickGoogleLoginButton(page);
    },
  },

  // --- Password step transitions ---

  "login-password → setup-secure": {
    description: "Enter password (first-time login → TOTP setup)",
    action: enterPasswordAction,
  },

  "login-password → login-totp-verify": {
    description: "Enter password (returning user → TOTP verify)",
    action: enterPasswordAction,
  },

  "login-password → login-backup-code-verify": {
    description: "Enter password (lookup secret flow → backup code verify)",
    action: enterPasswordAction,
  },

  "login-password → oidc-callback": {
    description: "Enter password (MFA off → direct callback)",
    action: enterPasswordAction,
  },

  "login-password → login-password": {
    description: "Enter wrong password (error — stays on password page)",
    action: async (page, _user) => {
      await enterPassword(page, "Wrong-Password-456!");
    },
  },

  // --- TOTP setup transitions ---

  "setup-secure → setup-complete": {
    description: "Complete TOTP setup — page auto-redirects to setup-complete",
    action: async (page, _user, ctx) => {
      const secret = await completeTotpSetup(page);
      ctx.totpSecret = secret;
    },
  },

  // --- Passkey (WebAuthn) setup transitions ---
  // Reached via login-ui's OIDC sequencing (canonical-internal) or the self-serve
  // "Security key" nav entry (canonical-portal); ctx.webauthn must be set up first.

  "start → setup-passkey": {
    description: "Open the self-service security-key page",
    action: async (page) => {
      // return_to: kratos.yml has no settings after-hooks, so Kratos would otherwise fall back to settings.ui_url (/ui/reset_password).
      const returnTo = `${LOGIN_UI_URL}/ui/setup_complete`;
      await page.goto(
        `${LOGIN_UI_URL}/ui/setup_passkey?return_to=${encodeURIComponent(returnTo)}`,
      );
      // The page bounces to /ui/login if it cannot open a settings flow, so wait for the form, not the URL.
      await expect(
        page.locator('[name="webauthn_register_displayname"]'),
      ).toBeVisible({ timeout: 15_000 });
    },
  },

  "provider:dex:login → setup-passkey": {
    description: "Log in with Dex; sequencing diverts to security-key enrolment",
    action: async (page, user) => {
      await loginWithDex(page, user.email);
    },
  },

  "provider:dex:login → login-webauthn-verify": {
    description: "Log in with Dex; sequencing diverts to security-key verification",
    action: async (page, user) => {
      await loginWithDex(page, user.email);
    },
  },

  "setup-passkey → setup-complete": {
    description: "Register security key on passkey setup page — auto-redirects to setup-complete",
    action: async (page, _user, ctx) => {
      await registerSecurityKey(page, ctx);

      await page.waitForURL(/\/ui\/setup_complete/, { timeout: 30_000 });
    },
  },

  "setup-passkey → login-webauthn-verify": {
    description: "Register security key on passkey setup page — redirect to webauthn verify",
    action: async (page, _user, ctx) => {
      await registerSecurityKey(page, ctx);

      // PasskeySequencedSignIn renders a "Sign in" button that returns to the login flow for AAL2.
      const signInBtn = page.locator('button:has-text("Sign in")').last();
      await expect(signInBtn).toBeVisible({ timeout: 15_000 });
      await signInBtn.click();

      await page.waitForURL(
        (url) => !url.toString().includes("/ui/setup_passkey"),
        { timeout: 30_000 },
      );
    },
  },

  "setup-passkey → oidc-callback": {
    description: "Register security key on passkey setup page — auto-redirects to OIDC callback",
    action: async (page, _user, ctx) => {
      await registerSecurityKey(page, ctx);

      await page.waitForURL(
        (url) => !url.toString().includes("/ui/setup_passkey"),
        { timeout: 30_000 },
      );
    },
  },

  // --- Setup complete ---

  "setup-complete → oidc-callback": {
    description: "Account setup complete — flow auto-continues to callback",
    action: async (_page) => {
    },
  },

  // --- TOTP verify transitions ---

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
  // --- Device flow (RFC 8628) ---
  // startDeviceAuth() mints the device_code/user_code pair via the RP client; the
  // browser enters at hydra's verification_uri_complete, as a real device's link would.
  "start → device-code": {
    description: "Mint a device_code with the manifest RP and open hydra's verification URL",
    action: async (page, _user, ctx) => {
      const auth = await startDeviceAuth(page);
      ctx.deviceCode = auth.deviceCode;
      // Possession of the device_code alone yields no tokens: hydra answers authorization_pending until the browser completes.
      await expectDeviceTokenPending(page, auth.deviceCode);
      await page.goto(auth.verificationUriComplete);
      await expect(page.getByRole("heading", { name: "Enter code to continue" })).toBeVisible();
    },
  },

  // PUT /api/device answers a raw HTTP 500 for an unissued code and the page renders a generic
  // "Something went wrong"; no rate limit exists on user-code attempts (RFC 8628 §5.2 recommends one).
  "device-code → device-code": {
    description: "Submit a user code hydra never issued (error — stays on the device page)",
    action: async (page) => {
      const field = page.getByRole("textbox");
      await field.clear();
      // Well-formed (8 chars) but impossible: hydra's user codes are mixed-case base62.
      await field.fill("wrongcod");
      await page.getByRole("button", { name: "Next" }).click();
    },
  },

  "device-code → login-email": {
    description: "Confirm the prefilled user code — hydra opens the login journey",
    action: async (page) => {
      await page.getByRole("button", { name: "Next" }).click();
    },
  },

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
      await submitTotpCode(page, secret, Date.now() - EXPIRED_TOTP_WINDOW_OFFSET_MS);
    },
  },

  // --- Tenant selection transitions ---

  "tenant-selection → login-password": {
    description: "Select tenant",
    action: selectTenantAction,
  },

  "tenant-selection → login-totp-verify": {
    description: "Select tenant (MFA on, TOTP configured → TOTP verify)",
    action: selectTenantAction,
  },

  // Tenant lookup keys on the identifier, so selection precedes the Dex button.
  "tenant-selection → provider:dex:login": {
    description: "Select tenant, then click the Dex login button",
    action: async (page, _user, ctx) => {
      const tenantName = ctx.selectTenant;
      if (!tenantName) {
        throw new Error(
          "Tenant name not specified. Set ctx.selectTenant or user.selectTenant in the scenario."
        );
      }
      await selectTenant(page, tenantName);
      await clickDexLoginButton(page);
    },
  },

  "tenant-selection → oidc-callback": {
    description: "Select tenant (session reuse — auto-completes after selection)",
    action: selectTenantAction,
  },

  // --- External provider (Dex) transitions ---

  "provider:dex:login → oidc-callback": {
    description: "Login with Dex",
    action: async (page, user) => {
      // The manifest email doubles as the dex static-password account — never hardcode one.
      await loginWithDex(page, user.email);
    },
  },
  "login-totp-verify → manage-details": {
    description: "Submit TOTP — the challenge-less link login lands on the settings hub",
    action: async (page, user, ctx) => {
      const secret = user.totpSecret ?? ctx.totpSecret;
      if (!secret) {
        throw new Error("TOTP secret not available for the link login's second factor.");
      }
      await submitTotpCode(page, secret);
    },
  },
  // The password submit links and issues a session (200 + bare session) but the response
  // carries no continue_with, so the SPA renders nothing; walk on by navigation.
  "login-password → manage-details": {
    description: "Submit the existing password on the authenticate-to-link page — linked and sessioned; the SPA strands, so walk on",
    action: async (page, user) => {
      const submitted = page.waitForResponse(
        (r) => r.url().includes("/self-service/login?") && r.request().method() === "POST",
        { timeout: 15_000 },
      );
      await enterPassword(page, user.password!);
      const response = await submitted;
      expect(response.status(), "the link submit must succeed (200 + session)").toBe(200);
      await page.goto(`${LOGIN_UI_URL}/ui/manage_details`);
      // Let the hub's fetches finish: a 401 in flight after the next phase clears cookies bounces the SPA to /ui/login.
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    },
  },

  // --- Account linking ---
  // Login-time linking enters from the REGISTER page; the login page only offers providers to identities that already carry the oidc credential.
  "register-email → provider:dex:login": {
    description: 'Click "Sign in with Dex" on the registration page',
    action: async (page) => {
      await page.getByRole("button", { name: /sign in with dex$/i }).click();
      await page.waitForURL((url) => isDexUrl(url.href), { timeout: 15_000 }).catch(() => {});
    },
  },

  // The authenticate-to-link page (/ui/login?flow=…&no_org_ui=true) is DOM-identical to the password page.
  "provider:dex:login → login-password": {
    description: "Dex login for a colliding address — kratos asks for the existing password to link",
    action: async (page, user) => {
      await loginWithDex(page, user.email);
    },
  },

  // Connect buttons render one per provider, dex first.
  "connected-accounts → provider:dex:login": {
    description: 'Click Connect on the dex row of /ui/manage_connected_accounts',
    action: async (page) => {
      await page.getByRole("button", { name: "Connect" }).first().click();
      await page.waitForURL((url) => isDexUrl(url.href), { timeout: 15_000 }).catch(() => {});
    },
  },

  // The settings flow carries no return_to, so kratos lands on settings.ui_url (/ui/reset_password).
  "provider:dex:login → reset-password": {
    description: "Dex login from the settings Connect — kratos lands on the settings ui_url fallback",
    action: async (page, user) => {
      await loginWithDex(page, user.email);
    },
  },

  "connected-accounts → connected-accounts": {
    description: "Disconnect the linked provider (page re-renders unlinked)",
    action: async (page) => {
      await page.getByRole("button", { name: "Disconnect" }).first().click();
      await expect(page.getByRole("button", { name: "Connect" }).first()).toBeVisible();
    },
  },

  "manage-details → connected-accounts": {
    description: 'Open "Connected accounts" in the settings nav',
    action: async (page) => {
      await page.getByRole("link", { name: "Connected accounts", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
    },
  },

  "provider:dex:consent → oidc-callback": {
    description: "Accept Dex consent (auto-redirects)",
    action: async (_page) => {
    },
  },

  // --- External provider (Google) transitions ---

  "provider:google:login → provider:google:password": {
    description: "Enter Google email",
    action: async (page) => {
      if (!GOOGLE_TEST_EMAIL) {
        throw new Error("GOOGLE_TEST_EMAIL environment variable not set");
      }
      await enterGoogleEmail(page, GOOGLE_TEST_EMAIL);
    },
  },

  // A live Google session auto-selects the account sub-second, so provider:google:login is never observable.
  "login-email → login-webauthn-verify": {
    description: "Enter email, click Google — a live Google session bounces straight to webauthn verify",
    action: async (page, user) => {
      await enterEmail(page, user.email);
      const googleButton = page.getByRole("button", { name: /sign in with google/i });
      await expect(googleButton).toBeVisible({ timeout: 10_000 });
      const before = page.url();
      await googleButton.click();
      await page.waitForURL(
        (url) => {
          const s = url.toString();
          return s !== before && s.includes("/ui/") && !s.includes("accounts.google.com");
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
    action: confirmGoogleIdentityAction,
  },

  "provider:google:confirm-identity → provider:google:interstitial": {
    description: "Confirm Google identity (proceed to interstitial)",
    action: confirmGoogleIdentityAction,
  },

  "provider:google:confirm-identity → oidc-callback": {
    description: "Confirm Google identity (direct to callback)",
    action: confirmGoogleIdentityAction,
  },

  "provider:google:confirm-identity → setup-passkey": {
    description: "Confirm Google identity (OIDC sequencing — redirect to passkey setup)",
    action: confirmGoogleIdentityAction,
  },

  "provider:google:confirm-identity → login-webauthn-verify": {
    description: "Confirm Google identity (OIDC sequencing — redirect to webauthn verify)",
    action: confirmGoogleIdentityAction,
  },

  // consent/interstitial are navigated by confirmGoogleIdentity; these entries only satisfy the validator.
  "provider:google:consent → provider:google:interstitial": {
    description: "Allow Google consent (proceed to interstitial) — handled by confirmGoogleIdentity",
    action: async (_page) => {
    },
  },

  "provider:google:consent → oidc-callback": {
    description: "Allow Google consent (direct to callback) — handled by confirmGoogleIdentity",
    action: async (_page) => {
    },
  },

  "provider:google:interstitial → oidc-callback": {
    description: "Dismiss Google interstitial",
    action: async (page) => {
      await dismissGoogleInterstitial(page);
    },
  },

  // --- Backup code verify transitions ---

  "login-backup-code-verify → oidc-callback": {
    description: "Submit backup recovery code",
    action: verifyBackupCodeAction,
  },
  // lookup_secret is the only second factor, so enforced MFA walks into TOTP re-enrolment instead of the callback.
  "login-backup-code-verify → setup-secure": {
    description: "Submit backup code (no TOTP on the identity — enforced MFA walks into re-enrolment)",
    action: verifyBackupCodeAction,
  },

  "login-backup-code-verify → login-backup-code-verify": {
    description: "Submit an already-used backup code (error — stays on the backup code page)",
    action: verifyBackupCodeAction,
  },

  // No /ui/consent transition: login-ui auto-accepts every consent request, so the page is unreachable.

  // --- Recovery flow transitions ---

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
      // Snapshot first: Mailslurper keeps mail across runs, so the code read must postdate this.
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

  // --- Recovery code abuse ---
  // Kratos refuses past `max_submissions` (default 5) and invalidates the flow; the
  // scenario stays within the cap, so the only transition here is the in-place rejection.
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
      ctx.newPassword = newPassword;
      user.password = newPassword;
    },
  },

  // --- Settings pages (the authenticated self-service hub) ---
  // Every settings surface reuses a URL the login/recovery journeys own, so no new page
  // states exist; all assume a live AAL2 session and none needs an admin API (live lane).

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

  // Self-transition: success stays on /ui/reset_password with a new flow id. First pass
  // changes the password (weak value rejected first); second pass (ctx.newPassword set)
  // restores the seeded password so a completed walk leaves the identity as seeded.
  "reset-password → reset-password": {
    description:
      "Change the password from settings: weak value rejected visibly, then " +
      "the real change (first pass) or the seeded-password restore (second pass)",
    action: async (page, user, ctx) => {
      const newField = page.getByLabel("New password", { exact: true });
      const confirmField = page.getByLabel("Confirm New password");
      const changeBtn = page.getByRole("button", { name: "Change password" });

      // The UI rejects a weak password by DISABLING submit (aria-disabled); clicking would
      // hang on actionability, so the disabled state is the assertion.
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

  // Self-transition branched on ctx.backupCode: first pass creates codes and harvests one;
  // second pass deactivates through the dialog. Newer login-ui stores nothing until the
  // "I saved the backup codes" checkbox commits; older (v0.24–v0.25) commits on create.
  "setup-backup-codes → setup-backup-codes": {
    description: "Create backup codes and capture one (first pass) or deactivate them (second pass)",
    action: async (page, _user, ctx) => {
      const viewBtn = page.getByRole("button", { name: "View backup codes" });
      const createBtn = page.getByRole("button", { name: /^Create( new)? backup codes$/ });
      const deactivateBtn = page.getByRole("button", { name: "Deactivate backup codes" });

      if (ctx.backupCode) {
        // The dialog repeats the trigger button's name, so scope the confirm click to the dialog.
        await deactivateBtn.click();
        const dialog = page.getByRole("dialog", { name: "Deactivate backup codes" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Deactivate backup codes" }).click();
        await expect(page.getByRole("button", { name: "Create backup codes", exact: true })).toBeVisible();
        await expect(deactivateBtn).not.toBeVisible();
        return;
      }

      // Wait for either entry shape before branching — isVisible() does not wait.
      await expect(createBtn.or(viewBtn).first()).toBeVisible();
      if (await viewBtn.isVisible()) {
        await viewBtn.click();
      }
      await createBtn.click();

      // Unused codes render as 8-char lowercase alphanumerics; consumed ones as "Used".
      const unusedCodes = async () =>
        (await page.locator("main").innerText())
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[a-z0-9]{8}$/.test(l));
      const harvest = async () => {
        const codes = await unusedCodes();
        if (codes.length === 0) {
          throw new Error("setup-backup-codes: created codes but none are visible to harvest");
        }
        ctx.backupCode = codes[0];
      };

      // Wait for what the create produced: the candidate list behind the confirm checkbox
      // (newer UI), fresh codes (older UI commits on create) or the View button that hides
      // them. An identity that already had codes still shows its old list (Deactivate,
      // Download, all "Used") until the new state renders — that list is not the result.
      const savedCheckbox = page.getByLabel("I saved the backup codes");
      await expect
        .poll(async () => (await savedCheckbox.isVisible()) || (await viewBtn.isVisible()) || (await unusedCodes()).length > 0, {
          message: "setup-backup-codes: the create produced neither candidates nor fresh codes",
          timeout: 15_000,
        })
        .toBe(true);

      if (await savedCheckbox.isVisible()) {
        // Harvest, then commit — the codes do not exist server-side until this click.
        await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
        await harvest();
        // The styled label span intercepts pointer events, so .check() times out; click the label.
        await page.getByText("I saved the backup codes").click();
        await expect(savedCheckbox).toBeChecked();
        const commitBtn = page.getByRole("button", { name: "Create backup codes", exact: true });
        await expect(commitBtn).toBeEnabled();
        await commitBtn.click();
        await expect(deactivateBtn).toBeVisible();
      } else {
        if (await viewBtn.isVisible().catch(() => false)) {
          await viewBtn.click();
        }
        await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
        await harvest();
      }
    },
  },

  // "setup-secure-linked" is a DOM split of /ui/setup_secure (helpers/page-state.ts).
  // Unlinking deletes the totp credential and KEEPS lookup_secret.
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

  // --- Registration flow transitions ---

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
  // Verification OFF: kratos answers with continue_with[redirect_browser_to → /ui/manage_details]
  // and the registration `session` after-hook (docker/kratos/kratos.yml) makes the hub serve.
  "register-password → manage-details": {
    description:
      "Enter valid password and submit — no verification hand-off; the session lands on the settings hub",
    action: async (page, _user, ctx) => {
      const password = ctx.newPassword ?? DEFAULT_TEST_PASSWORD;
      await fillRegistrationPassword(page, password);
    },
  },

  // --- Verification flow transitions ---

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
      // Accessible name is "Verification code Resend code" (the resend button sits inside the label).
      // Type per character: login-ui's Flow component re-initialises its controlled values when
      // the flow object changes, and a racing fill() POSTs without `code`. Assert the value stuck.
      const codeField = page.getByLabel(/verification code/i);
      await codeField.pressSequentially(code, { delay: 20 });
      await expect(codeField).toHaveValue(code);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    },
  },

  "verification → verification": {
    description: "Submit a rejected verification code (error — stays on verification page)",
    action: async (page, user, ctx) => {
      if (ctx.verificationCodeSubmission !== "stale-after-resend") {
        await page.getByLabel(/verification code/i).fill("000000");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        return;
      }
      assertInternalLane(ctx, "Stale-after-resend code submission (reads Mailslurper)");
      const { originalCode, cursor } = await resendVerificationCode(page, user.email, ctx.mailCursor);
      ctx.mailCursor = cursor;
      const codeField = page.getByLabel(/verification code/i);
      await codeField.pressSequentially(originalCode, { delay: 20 });
      await expect(codeField).toHaveValue(originalCode);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    },
  },

  // --- WebAuthn flow transitions ---

  "login-password → login-webauthn-verify": {
    description: "Enter password (WebAuthn is the 2FA method)",
    action: enterPasswordAction,
  },

  "login-webauthn-verify → oidc-callback": {
    description: "Authenticate with WebAuthn virtual authenticator",
    action: async (page, _user, ctx) => {
      await ctx.webauthn?.setup();

      // The virtual authenticator auto-responds to navigator.credentials.get() but the ceremony needs
      // a click. Match the Kratos node name: the button label varies with OIDC sequencing.
      await page.locator('button[name="webauthn_login_trigger"]').click();
    },
  },
  // The signed assertion is accepted, then login-ui's TOTP-only MFA gate forces enrolment mid-login.
  "login-webauthn-verify → setup-secure": {
    description: "Authenticate with the security key — login-ui accepts it, then forces TOTP enrolment",
    action: async (page, _user, ctx) => {
      await ctx.webauthn?.setup();
      await page.locator('button[name="webauthn_login_trigger"]').click();
    },
  },

  // --- Edge case transitions ---

  "login-backup-code-verify → backup-code-regenerate": {
    description: "Authenticate with backup code (shows regeneration prompt)",
    action: verifyBackupCodeAction,
  },

  "backup-code-regenerate → oidc-callback": {
    description: 'Skip regeneration, continue to callback ("I don\'t need new codes, sign in")',
    action: async (page) => {
      await page.getByRole("button", { name: "I don't need new codes" }).click();
    },
  },
};
