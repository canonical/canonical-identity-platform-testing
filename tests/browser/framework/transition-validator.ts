// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Transition validator — checks observed paths against legal transitions.
 *
 * This is a lightweight safety net, not a graph engine. It validates that
 * a sequence of page states only contains transitions that are possible
 * in the identity platform login flow.
 *
 * Used at:
 * - Scenario definition time: validate expectedPath before running
 * - Runtime: validate observed transitions (catch impossible state jumps)
 */

import type { PageStateType } from "../helpers/page-state";

// ---------------------------------------------------------------------------
// Legal transition table
// ---------------------------------------------------------------------------

/**
 * Legal transitions in the identity platform login flow.
 *
 * This is NOT a graph — it's a constraint. Any observed transition
 * not in this table is a potential bug or an incomplete table.
 *
 * The "start" pseudo-state represents the initial navigation to the OIDC flow.
 */
const LEGAL_TRANSITIONS: Record<string, PageStateType[]> = {
  // ── Flow start ────────────────────────────────────────────────────────
  // `manage-details` from start = opening the settings hub with a live
  // session from an earlier phase (settings scenarios).
  start: ["login-email", "oidc-callback", "tenant-selection", "reset-email", "verification", "register-email", "setup-passkey", "oidc-error-page", "oidc-callback-error", "manage-details", "device-code"],

  // ── Login UI states ────────────────────────────────────────────────────
  "login-email": ["login-password", "tenant-selection", "provider:dex:login", "provider:google:login", "oidc-callback", "reset-email", "register-email", "verification"],
  "login-password": ["setup-secure", "login-totp-verify", "login-backup-code-verify", "login-webauthn-verify", "oidc-callback", "login-password", "reset-email"],
  "login-totp-verify": ["oidc-callback", "login-backup-code-verify", "login-totp-verify", "backup-code-regenerate", "reset-password", "device-complete"],
  "login-webauthn-verify": ["oidc-callback"],
  // → setup-secure: the identity's only 2FA is lookup_secret (post-unlink)
  // and MFA is enforced, so an accepted code walks into TOTP re-enrolment.
  "login-backup-code-verify": ["oidc-callback", "login-backup-code-verify", "backup-code-regenerate", "setup-secure"],

  // ── Setup states ──────────────────────────────────────────────────────
  "setup-secure": ["setup-complete"],
  // The linked shape of /ui/setup_secure (TOTP already enrolled): unlinking
  // re-renders the enrolment shape in place.
  "setup-secure-linked": ["setup-secure"],
  "setup-passkey": ["setup-complete", "login-webauthn-verify", "oidc-callback"],
  "setup-complete": ["oidc-callback"],
  // Reached from the settings hub ("Backup codes" nav). The self-edge is the
  // page re-rendering in place for BOTH of its operations — create/regenerate
  // (observed 2026-08-27 on iam.orange) and deactivate (observed 2026-08-31
  // on login-ui:stable). First-login backup-code ENROLMENT still has no
  // driving action and remains covered by specs/use-backup-codes.spec.ts.
  "setup-backup-codes": ["setup-backup-codes"],

  // ── Device flow (RFC 8628) ────────────────────────────────────────────
  // Confirming the user code opens a login_challenge journey; the terminal
  // is /ui/device_complete (urls.device.success) — tokens arrive by RP
  // polling, never a callback.
  "device-code": ["login-email"],

  // ── Recovery flow ─────────────────────────────────────────────────────
  // A recovery code only yields an AAL1 session. Because settings.required_aal
  // defaults to highest_available, a 2FA-enrolled identity is bounced through
  // an aal=aal2 login flow before the settings (reset_password) page is served.
  "reset-email": ["reset-email-code"],
  // A wrong code is rejected in place. The deployed fork enforces no
  // submission cap (register S-9), so there is no edge out to a fresh flow;
  // add `reset-email` here if a cap ever lands.
  "reset-email-code": ["reset-password", "login-totp-verify", "reset-email-code"],
  // The settings flow inherits return_to=/ui/login from the recovery flow, and
  // the session is already AAL2 by then, so login-ui bounces to ./manage_details.
  // The SELF-edge is the settings hub's own "Change password" form: success
  // re-renders /ui/reset_password with a fresh flow id and a banner.
  "reset-password": ["manage-details", "reset-password"],

  // ── Registration flow ────────────────────────────────────────────────
  // Kratos always appends the verification hook when verification is enabled,
  // and RegisterPassword.tsx follows continue_with[show_verification_ui] first.
  // No session is issued after registration, so no TOTP-enrolment step exists.
  "register-email": ["register-password"],
  "register-password": ["verification"],

  // ── Verification flow ─────────────────────────────────────────────────
  // A standalone verification flow is not part of an OIDC journey, so Kratos
  // returns the browser to the login page once the code is accepted.
  verification: ["login-email", "verification"],

  // ── Backup code regeneration ──────────────────────────────────────────
  "backup-code-regenerate": ["oidc-callback"],

  // ── Tenant selection ──────────────────────────────────────────────────
  "tenant-selection": ["login-password", "login-totp-verify", "oidc-callback"],

  // ── External providers ────────────────────────────────────────────────
  "provider:dex:login": ["oidc-callback", "provider:dex:consent", "setup-passkey", "login-webauthn-verify"],
  "provider:dex:consent": ["oidc-callback"],

  "provider:google:login": ["provider:google:password", "login-webauthn-verify"],
  "provider:google:password": ["provider:google:totp"],
  "provider:google:totp": ["provider:google:confirm-identity", "provider:google:interstitial", "oidc-callback"],
  "provider:google:confirm-identity": ["provider:google:consent", "provider:google:interstitial", "oidc-callback", "setup-passkey", "login-webauthn-verify"],
  "provider:google:consent": ["provider:google:interstitial", "oidc-callback"],
  "provider:google:interstitial": ["oidc-callback"],

  // No login-ui consent state: /ui/consent is unreachable (auto-accept) and
  // coverage was decided against — docs/testing-spec.md §10 item 12.

  // ── Terminal states ───────────────────────────────────────────────────
  // A callback carrying `error=` (or a failed code exchange) is where an OAuth
  // flow DIED; nothing follows it. No mid-journey step may route INTO an error
  // state — an observed one is reported as an illegal transition. The ONLY
  // legal way in is from `start`: the oidc-error suite drives deliberately
  // malformed authorize requests, which terminate on the login-ui error page
  // (unvalidatable client/redirect) or the RP callback error (everything else).
  "oidc-callback": [],
  "oidc-callback-error": [],
  "error-page": [],
  "oidc-error-page": [],
  // Device journey terminal (urls.device.success): tokens arrive by RP
  // polling, nothing follows in the browser.
  "device-complete": [],
  // The settings hub: recovery's terminal, and the settings scenarios' base.
  "manage-details": ["reset-password", "setup-backup-codes", "setup-secure", "setup-secure-linked"],
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate that a path only contains legal transitions.
 *
 * @param path An ordered list of page states (may include "start" as the first element)
 * @returns An array of illegal transition descriptions (empty if all legal)
 */
export function validatePath(path: (PageStateType | "start")[]): string[] {
  const illegal: string[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const allowed = LEGAL_TRANSITIONS[from];

    if (!allowed) {
      illegal.push(`${from} → ${to} (unknown source state: ${from})`);
      continue;
    }

    if (!(allowed as string[]).includes(to)) {
      illegal.push(`${from} → ${to}`);
    }
  }

  return illegal;
}

/**
 * Get the legal transitions table (for inspection or extension).
 */
export function getLegalTransitions(): Record<string, PageStateType[]> {
  return { ...LEGAL_TRANSITIONS };
}
