// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { PageStateType } from "../helpers/page-state";
import type { ExecutionLane } from "../helpers/config";
import type { ManifestUser } from "../seeder/manifest-schema";
import type { TransitionKey } from "./transitions";

export type { ExecutionLane } from "../helpers/config";

// --- Profile preconditions ---

export interface ScenarioRequires {
  mfaEnabled?: boolean;
  multiTenancy?: boolean;
  /** SUBSET semantics: required ⊆ available. "only oidc" is `localUsersEnabled: false`. */
  oidcProviders?: string[];
  webauthnEnabled?: boolean;
  hookService?: boolean;

  oidcSequencing?: boolean;
  localUsersEnabled?: boolean;
  mfaEnforced?: boolean;
  registrationEnabled?: boolean;
  verificationEnabled?: boolean;
  accountLinkingEnabled?: boolean;
  oidcEnabled?: boolean;
  firstFactorMethods?: string[];
  secondFactorMethods?: string[];
  mailApi?: boolean;
  /** login-ui version fork: the regeneration prompt renders after EVERY backup-code sign-in. */
  backupCodePromptOnUse?: boolean;
  deviceFlow?: boolean;

  /** Service-presence keys of the form "service:<name>". */
  [key: `service:${string}`]: boolean | undefined;
}

// --- User references ---

export interface ScenarioUser {
  /** Ref of a seeded user in the manifest. */
  ref: string;
  credentials: string[];
  totpConfigured: boolean;
  /** Tenant to select, by manifest ref (or seeded display name); the runner resolves the UI name. */
  selectTenant?: string;
}

// --- Assertions ---

export interface CapturedTokens {
  /** null on access_token_format=opaque rows: an opaque token carries no readable claims. */
  accessTokenClaims: Record<string, unknown> | null;
  idTokenClaims: Record<string, unknown>;
}

/** `phaseTokens[i]` is phase i's tokens (`undefined` where none); top-level claims are the FINAL phase's. */
export interface ClaimAssertionArgs extends CapturedTokens {
  phaseTokens: Array<CapturedTokens | undefined>;
  user: ManifestUser;
}

/** A named token-claim check built by `framework/claim-assertions.ts`; scenarios never inline one. */
export interface ClaimAssertion {
  readonly name: string;
  run(args: ClaimAssertionArgs): Promise<void>;
}

export interface ScenarioAssertions {
  noTenantId?: boolean;
  tenantIdFromSeed?: boolean;
  /** Exactly these group names, order-insensitive. */
  groups?: string[];
  noGroups?: boolean;
  /** Run in order; the first failure wins. */
  claims?: readonly ClaimAssertion[];
}

// --- Interventions ---

/** Perturbations are data: primitives live in `framework/interventions.ts`; anchoring is validated by `defineScenario`. */
export interface StateIntervention {
  /** State in this phase's expectedPath to perturb (after its assertion). */
  at: PageStateType;
  do: "reload" | "replay-current-url" | "history-back" | "history-roundtrip" | "resend-code" | "drop-totp-out-of-band";
  expect?: PageStateType;
  expectUrlContains?: string;
  /** history-back: rewind until the URL contains this substring (bounded). */
  untilUrl?: string;
  /** history-roundtrip: the state one real browser Back must land on. */
  via?: PageStateType;
}

export interface TransitionIntervention {
  on: TransitionKey;
  do: "double-submit";
}

export type Intervention = StateIntervention | TransitionIntervention;

/** API-side checks run after the walk; implementations live in framework/intervention-checks.ts. */
export type PostCheckName = "code-replay-revokes-family" | "backup-codes-deactivated" | "device-code-replay-rejected" | "registered-address-unverified" | "linked-identity-tokens";

// --- Phases ---

export interface Phase {
  name: string;
  flowParams?: Record<string, string>;
  expectedPath: PageStateType[];
  /** Require a visible, non-empty error message after every self-transition in this phase. */
  expectError?: true;
  /** Clear every cookie before the start action. The virtual WebAuthn authenticator (CDP session) survives. */
  freshSession?: true;
  interventions?: Intervention[];
  finalUrlContains?: string;
}

// --- Scenario ---

export interface Scenario {
  id: string;
  description: string;
  /** Scenario is skipped when not met. */
  requires: ScenarioRequires;
  user: ScenarioUser;
  flowParams?: Record<string, string>;
  expectedPath?: PageStateType[];
  /** Single-phase form of `Phase.expectError`. */
  expectError?: true;
  /** Unset → a wrong code. "expired" → a well-formed code from a window Kratos no longer accepts. */
  totpCodeWindow?: "expired";
  /** "stale-after-resend" → resend, then submit the ORIGINAL code the resend invalidated (helpers/resend.ts). */
  verificationCodeSubmission?: "stale-after-resend";
  interventions?: Intervention[];
  finalUrlContains?: string;
  postChecks?: PostCheckName[];
  phases?: Phase[];
  assertions?: ScenarioAssertions;
  /** Defaults to ["live", "internal"]. */
  lanes?: ExecutionLane[];
  /** Runs admin-side in order after the scenario, even on failure, so a re-run sees the seeded identity. */
  cleanup?: CleanupKind | CleanupKind[];
}

