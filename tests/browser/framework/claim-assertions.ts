// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { expect } from "@playwright/test";
import { readClaim } from "../helpers/jwt";
import type { CapturedTokens, ClaimAssertion, ClaimAssertionArgs } from "./scenario-types";

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

/** Declaration order; the first failure wins and the error names the assertion. */
export async function runClaimAssertions(claims: readonly ClaimAssertion[], args: ClaimAssertionArgs): Promise<void> {
  for (const claim of claims) {
    try {
      await claim.run(args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`claim assertion ${claim.name} failed: ${reason}`, { cause: err });
    }
  }
}

/** `auth_time` in `toPhase` advanced past `fromPhase`'s `auth_time` (else `iat`). The later phase must
 *  request `max_age`, under which `auth_time` is mandatory (OIDC Core §3.1.3.7) — a missing claim fails. */
export function reauthenticated(fromPhase: number, toPhase: number): ClaimAssertion {
  return {
    name: `reauthenticated(phase ${fromPhase} → ${toPhase})`,
    async run({ phaseTokens }) {
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
    },
  };
}

/** `amr` contains every `mustInclude` and none of `mustExclude`. `amr` is optional per OIDC Core §2, but
 *  this platform emits it on every covered path, so an absent claim FAILS rather than passing by omission. */
export function amrRecords(
  { mustInclude, mustExclude = [] }: { mustInclude: string[]; mustExclude?: string[] },
  phase?: number,
): ClaimAssertion {
  if (mustInclude.length === 0) {
    throw new Error("amrRecords: mustInclude must name at least one method");
  }
  const parts = [`include=[${mustInclude.join(",")}]`];
  if (mustExclude.length > 0) parts.push(`exclude=[${mustExclude.join(",")}]`);
  if (phase !== undefined) parts.push(`phase=${phase}`);
  return {
    name: `amrRecords(${parts.join(", ")})`,
    async run({ idTokenClaims, phaseTokens }) {
      const claims = phase === undefined ? idTokenClaims : idTokenOfPhase(phaseTokens, phase, "amrRecords");
      const amr = readClaim(claims, "amr");
      expect(Array.isArray(amr), `amr must be an array of methods, got ${JSON.stringify(amr)}`).toBe(true);
      const methods = amr as string[];
      for (const method of mustInclude) {
        expect(methods, `amr must record "${method}"`).toContain(method);
      }
      for (const method of mustExclude) {
        expect(methods, `amr must NOT record "${method}"`).not.toContain(method);
      }
    },
  };
}

/** `sub` equals the manifest's Kratos identity id. Only valid for users the walk does not re-create. */
export function subjectIsSeededIdentity(): ClaimAssertion {
  return {
    name: "subjectIsSeededIdentity()",
    async run({ idTokenClaims, user }) {
      expect(
        readClaim(idTokenClaims, "sub"),
        `id_token sub must be the seeded identity of user "${user.ref}"`,
      ).toBe(user.identityId);
    },
  };
}
