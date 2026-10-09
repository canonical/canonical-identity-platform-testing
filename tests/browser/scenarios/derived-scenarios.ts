// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Re-entry coverage derived from the data: for every distinct shape of client login the suites
 *  declare, every login step, every browser action that leaves the login and comes back. The
 *  expected path is what the product's spec says a re-entered login does (a restarted login stays
 *  the client's login: canonical/identity-platform-login-ui openspec/specs/login-restart); where
 *  v0.28.0 diverges, `derived-pins.ts` names the divergence and the defect. Nothing here is written
 *  by hand per scenario; a new base shape or a new kind widens the set at import. */

import type { PageStateType } from "../helpers/page-state";
import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import type { Intervention, Scenario, ScenarioRequires, ScenarioSuite } from "../framework/scenario-types";
import { DERIVED_PINS, type DerivedPin } from "./derived-pins";

import { loginScenarios } from "./login-scenarios";
import { oidcScenarios } from "./oidc-scenarios";
import { tenantScenarios } from "./tenant-scenarios";
import { sessionScenarios } from "./session-scenarios";
import { resilienceScenarios } from "./resilience-scenarios";

export type ReentryKind = "reload" | "back" | "reopen-request" | "back-resubmit";

/** The login steps a re-entry can leave from. */
const LOGIN_STEPS: Partial<Record<PageStateType, true>> = {
  "login-email": true,
  "tenant-selection": true,
  "login-password": true,
  "login-totp-verify": true,
  "login-webauthn-verify": true,
  "login-backup-code-verify": true,
};

/** Steps a stale page can submit again after the login completed, and the edge that submits. */
const RESUBMITTABLE: Partial<Record<PageStateType, true>> = { "login-totp-verify": true };

/** Where one real browser Back lands, per step, measured on login-ui v0.28.0 (2026-10-09, core-mfa):
 *  the identifier → password hop replaces the history entry, so Back on the password page shows the
 *  password page again; the password → second-factor hop pushes one, and the entry Back reaches can
 *  no longer fetch its flow (Kratos rotated the CSRF token with the session), so the SPA starts the
 *  login over. A step missing here is a coverage gap (`derived-coverage.json`), not a guess. */
const BACK_LANDS_ON: Partial<Record<PageStateType, PageStateType>> = {
  "login-password": "login-password",
  "login-totp-verify": "login-email",
};

/** A base phase the generator may perturb: one client login, plain credentials, nothing mutated. */
function eligible(s: Scenario): boolean {
  const p = s.expectedPath;
  if (!p || s.phases || s.cleanup || s.interventions || s.expectError || s.totpCodeWindow || s.verificationCodeSubmission) return false;
  if (s.user.credentials?.includes("lookup_secret")) return false;
  if (!(p[0] === "login-email" || p[0] === "tenant-selection") || p[p.length - 1] !== "oidc-callback") return false;
  return p.every((st) => LOGIN_STEPS[st] || st === "oidc-callback" || st.startsWith("provider:dex:"));
}

const SOURCES: ScenarioSuite[] = [loginScenarios, oidcScenarios, tenantScenarios, sessionScenarios, resilienceScenarios];

/** One base per path shape, the least demanding `requires` among the duplicates: duplicates differ
 *  in what they assert, not in what a browser can do to them, and the least demanding one runs on
 *  the most rows. */
function bases(): Scenario[] {
  const byShape: Record<string, Scenario> = {};
  const order: string[] = [];
  for (const suite of SOURCES) {
    for (const s of suite.scenarios) {
      if (!eligible(s)) continue;
      const key = `${s.expectedPath!.join(">")}|${s.user.selectTenant ?? ""}`;
      const held = byShape[key];
      if (!held) order.push(key);
      if (!held || Object.keys(s.requires).length < Object.keys(held.requires).length) byShape[key] = s;
    }
  }
  return order.map((k) => byShape[k]);
}

interface Derived {
  id: string;
  base: Scenario;
  kind: ReentryKind;
  atIndex: number;
  expectedPath: PageStateType[];
  interventions: Intervention[];
}

