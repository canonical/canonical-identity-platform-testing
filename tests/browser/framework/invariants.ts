// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Rules the runner checks on every walk, declared by nobody: a derived or hand-written
 *  scenario needs no expectation for them (testing-spec §8, "Invariants"). Pure logic here;
 *  the runner feeds it what it observed. */

import type { Page, Response } from "@playwright/test";
import type { PageStateType } from "../helpers/page-state";
import { readClaim } from "../helpers/jwt";
import type { Manifest, ManifestUser } from "../seeder/manifest-schema";
import type { Intervention, Phase } from "./scenario-types";

// --- I0: no server error from the platform on a step the user did right ---

export interface ServerErrorRecord {
  status: number;
  method: string;
  url: string;
}

/** Records every ≥500 answer from one of `origins` for the life of the page, except while
 *  `tolerated()` holds. The platform's origins are login-ui, Kratos public and Hydra public; the RP
 *  and external providers are not. login-ui answers a rejected submit (wrong password, wrong or
 *  reused code, a second click) with 500 — measured 2026-10-09 on v0.28.0, every error path — so a
 *  self-transition and a double submit are tolerated windows; a 5xx anywhere else is a defect. */
export function watchServerErrors(page: Page, origins: readonly string[], tolerated: () => boolean): ServerErrorRecord[] {
  const seen: ServerErrorRecord[] = [];
  page.on("response", (res: Response) => {
    if (res.status() < 500 || tolerated()) return;
    const url = res.url();
    if (!URL.canParse(url) || !origins.includes(new URL(url).origin)) return;
    seen.push({ status: res.status(), method: res.request().method(), url });
  });
  return seen;
}

/** Throws on any recorded 5xx not matched by `pinnedUrl`; returns whether a pinned one occurred. */
export function assertNoServerErrors(seen: readonly ServerErrorRecord[], where: string, pinnedUrl?: string): boolean {
  const unexpected = pinnedUrl ? seen.filter((r) => !r.url.includes(pinnedUrl)) : seen;
  if (unexpected.length > 0) {
    throw new Error(
      `I0: the platform answered a server error during ${where}:\n` +
        unexpected.map((r) => `  ${r.status} ${r.method} ${r.url}`).join("\n"),
    );
  }
  return unexpected.length < seen.length;
}

// --- I2: a login that demands re-authentication walked a credential step ---

/** Where a client's login starts: the identifier page, the tenant selection, or — for a session
 *  login-ui sends to enrol instead of to sign in — the enrolment page. */
const LOGIN_ENTRY_STATES: Partial<Record<PageStateType, true>> = { "login-email": true, "tenant-selection": true, "setup-secure": true };

const SECOND_FACTOR_STATES: Partial<Record<PageStateType, true>> = {
  "login-totp-verify": true,
  "login-backup-code-verify": true,
  "login-webauthn-verify": true,
};

const FIRST_FACTOR_STATES: Partial<Record<PageStateType, true>> = {
  "login-password": true,
  "login-webauthn-verify": true,
  "provider:dex:login": true,
  "provider:google:login": true,
  "provider:google:password": true,
};

/** Enrolment is a sign-in only when a first factor preceded it in the same phase. */
const ENROLMENT_STATES: Partial<Record<PageStateType, true>> = { "setup-secure": true, "setup-passkey": true };

/** Whether the phase is one Hydra could not skip: the browser has no session yet (phase 0,
 *  or cookies cleared), or the request says so. */
export function demandsReauthentication(phaseIndex: number, phase: Pick<Phase, "flowParams" | "freshSession">): boolean {
  if (phaseIndex === 0 || phase.freshSession) return true;
  const p = phase.flowParams ?? {};
  return p.max_age === "0" || (p.prompt ?? "").split(/[\s+]/).includes("login");
}

/** I2 applies to phases that start a client's login and end at its callback. */
export function i2Applies(path: readonly PageStateType[]): boolean {
  return path.length > 0 && LOGIN_ENTRY_STATES[path[0]] === true && path[path.length - 1] === "oidc-callback";
}

