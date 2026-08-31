// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Scenario type system — typed data objects for declarative test scenarios.
 *
 * Scenarios are data, not logic. They declare what preconditions are needed,
 * what page-state path the user should traverse, and what assertions should
 * hold at the end. The scenario runner provides all behavior.
 *
 * Use `defineScenario()` and `defineScenarioSuite()` to create type-safe
 * scenario objects with IDE autocomplete and refactoring support.
 */

import type { PageStateType } from "../helpers/page-state";
import type { ExecutionLane } from "../helpers/config";
import type { TransitionKey } from "./transitions";

export type { ExecutionLane } from "../helpers/config";

// ---------------------------------------------------------------------------
// Profile preconditions
// ---------------------------------------------------------------------------

/** Platform configuration requirements for a scenario. */
export interface ScenarioRequires {
  /** MFA (TOTP) must be enabled on the login-ui. */
  mfaEnabled?: boolean;
  /** Multi-tenancy must be enabled (tenant-service in profile). */
  multiTenancy?: boolean;
  /** OIDC providers that must be configured. */
  oidcProviders?: string[];
  /** WebAuthn must be enabled. */
  webauthnEnabled?: boolean;
  /** Hook service must be in the profile. */
  hookService?: boolean;

  // ── Configuration flags ──────

  /** OIDC sequencing must be enabled (oidc_sequencing flag). */
  oidcSequencing?: boolean;
  /** Local (password) users must be enabled (local_users_enabled flag). */
  localUsersEnabled?: boolean;
  /** MFA must be enforced for all users (mfa_enforced flag). */
  mfaEnforced?: boolean;
  /** Registration must be enabled (registration_enabled flag). */
  registrationEnabled?: boolean;
  /** Account linking must be enabled (account_linking_enabled flag). */
  accountLinkingEnabled?: boolean;
  /** OIDC must be enabled (oidc_enabled flag). */
  oidcEnabled?: boolean;
  /** Required first-factor authentication methods (e.g. ["oidc"], ["password"]). */
  firstFactorMethods?: string[];
  /** Required second-factor authentication methods (e.g. ["totp", "webauthn"]). */
  secondFactorMethods?: string[];
  /** Mail (mailslurper) API must be reachable — the scenario reads email (mail_api capability). */
  mailApi?: boolean;
  /** Backup-code regeneration prompt renders after every backup-code sign-in
   *  (backup_code_prompt_on_use capability — a login-ui version fork). */
  backupCodePromptOnUse?: boolean;
  /** RFC 8628 device authorization grant is wired (device_flow capability). */
  deviceFlow?: boolean;

  /** Support service-presence keys of the form "service:<name>". */
  [key: `service:${string}`]: boolean | undefined;
}

// ---------------------------------------------------------------------------
// User references
// ---------------------------------------------------------------------------