function derive(base: Scenario): Derived[] {
  const p = base.expectedPath!;
  const out: Derived[] = [];
  for (const [i, s] of p.entries()) {
    if (!LOGIN_STEPS[s]) continue;
    out.push({ id: `${base.id} ⟂ reload@${i}`, base, kind: "reload", atIndex: i, expectedPath: [...p], interventions: [{ at: s, do: "reload" }] });
    // Where one real Back lands is a fact of the SPA's history handling, measured (below), not spec;
    // from the landing on, the spec says the login completes for the client as the base does.
    const landing = i > 0 ? BACK_LANDS_ON[s] : undefined;
    const j = landing === undefined ? -1 : p.slice(0, i + 1).lastIndexOf(landing);
    if (j >= 0) {
      out.push({ id: `${base.id} ⟂ back@${i}`, base, kind: "back", atIndex: i, expectedPath: [...p.slice(0, i + 1), ...p.slice(j)], interventions: [{ atIndex: i, do: "back" }] });
    }
    out.push({ id: `${base.id} ⟂ reopen-request@${i}`, base, kind: "reopen-request", atIndex: i, expectedPath: [...p.slice(0, i + 1), ...p], interventions: [{ atIndex: i, do: "reopen-request" }] });
  }
  // The finished login's last page, reached by Back from the RP, submitted again. The spec terminal
  // forks on whether Kratos was given the challenge: with it the flow is a refresh, Kratos takes the
  // code and re-accepts, and Hydra refuses the used verifier (access_denied); without it login-ui
  // sends the signed-in user to the account page (login-ui#987).
  const last = p.length - 1;
  if (RESUBMITTABLE[p[last - 1]]) {
    const path = (t: PageStateType): PageStateType[] => [...p, p[last - 1], t];
    // login-ui gives Kratos the challenge only with sequencing and multi-tenancy both off.
    if (!base.requires.multiTenancy && !base.requires.oidcSequencing) {
      out.push({ id: `${base.id} ⟂ back-resubmit (challenge given to kratos)`, base, kind: "back-resubmit", atIndex: last, expectedPath: path("oidc-callback-error"), interventions: [{ atIndex: last, do: "back" }] });
    }
    out.push({ id: `${base.id} ⟂ back-resubmit (challenge kept from kratos)`, base, kind: "back-resubmit", atIndex: last, expectedPath: path("manage-details"), interventions: [{ atIndex: last, do: "back" }] });
  }
  return out;
}

function requiresFor(d: Derived): ScenarioRequires {
  if (d.kind !== "back-resubmit") return { ...d.base.requires };
  return { ...d.base.requires, kratosLoginChallenge: d.id.endsWith("(challenge given to kratos)") };
}

/** A pin narrows on at most one boolean key; the spec variant gets its negation, so both are collected everywhere. */
function negate(where: DerivedPin["where"]): ScenarioRequires {
  const keys = Object.keys(where ?? {});
  if (keys.length > 1) throw new Error(`derived pin narrows on ${keys.length} keys; one boolean key at most`);
  const out: ScenarioRequires = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = !(where as Record<string, boolean>)[k];
  return out;
}

function build(): Scenario[] {
  const scenarios: Scenario[] = [];
  const pinsUsed: Record<string, true> = {};
  for (const base of bases()) {
    for (const d of derive(base)) {
      const requires = requiresFor(d);
      const finalUrlContains = d.expectedPath[d.expectedPath.length - 1] === "oidc-callback-error" ? "error=access_denied" : undefined;
      const pins = DERIVED_PINS.filter((pin) => pin.id === d.id);
      for (const pin of pins) {
        pinsUsed[pin.id] = true;
        scenarios.push(defineScenario({
          id: `${d.id} [${pin.pd}]`,
          description: `${pin.pd}: ${pin.note}`,
          requires: { ...requires, ...pin.where },
          user: base.user,
          expectedPath: pin.expectedPath,
          interventions: d.interventions,
          expectError: pin.expectError,
          expectErrorText: pin.expectErrorText,
          pinnedInvariantViolation: pin.pinnedInvariantViolation,
          lanes: base.lanes,
        }));
      }
      // The spec variant stands where no pin holds (one narrowing key per pin, negated).
      const spec: ScenarioRequires = { ...requires };
      for (const pin of pins) Object.assign(spec, negate(pin.where));
      if (pins.some((pin) => !pin.where || Object.keys(pin.where).length === 0)) continue;
      scenarios.push(defineScenario({
        id: d.id,
        description: `${d.kind} at step ${d.atIndex} (${d.expectedPath[d.atIndex]}) of "${base.id}": the spec path`,
        requires: spec,
        user: base.user,
        expectedPath: d.expectedPath,
        interventions: d.interventions,
        finalUrlContains,
        lanes: base.lanes,
      }));
    }
  }
  for (const pin of DERIVED_PINS) {
    if (!pinsUsed[pin.id]) throw new Error(`derived pin "${pin.id}" matches no derived walk: the base shape or the kind is gone`);
  }
  return scenarios;
}

export const derivedScenarios = defineScenarioSuite({
  name: "derived",
  defaultLanes: ["internal"],
  scenarios: build(),
});

/** The (login step × kind) cells the derived set covers. Every other cell is a gap `derived-coverage.json`
 *  must name with a reason (`framework/derived-coverage.test.ts`), so an unperturbed step is never silence. */
export function derivedCoverage(): { cells: string[]; covered: string[] } {
  const kinds: ReentryKind[] = ["reload", "back", "reopen-request", "back-resubmit"];
  const cells = (Object.keys(LOGIN_STEPS) as PageStateType[]).flatMap((s) => kinds.map((k) => `${s} × ${k}`));
  const covered: Record<string, true> = {};
  for (const base of bases()) {
    for (const d of derive(base)) {
      const step = d.kind === "back-resubmit" ? d.expectedPath[d.atIndex + 1] : d.expectedPath[d.atIndex];
      covered[`${step} × ${d.kind}`] = true;
    }
  }
  return { cells, covered: cells.filter((c) => covered[c]) };
}