export type CleanupKind = "remove-totp" | "remove-2fa" | "restore-password" | "remove-oidc" | "remove-backup-codes";

// --- Scenario Suite ---

export interface ScenarioSuite {
  name: string;
  scenarios: Scenario[];
  defaultLanes?: ExecutionLane[];
}

// --- Type-safe constructors ---

/** Type-narrowing constructor: validates the declaration at import time and returns it as-is. */
export function defineScenario(scenario: Scenario): Scenario {
  if (scenario.expectedPath && scenario.phases) {
    throw new Error(
      `Scenario "${scenario.id}" must have either expectedPath or phases, not both. ` +
      `Use expectedPath for single-phase scenarios, phases for multi-phase.`
    );
  }
  if (!scenario.expectedPath && !scenario.phases) {
    throw new Error(
      `Scenario "${scenario.id}" must have either expectedPath or phases.`
    );
  }
  // device-flow tokens arrive by RP polling, so `device-complete` is token-bearing under requires.deviceFlow.
  if (scenario.assertions) {
    const path = scenario.phases
      ? scenario.phases[scenario.phases.length - 1]?.expectedPath ?? []
      : scenario.expectedPath ?? [];
    const finalState = path[path.length - 1];
    const deviceTerminal = finalState === "device-complete" && scenario.requires.deviceFlow === true;
    if (finalState !== "oidc-callback" && !deviceTerminal) {
      throw new Error(
        `Scenario "${scenario.id}" declares assertions but its final state is ` +
        `"${finalState ?? "<empty path>"}", not "oidc-callback" (or "device-complete" with ` +
        `requires.deviceFlow). No tokens are issued there, so the assertions could never be ` +
        `evaluated — remove them, or extend the path to a token-bearing terminal.`
      );
    }
    if (scenario.assertions.claims && scenario.assertions.claims.length === 0) {
      throw new Error(
        `Scenario "${scenario.id}" declares an empty assertions.claims list — it asserts nothing; ` +
        `name at least one claim assertion or remove the field.`
      );
    }
  }
  if (scenario.expectError) {
    if (scenario.phases) {
      throw new Error(
        `Scenario "${scenario.id}" declares expectError alongside phases. ` +
        `Declare it on the phase whose path contains the self-transition.`
      );
    }
    const path = scenario.expectedPath ?? [];
    if (!path.some((state, i) => i > 0 && state === path[i - 1])) {
      throw new Error(
        `Scenario "${scenario.id}" declares expectError but its expectedPath has no ` +
        `self-transition (no state repeated back-to-back), so nothing would ever check ` +
        `for an error message — remove it, or repeat the state the flow stays on.`
      );
    }
  }
  if (scenario.verificationCodeSubmission) {
    const paths = scenario.phases
      ? scenario.phases.map((p) => p.expectedPath)
      : [scenario.expectedPath ?? []];
    const hasPair = paths.some((p) =>
      p.some((state, i) => i > 0 && state === "verification" && p[i - 1] === "verification"),
    );
    if (!hasPair || !scenario.expectError && !scenario.phases?.some((p) => p.expectError)) {
      throw new Error(
        `Scenario "${scenario.id}" declares verificationCodeSubmission but no path contains a ` +
        `"verification → verification" self-transition with expectError — the knob could never fire.`
      );
    }
  }
  for (const phase of scenario.phases ?? []) {
    const path = phase.expectedPath;
    if (phase.expectError && !path.some((state, i) => i > 0 && state === path[i - 1])) {
      throw new Error(
        `Scenario "${scenario.id}" phase "${phase.name}" declares expectError but its ` +
        `expectedPath has no self-transition (no state repeated back-to-back), so nothing ` +
        `would ever check for an error message.`
      );
    }
    if (phase.freshSession && phase === scenario.phases?.[0]) {
      throw new Error(
        `Scenario "${scenario.id}" phase "${phase.name}" declares freshSession, but it is the ` +
        `first phase — the browser context is already unauthenticated there, so the flag has ` +
        `no effect. Declare it on the phase that must NOT reuse the earlier phase's session.`
      );
    }
  }
  if (scenario.interventions && scenario.phases) {
    throw new Error(
      `Scenario "${scenario.id}" declares interventions alongside phases. ` +
      `Declare them on the phase whose walk they perturb.`
    );
  }
  if (scenario.postChecks?.length) {
    const path = scenario.phases
      ? scenario.phases[scenario.phases.length - 1]?.expectedPath ?? []
      : scenario.expectedPath ?? [];
    const finalState = path[path.length - 1];
    const deviceTerminal = finalState === "device-complete" && scenario.requires.deviceFlow === true;
    if (finalState !== "oidc-callback" && !deviceTerminal) {
      throw new Error(
        `Scenario "${scenario.id}" declares postChecks but does not end at "oidc-callback" (or ` +
        `"device-complete" with requires.deviceFlow) — no tokens are issued, so the checks could never run.`
      );
    }
  }
  const interventionSets: Array<[string, PageStateType[], Intervention[]]> = scenario.phases
    ? scenario.phases.map((p) => [`phase "${p.name}"`, p.expectedPath, p.interventions ?? []])
    : [["expectedPath", scenario.expectedPath ?? [], scenario.interventions ?? []]];
  for (const [where, path, interventions] of interventionSets) {
    for (const iv of interventions) {
      if ("on" in iv) {
        const pairs = path.slice(1).map((to, i) => `${path[i]} → ${to}`);
        if (!pairs.includes(iv.on)) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: intervention on "${iv.on}" does not match ` +
            `any consecutive pair of the path — it would never fire.`
          );
        }
        continue;
      }
      const occurrences = path.filter((s) => s === iv.at).length;
      if (occurrences !== 1) {
        throw new Error(
          `Scenario "${scenario.id}" ${where}: intervention at "${iv.at}" requires that state ` +
          `to appear exactly once in the path (found ${occurrences}).`
        );
      }
      const isFinal = path[path.length - 1] === iv.at;
      if (iv.do === "reload") {
        if (iv.at === "oidc-callback") {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "reload" at "oidc-callback" re-sends the ` +
            `authorization code — declare "replay-current-url" with its expected terminal instead.`
          );
        }
        if (iv.expect || iv.untilUrl || iv.via) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "reload" re-detects the same state; ` +
            `it takes no expect/untilUrl/via.`
          );
        }
      } else if (iv.do === "history-roundtrip") {
        // Self-returning (Back → via, Forward → `at`, walk continues), hence legal mid-walk.
        if (!iv.via) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "history-roundtrip" requires via — ` +
            `the state one real browser Back must land on.`
          );
        }
        if (iv.expect || iv.untilUrl || iv.expectUrlContains) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "history-roundtrip" returns to "${iv.at}" by ` +
            `definition; it takes no expect/untilUrl/expectUrlContains.`
          );
        }
      } else if (iv.do === "resend-code") {
        if (iv.at !== "verification") {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "resend-code" is only legal at "verification" — ` +
            `no other state renders a resend control (the recovery code page has none).`
          );
        }
        if (isFinal) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "resend-code" must be anchored mid-walk — ` +
            `the following code submit is what proves the resent code works.`
          );
        }
        if (iv.expect || iv.untilUrl || iv.via) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "resend-code" stays on "${iv.at}"; ` +
            `it takes no expect/untilUrl/via.`
          );
        }
      } else if (iv.do === "drop-totp-out-of-band") {
        if (isFinal) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "drop-totp-out-of-band" must be anchored ` +
            `mid-walk — the states after it are what observe the dropped credential.`
          );
        }
        if (iv.expect || iv.untilUrl || iv.via) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "drop-totp-out-of-band" stays on "${iv.at}"; ` +
            `it takes no expect/untilUrl/via.`
          );
        }
      } else {
        if (!isFinal) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "${iv.do}" abandons the walk, so it is only ` +
            `legal at the final path state ("${path[path.length - 1]}"), not at "${iv.at}".`
          );
        }
        if (!iv.expect) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "${iv.do}" must declare the terminal state it expects.`
          );
        }
        if (iv.do === "history-back" && !iv.untilUrl) {
          throw new Error(
            `Scenario "${scenario.id}" ${where}: "history-back" requires untilUrl.`
          );
        }
      }
    }
  }
  // `lanes` stays untouched: `defineScenarioSuite` applies defaultLanes; readers fall back to both lanes.
  return scenario;
}

/** Applies `defaultLanes` and rejects duplicate scenario ids; otherwise returns the input as-is. */
export function defineScenarioSuite(suite: ScenarioSuite): ScenarioSuite {
  const defaultLanes = suite.defaultLanes ?? ["live", "internal"];

  const ids = new Set<string>();
  const scenarios = suite.scenarios.map((scenario) => ({
    ...scenario,
    lanes: scenario.lanes ?? defaultLanes,
  }));
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(
        `Duplicate scenario ID "${scenario.id}" in suite "${suite.name}". ` +
        `Scenario IDs must be unique within a suite.`
      );
    }
    ids.add(scenario.id);
  }
  return {
    ...suite,
    defaultLanes,
    scenarios,
  };
}
