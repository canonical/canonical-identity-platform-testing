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
  start: ["login-email", "oidc-callback", "tenant-selection", "reset-email", "verification", "register-email", "setup-passkey", "oidc-error-page", "oidc-callback-error"],

  // ── Login UI states ────────────────────────────────────────────────────
  "login-email": ["login-password", "tenant-selection", "provider:dex:login", "provider:google:login", "oidc-callback", "reset-email", "register-email", "verification"],
  "login-password": ["setup-secure", "login-totp-verify", "login-backup-code-verify", "login-webauthn-verify", "oidc-callback", "login-password", "reset-email"],
  "login-totp-verify": ["oidc-callback", "login-backup-code-verify", "login-totp-verify", "backup-code-regenerate", "reset-password"],
  "login-webauthn-verify": ["oidc-callback"],
  "login-backup-code-verify": ["oidc-callback", "login-backup-code-verify", "backup-code-regenerate"],

  // ── Setup states ──────────────────────────────────────────────────────
  // `setup-backup-codes` is deliberately absent: no transition action drives
  // the browser into it, so the framework cannot walk that journey. The
  // backup-code enrolment path is covered by the hand-written
  // `specs/use-backup-codes.spec.ts`.
  "setup-secure": ["setup-complete"],
  "setup-passkey": ["setup-complete", "login-webauthn-verify", "oidc-callback"],
  "setup-complete": ["oidc-callback"],

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
  "reset-password": ["manage-details"],

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

  // ── Consent ────────────────────────────────────────────────────────────
  consent: ["oidc-callback"],

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
  "manage-details": [],
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
