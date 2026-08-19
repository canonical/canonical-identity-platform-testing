// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Reusable `assertions.custom` builders.
 *
 * Scenarios stay data: they name an assertion, they do not implement one. These
 * factories return the callback `ScenarioAssertions.custom` expects, so a
 * scenario file keeps declaring WHAT must hold.
 *
 * Why these exist (R-22): the forced-reauth scenarios proved re-authentication
 * by PATH alone — "the user was asked for a password again" — which a replayed
 * session can also produce. The platform's actual answer is in the token, and
 * two claims say it outright:
 *
 *   - `auth_time` — when the end-user authentication happened. OIDC Core §3.1.3.7
 *     and §2 make it MANDATORY in the ID token whenever the request carried
 *     `max_age`, which is exactly the shape every forced-reauth scenario uses.
 *     So under `max_age` its absence is a real defect, not an unknown.
 *   - `amr` — which methods were used. This is how a claim about WHICH factor
 *     satisfied the gate becomes falsifiable rather than inferred from a page.
 *
 * `auth_time` is only meaningful against a reference point, which is why the
 * runner captures tokens per phase and passes them here.
 */

import { expect } from "@playwright/test";
import { readClaim } from "../helpers/jwt";
import type { CapturedTokens, CustomAssertion } from "./scenario-types";

/** Read a numeric claim (`auth_time`, `iat`) or return undefined. */
function numericClaim(claims: Record<string, unknown>, name: string): number | undefined {
  const value = readClaim(claims, name);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idTokenOfPhase(phaseTokens: Array<CapturedTokens | undefined>, index: number, label: string): Record<string, unknown> {
  const tokens = phaseTokens[index];
  expect(
    tokens,
    `${label}: phase ${index} issued no token, so there is nothing to compare — ` +
      `a claim assertion across phases needs both phases to end at oidc-callback`,
  ).toBeTruthy();
  return tokens!.idTokenClaims;
}

/**
 * The end-user really re-authenticated in `toPhase` rather than having a session
 * replayed: the ID token's `auth_time` advanced.
 *
 * Requires `max_age` on the later phase — under `max_age` the OP MUST return
 * `auth_time`, so a missing claim fails loudly instead of being treated as
 * unknown. The reference is the earlier phase's `auth_time` when it carries one
 * (the strong comparison) and otherwise its `iat`: an authentication timestamp
 * later than the moment the earlier token was ISSUED cannot have come from the
 * earlier authentication, which is the property under test either way.
 */
export function reauthenticated(fromPhase: number, toPhase: number): CustomAssertion {
  return async ({ phaseTokens }) => {
    const before = idTokenOfPhase(phaseTokens, fromPhase, "reauthenticated");
    const after = idTokenOfPhase(phaseTokens, toPhase, "reauthenticated");

    const authTime = numericClaim(after, "auth_time");
    expect(
      authTime,
      "the re-authenticated phase requested max_age, so OIDC Core §3.1.3.7 requires auth_time " +
        "in its ID token — a missing claim is a product defect, not an inconclusive result",
    ).not.toBeUndefined();

    const reference = numericClaim(before, "auth_time") ?? numericClaim(before, "iat");
    expect(reference, "the earlier phase's ID token carries neither auth_time nor iat").not.toBeUndefined();

    expect(
      authTime!,
      `auth_time must ADVANCE past the earlier phase (${authTime} vs ${reference}) — equal or ` +
        "earlier means the platform replayed the existing authentication instead of re-challenging",
    ).toBeGreaterThan(reference!);
  };
}

/**
 * `amr` records exactly the methods claimed.
 *
 * `mustInclude` are required, `mustExclude` must be absent — the second half is
 * what makes a negative product finding (PD-4: an enrolled security key does NOT
 * satisfy the MFA gate, TOTP does) assertable rather than merely narrated.
 *
 * `amr` is OPTIONAL in OIDC Core §2, and its presence has only been observed on
 * this platform's sequencing path so far. When it is absent this warns loudly
 * and skips only the `amr` half — the caller's other assertions still run. If a
 * stack run shows it is reliably absent for a path, the honest follow-up is a
 * product finding (the platform is not reporting how it authenticated), not a
 * weaker assertion here.
 */
export function amrRecords(
  { mustInclude = [], mustExclude = [] }: { mustInclude?: string[]; mustExclude?: string[] },
  phase?: number,
): CustomAssertion {
  return async ({ idTokenClaims, phaseTokens }) => {
    const claims = phase === undefined ? idTokenClaims : idTokenOfPhase(phaseTokens, phase, "amrRecords");
    const amr = readClaim(claims, "amr");
    if (amr === undefined) {
      console.warn(
        "[claim-assertions] amr is absent from the ID token, so the authentication-method " +
          `assertion (include ${JSON.stringify(mustInclude)}, exclude ${JSON.stringify(mustExclude)}) ` +
          "could not be evaluated. TODO(review): the first green stack run decides whether this " +
          "platform emits amr on this path; if it does not, file it as a product finding.",
      );
      return;
    }
    expect(Array.isArray(amr), `amr must be an array, got ${JSON.stringify(amr)}`).toBe(true);
    const methods = amr as string[];
    for (const method of mustInclude) {
      expect(methods, `amr must record "${method}"`).toContain(method);
    }
    for (const method of mustExclude) {
      expect(methods, `amr must NOT record "${method}"`).not.toContain(method);
    }
  };
}

/** Run several custom assertions as one. Order is preserved; the first failure wins. */
export function allOf(...customs: CustomAssertion[]): CustomAssertion {
  return async (tokens) => {
    for (const custom of customs) await custom(tokens);
  };
}