/** User attributes required by a scenario. Maps to a seeded user in the manifest. */
export interface ScenarioUser {
  /** Reference to a user in the seed manifest (e.g., "first-mfa", "returning-mfa"). */
  ref: string;
  /** Credential types this user has (e.g., ["password", "totp"], ["oidc/dex"]). */
  credentials: string[];
  /** Whether the user has TOTP configured (affects which page states appear). */
  totpConfigured: boolean;
  /** Whether the user's email is verified (default: true). Set false for verification scenarios. */
  verified?: boolean;
  /** Number of tenants the user belongs to (0, 1, or "many"). */
  tenantCount?: 0 | 1 | "many";
  /** For multi-tenant scenarios: which tenant to select, by manifest ref (or
   *  its seeded display name). The runner resolves it to the name the UI shows,
   *  so scenarios never restate the seeder's naming convention. */
  selectTenant?: string;
  /** Whether the user has an active session (for session-reuse scenarios). */
  hasActiveSession?: boolean;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Assertions to check after a scenario completes.
 *
 * These run against the tokens the relying party actually received, which is
 * the platform's real output — page navigation only proves the user got
 * somewhere. Claims added by hook-service (`groups`, `tenant_id`) arrive as
 * session extras: top level in the ID token, and under `ext` in the access
 * token. `readClaim` in the runner normalises that difference.
 *
 * Only meaningful for scenarios that end on `oidc-callback`; the runner skips
 * them otherwise rather than failing, because a settings or verification flow
 * legitimately issues no token.
 */
/** The decoded claims of one relying-party token pair. */
export interface CapturedTokens {
  /** null on access_token_format=opaque rows: an opaque token carries no readable claims. */
  accessTokenClaims: Record<string, unknown> | null;
  idTokenClaims: Record<string, unknown>;
}

/** What a `custom` assertion receives.
 *
 *  `phaseTokens` carries the tokens EACH phase received (index = phase index,
 *  `undefined` where that phase issued none), which is what makes claims like
 *  `auth_time` assertable at all: freshness is only meaningful against a
 *  reference point, so proving a genuine re-challenge — rather than a replayed
 *  session — needs the earlier phase's token too (R-22). The top-level
 *  `accessTokenClaims`/`idTokenClaims` are the FINAL phase's. */
export interface CustomAssertionArgs extends CapturedTokens {
  phaseTokens: Array<CapturedTokens | undefined>;
}

export type CustomAssertion = (tokens: CustomAssertionArgs) => Promise<void>;

export interface ScenarioAssertions {
  /** Access and ID tokens must NOT carry a tenant_id claim. */
  noTenantId?: boolean;
  /** Tokens must carry the tenant_id of the user's seeded tenant. */
  tenantIdFromSeed?: boolean;
  /** Tokens must carry exactly these group names (order-insensitive). */
  groups?: string[];
  /** Tokens must NOT carry a groups claim — e.g. where hook-service is absent. */
  noGroups?: boolean;
  /** Custom assertion for anything the flags above do not cover. */
  custom?: CustomAssertion;
}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

/**
 * A deterministic perturbation applied to a phase walk — the declarative form
 * of "weird user behavior" (F5, back-button, URL replay, double-click).
 *
 * Interventions stay data, like everything else in a scenario: primitives live
 * in `framework/interventions.ts`, scenarios only name them and anchor them to
 * a state (`at`) or a transition (`on`) of their own expectedPath.
 *
 * Anchoring rules (enforced at import time by `defineScenario`):
 *  - `at` must name a state that appears exactly once in the phase's path.
 *  - "reload" re-detects the same state afterwards; it is forbidden at
 *    "oidc-callback" — reloading the callback re-sends the authorization code,
 *    which is a different behavior with its own primitive.
 *  - "replay-current-url" and "history-back" abandon the walk, so they are
 *    only legal at the FINAL state, and declare the terminal they expect.
 *  - "history-roundtrip" is the FORWARD model: real browser Back must land on
 *    `via`, real browser Forward must land back on `at`, and the walk then
 *    CONTINUES — proving the re-rendered form is live, not a dead paint.
 *    Legal mid-walk because it is self-returning. Forward exists nowhere
 *    else in this app: everywhere except the push-based method switch, Back
 *    triggers a server redirect (a new navigation), which truncates the
 *    forward stack — so a standalone terminal "history-forward" would be
 *    machinery without a reachable use case.
 *  - `on` must name a consecutive pair of the path. The transition's action
 *    must explicitly support the modifier (the runner fails loudly when a
 *    transition ignores it, so a decorative intervention cannot ship).
 */
export interface StateIntervention {
  /** State in this phase's expectedPath to perturb (after its assertion). */
  at: PageStateType;
  do: "reload" | "replay-current-url" | "history-back" | "history-roundtrip";
  /** Terminal state expected after the perturbation (replay/history-back). */
  expect?: PageStateType;
  /** Substring the final URL must contain (e.g. an exact `error=` code). */
  expectUrlContains?: string;
  /** history-back: rewind until the URL contains this substring (bounded). */
  untilUrl?: string;
  /** history-roundtrip: the state one real browser Back must land on. */
  via?: PageStateType;
}

export interface TransitionIntervention {
  /** Transition of this phase's expectedPath whose action is modified. */
  on: TransitionKey;
  do: "double-submit";
}

export type Intervention = StateIntervention | TransitionIntervention;

/**
 * Named API-side checks that run after the walk, against the tokens the
 * relying party received and the scenario's manifest user. Scenarios name a
 * check; the implementation lives in framework/intervention-checks.ts.
 */
export type PostCheckName = "code-replay-revokes-family" | "backup-codes-deactivated" | "device-code-replay-rejected";

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** A single phase within a multi-phase scenario. */
export interface Phase {
  /** Human-readable name for this phase (used in test.step()). */
  name: string;
  /** Additional OIDC parameters (e.g., { max_age: "0" }). */
  flowParams?: Record<string, string>;
  /** Ordered list of page states the user should traverse in this phase. */
  expectedPath: PageStateType[];
  /**
   * Require a visible, non-empty error message after every self-transition in
   * this phase (a step where `expectedPath[i] === expectedPath[i - 1]`).
   *
   * Error scenarios are declared as a self-transition: fill a bad value, submit,
   * and expect to still be on the same page. That alone is a weak assertion —
   * `assertPageState` re-detecting the same page also passes when the submit was
   * swallowed, the button was disabled, or the error banner never rendered. This
   * flag is what turns "did not navigate" into "was rejected, visibly".
   */
  expectError?: true;
  /**
   * Start this phase from a clean browser session: every cookie in the context
   * is cleared before the phase's start action runs.
   *
   * The virtual WebAuthn authenticator is NOT touched — it belongs to the CDP
   * session, not to the cookie jar — so a key enrolled in an earlier phase is
   * still present while the platform sees an unauthenticated visitor. That
   * combination is the only way to reach a WebAuthn ASSERTION (sign-in with an
   * existing key): with the session intact login-ui legitimately skips straight
   * to the callback.
   */
  freshSession?: true;
  /** Perturbations applied at named points of this phase's walk. */
  interventions?: Intervention[];
  /** Substring the phase's final URL must contain (asserted after the walk
   *  and any final-state interventions). */
  finalUrlContains?: string;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** A declarative test scenario — data, not logic. */
export interface Scenario {
  /** Unique kebab-case identifier (e.g., "first-login-mfa"). */
  id: string;
  /** Human-readable description of what this scenario tests. */
  description: string;
  /** Platform configuration requirements. Scenario is skipped if not met. */
  requires: ScenarioRequires;
  /** User attributes required by this scenario. */
  user: ScenarioUser;
  /** Additional OIDC parameters (for single-phase scenarios). */
  flowParams?: Record<string, string>;
  /** Expected page-state path (for single-phase scenarios). */
  expectedPath?: PageStateType[];
  /**
   * Require a visible, non-empty error message after the self-transition in
   * `expectedPath` (single-phase scenarios; multi-phase declares it per phase).
   * See `Phase.expectError`.
   */
  expectError?: true;
  /**
   * Which TOTP window an error self-transition submits a code for.
   * Unset → a wrong code. "expired" → a well-formed code from a window Kratos
   * no longer accepts, which is a different rejection from a wrong code.
   */
  totpCodeWindow?: "expired";
  /** Perturbations applied to the walk (single-phase scenarios). */
  interventions?: Intervention[];
  /** Substring the final URL must contain (single-phase scenarios). */
  finalUrlContains?: string;
  /** API-side checks run after the walk against the issued tokens. */
  postChecks?: PostCheckName[];
  /** Multi-phase scenarios: array of phases executed in the same browser context. */
  phases?: Phase[];
  /** Assertions to check after the scenario completes. */
  assertions?: ScenarioAssertions;
  /** Execution lanes this scenario supports. Defaults to ["live", "internal"]. */
  lanes?: ExecutionLane[];
  /**
   * Cleanup action to run after the scenario completes (even on failure).
   * Used to undo side-effects so that re-running the suite produces the same
   * results:
   *   - "remove-totp"       unenrols a second factor the test set up
   *   - "remove-2fa"        unenrols BOTH the security key and the TOTP
   *                         secret a webauthn scenario had to set up. Runs
   *                         against the admin API, so it still works when
   *                         the scenario died with no usable session.
   *   - "restore-password"  undoes a self-service password change, leaving a
   *                         shared seeded identity as the seeder created it
   *
   * The cleanup receives the Playwright Page (with session cookies) and
   * the action context (which may carry state like totpSecret).
   */
  cleanup?: "remove-totp" | "remove-2fa" | "restore-password";
}

// ---------------------------------------------------------------------------
// Scenario Suite
// ---------------------------------------------------------------------------

/** A group of related scenarios (e.g., all login scenarios). */
export interface ScenarioSuite {
  /** Suite name (kebab-case, e.g., "login", "oidc", "tenant"). */
  name: string;
  /** Scenarios in this suite. */
  scenarios: Scenario[];
  /** Default lanes for scenarios in this suite when not set explicitly. */
  defaultLanes?: ExecutionLane[];
}

// ---------------------------------------------------------------------------
// Type-safe constructors
// ---------------------------------------------------------------------------

/**
 * Create a type-safe scenario object.
 * Returns the input as-is — this is a type-narrowing constructor, not a class.
 */
export function defineScenario(scenario: Scenario): Scenario {
  // Validate: must have either expectedPath or phases, not both
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
  // Validate: `assertions` are evaluated against the tokens the relying party
  // received, so they are only meaningful when the journey ENDS where tokens
  // exist. A block declared on any other final state can never run — and one
  // shipped that way (`noTenantId` on a scenario ending at
  // login-webauthn-verify), silently downgraded to a warning by the runner.
  // Fail at import instead: `make test-browser-list` then catches it.
  //
  // ONE exception (§10 item 10): device-flow tokens arrive via RP polling of
  // /oauth2/token, never a callback, so `device-complete` is a token-bearing
  // terminal on scenarios declaring requires.deviceFlow — the runner polls
  // with ctx.deviceCode there.
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
  }
  // Validate: `expectError` is enforced at self-transitions, so a path without
  // one can never evaluate it — that would be a decorative flag on exactly the
  // scenarios whose whole point is reading the error (R-2). Fail at import.
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
  for (const phase of scenario.phases ?? []) {
    const path = phase.expectedPath;
    if (phase.expectError && !path.some((state, i) => i > 0 && state === path[i - 1])) {
      throw new Error(
        `Scenario "${scenario.id}" phase "${phase.name}" declares expectError but its ` +
        `expectedPath has no self-transition (no state repeated back-to-back), so nothing ` +
        `would ever check for an error message.`
      );
    }
    // `freshSession` on the FIRST phase is a no-op: the phase already starts in
    // a context nothing has authenticated. Declaring it there reads as "this
    // phase is deliberately unauthenticated" while doing nothing, which is how
    // a decorative flag survives review.
    if (phase.freshSession && phase === scenario.phases?.[0]) {
      throw new Error(
        `Scenario "${scenario.id}" phase "${phase.name}" declares freshSession, but it is the ` +
        `first phase — the browser context is already unauthenticated there, so the flag has ` +
        `no effect. Declare it on the phase that must NOT reuse the earlier phase's session.`
      );
    }
  }
  // Validate: interventions must anchor to the path they perturb; a typo'd
  // anchor would otherwise be silently unreachable — a decorative intervention
  // is exactly the failure mode expectError's checks exist to prevent.
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
        // Self-returning: Back → via, Forward → back to `at`, walk continues.
        // Legal mid-walk for exactly that reason.
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
  // Deliberately returns the scenario with `lanes` untouched. Baking a default
  // here made `defineScenarioSuite`'s `scenario.lanes ?? defaultLanes` dead on
  // arrival, so a suite declaring `defaultLanes: ["internal"]` still ran in the
  // live lane. Both readers (`runScenario`, `scripts/expected-set.ts`) already
  // fall back to both lanes for a scenario that never reaches a suite.
  return scenario;
}

/**
 * Create a type-safe scenario suite.
 * Returns the input as-is — this is a type-narrowing constructor, not a class.
 */
export function defineScenarioSuite(suite: ScenarioSuite): ScenarioSuite {
  const defaultLanes = suite.defaultLanes ?? ["live", "internal"];

  // Validate: all scenario IDs must be unique within the suite
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