/** The credential record a declared path leaves at its terminal: every re-entry restarts it at
 *  its landing. What the runner accumulates live, computed from the data. */
export function walkedAtTerminal(path: readonly PageStateType[], interventions: readonly Intervention[] = []): PageStateType[] {
  let start = 0;
  for (const iv of interventions) {
    if ("atIndex" in iv && iv.atIndex + 1 > start) start = iv.atIndex + 1;
  }
  return path.slice(start);
}

export interface I2Context {
  /** States observed in order since the request started (a re-entry resets this list). */
  walked: readonly PageStateType[];
  /** The deployment enforces a second factor (ActiveConfig.mfa_enforced). */
  mfaEnforced: boolean;
  /** The identity has a TOTP credential in the manifest. */
  totpConfigured: boolean;
}

/** Returns the violation, or undefined. */
export function i2Violation({ walked, mfaEnforced, totpConfigured }: I2Context): string | undefined {
  let firstFactorAt = -1;
  let secondFactor = false;
  let signedIn = false;
  for (const [i, s] of walked.entries()) {
    if (FIRST_FACTOR_STATES[s]) {
      if (firstFactorAt < 0) firstFactorAt = i;
      signedIn = true;
    }
    if (SECOND_FACTOR_STATES[s]) {
      secondFactor = true;
      signedIn = true;
    }
    if (ENROLMENT_STATES[s] && firstFactorAt >= 0) signedIn = true;
  }
  if (!signedIn) {
    return `I2: the login demanded re-authentication but no credential step was walked after it started (walked: ${walked.join(" → ")})`;
  }
  // login-ui exempts external-provider sign-ins from MFA enforcement
  // (canonical/identity-platform-login-ui@5ddc4ca1 pkg/kratos/handlers.go:1050-1055).
  const external = walked.some((s) => s.startsWith("provider:"));
  if (mfaEnforced && totpConfigured && !external && !secondFactor) {
    return `I2: MFA is enforced and the user has TOTP, but no second-factor step was walked (walked: ${walked.join(" → ")})`;
  }
  return undefined;
}

// --- I3: the tokens belong to the identity that signed in ---

export interface I3Context {
  idTokenClaims: Record<string, unknown>;
  accessTokenClaims: Record<string, unknown> | null;
  user: ManifestUser;
  manifest: Manifest;
  hookServicePresent: boolean;
  /** The walk created the identity (registration), so the manifest id is not the subject. */
  identityCreatedByWalk: boolean;
}

export function i3Violation(ctx: I3Context): string | undefined {
  const { idTokenClaims, accessTokenClaims, user, manifest, hookServicePresent, identityCreatedByWalk } = ctx;
  if (!identityCreatedByWalk) {
    const sub = readClaim(idTokenClaims, "sub");
    if (sub !== user.identityId) {
      return `I3: id_token sub is ${JSON.stringify(sub)}, not the identity of "${user.ref}" (${user.identityId})`;
    }
  }
  const allowed = (user.tenantRefs ?? [])
    .map((ref) => manifest.tenants.find((t) => t.ref === ref || t.name === ref)?.id)
    .filter((id): id is string => typeof id === "string");
  const sides: [string, Record<string, unknown>][] = accessTokenClaims
    ? [["access_token", accessTokenClaims], ["id_token", idTokenClaims]]
    : [["id_token", idTokenClaims]];
  for (const [label, claims] of sides) {
    const tenantId = readClaim(claims, "tenant_id");
    if (tenantId === undefined) continue;
    if (!hookServicePresent) {
      return `I3: ${label} carries tenant_id ${JSON.stringify(tenantId)} but hook-service, its only writer, is not deployed`;
    }
    if (typeof tenantId !== "string" || !allowed.includes(tenantId)) {
      return `I3: ${label} tenant_id ${JSON.stringify(tenantId)} is not one of the tenants of "${user.ref}" ([${allowed.join(", ")}])`;
    }
  }
  return undefined;
}
