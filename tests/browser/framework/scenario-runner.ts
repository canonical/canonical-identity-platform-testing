// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Scenario runner — executes a scenario against a Playwright Page.
 *
 * For each phase in the scenario:
 *   1. Start the OIDC flow (with flowParams if any)
 *   2. Walk the expectedPath, asserting page state at each step
 *   3. Execute transition actions via the action resolver
 *   4. Run final assertions
 *
 * The runner uses Playwright's test.step() for structured trace output.
 */

import { test, expect, Page } from "@playwright/test";
import { assertPageState } from "../helpers/page-state";
import type { PageStateType } from "../helpers/page-state";
import { resolveAction } from "./action-resolver";
import { validatePath } from "./transition-validator";
import { runStateIntervention } from "./interventions";
import { runPostCheck } from "./intervention-checks";
import { listTenantOptions } from "../helpers/navigation";
import { findUserByRef, readManifest, resolveTenantDisplayName } from "./manifest";
import { readClaim } from "../helpers/jwt";
import type { Manifest, ManifestUser } from "../seeder/manifest-schema";
import { expectOIDCFlowComplete, pollDeviceToken, type OIDCTokens } from "../helpers/oidc";
import type { TokenClaims } from "../helpers/jwt";
import type { Scenario, Phase, ExecutionLane } from "./scenario-types";
import type { ActionContext } from "./transitions";
import type { WebAuthnHelper } from "../helpers/webauthn";
import { getExecutionLane, isLaneEnforcementDisabled } from "../helpers/config";
import {
  deleteIdentityCredentialType,
  getUnusedBackupCode,
  removeTotpViaPublicApi,
  setIdentityPassword,
} from "../helpers/kratos";
import { readActiveConfig } from "./active-config";
import { satisfies } from "./requires";

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

/**
 * Execute a single phase of a scenario.
 * Walks the expectedPath, asserts state at each step, and executes actions.
 */
/**
 * A tenant selection page must offer exactly the tenants the user belongs to.
 *
 * Checked automatically wherever the page appears rather than declared
 * per-scenario: showing a user a tenant they are not a member of is a leak,
 * and the seeded "Gamma Ltd" (no members) is what makes this discriminating —
 * without it every seeded tenant is one of multi-tenant-user's, so listing all
 * of them would look correct.
 */
async function assertTenantOptions(
  page: Page,
  user: ManifestUser,
  manifest: Manifest,
): Promise<void> {
  const expected = (user.tenantRefs ?? [])
    .map((ref) => manifest.tenants.find((t) => t.ref === ref)?.name)
    .filter((n): n is string => Boolean(n))
    .sort();

  expect(
    expected.length,
    `user "${user.ref}" reached tenant selection but the manifest gives them no tenants`,
  ).toBeGreaterThan(0);

  const actual = (await listTenantOptions(page)).sort();
  expect(actual, `tenant options offered to "${user.ref}"`).toEqual(expected);
}

/**
 * Where a rejected submit puts its error message, derived from the login-ui's
 * own components — not guessed.
 *
 * The workload is login-ui v0.28.0 (tag v0.28.0 = 197703c9). Its error path is:
 *
 *  1. the Go backend maps the Kratos flow message to a plain error string
 *     ("incorrect username or password" for 4000006, "invalid authentication
 *      code" for 4000008, …) and returns it as the flow-update response body —
 *     canonical/identity-platform-login-ui@197703c9 pkg/kratos/service.go:1076
 *     and pkg/kratos/handlers.go:573.
 *  2. <Flow> stores that string and hands it to every rendered node —
 *     canonical/identity-platform-login-ui@197703c9 ui/components/Flow.tsx:169
 *     (catch) and :212 (`error={capitalize(error)}`).
 *  3. the field component turns it into a validation message: the password
 *     field via PasswordToggle (ui/components/NodeInputPassword.tsx:15, :51),
 *     the totp_code / code fields via Input (ui/components/NodeInputText.tsx:107,
 *     :217). Verification additionally copies the flow's own error onto the code
 *     node's messages (ui/pages/verification.tsx:208).
 *  4. both render through a Field: wrapper gains `is-error`, message is a
 *     <p class="p-form-validation__message"> —
 *     canonical/identity-platform-login-ui@197703c9 ui/components/Field.tsx:98, :213
 *     (login-ui's vendored copy) and canonical/react-components@5df0690d
 *     src/components/Field/Field.tsx:101, :215 (@canonical/react-components
 *     3.2.0, the version ui/package.json pins).
 *
 * Page-level errors (tenant selection) instead use react-components'
 * Notification: <div class="p-notification--negative"><p
 * class="p-notification__message"> — canonical/react-components@5df0690d
 * src/components/Notifications/Notification/Notification.tsx:160, :177.
 *
 * Neither carries role="alert" (checked in both sources), so an ARIA-role
 * locator would match nothing; the Next.js route announcer is the only
 * role="alert" on these pages and it carries the page title, not an error.
 */
const ERROR_MESSAGE_SELECTORS = [
  ".p-form-validation.is-error .p-form-validation__message",
  ".p-notification--negative .p-notification__message",
] as const;

const ERROR_MESSAGE_TIMEOUT_MS = 10_000;

/**
 * A self-transition ("submitted a bad value, still on the same page") is only a
 * real error assertion if something reads the error. Without this, a swallowed
 * submit, a disabled button or a missing banner all look like success, because
 * `assertPageState` just re-detects the page the user never left (R-2).
 *
 * Either selector may match — whichever the page uses — but one must, and its
 * text must be non-empty.
 */
async function assertVisibleError(page: Page, state: PageStateType): Promise<void> {
  const message = page
    .locator(ERROR_MESSAGE_SELECTORS.map((selector) => `${selector}:visible`).join(", "))
    .first();

  await expect(
    message,
    `no visible error message on "${state}" after the rejected submit ` +
      `(looked for ${ERROR_MESSAGE_SELECTORS.join(" or ")})`,
  ).toBeVisible({ timeout: ERROR_MESSAGE_TIMEOUT_MS });

  expect(
    ((await message.textContent()) ?? "").trim(),
    `error element on "${state}" rendered but its text is empty`,
  ).not.toBe("");
}

/** Runs one phase and, when it ends at the OIDC callback, returns the tokens the
 *  relying party received for THAT phase.
 *
 *  Per-phase capture is what makes a re-authentication assertion possible at
 *  all: `auth_time` is only meaningful against a reference point, so proving
 *  "the platform really re-challenged" needs phase 1's token next to phase 2's.
 *  Path alone cannot distinguish a genuine re-challenge from a replayed
 *  session (R-22). The read is a pure scrape of the callback page the phase
 *  already landed on — no extra navigation. */
async function runPhase(
  page: Page,
  user: ManifestUser,
  phase: Phase,
  ctx: ActionContext,
  manifest: Manifest,
): Promise<OIDCTokens | undefined> {
  // Validate the expected path before executing
  const fullPath: (PageStateType | "start")[] = ["start", ...phase.expectedPath];
  const illegal = validatePath(fullPath);
  if (illegal.length > 0) {
    throw new Error(
      `Scenario phase "${phase.name}" has illegal transitions in expectedPath:\n` +
      illegal.map((t) => `  ${t}`).join("\n") +
      `\nUpdate the expectedPath or add the transition to the legal-transition table.`
    );
  }

  // A phase may demand an unauthenticated starting point. Cookies only: the
  // virtual authenticator lives on the CDP session, so a key enrolled in an
  // earlier phase survives while the platform sees a first-time visitor.
  if (phase.freshSession) {
    await test.step("Clear browser session (cookies only — the virtual authenticator persists)", async () => {
      await page.context().clearCookies();
    });
  }

  // Start the flow — navigate to the OIDC consumer
  const firstState = phase.expectedPath[0];
  const startAction = resolveAction("start", firstState);

  await test.step(`Start flow: ${startAction.description}`, async () => {
    // Start actions MUST share the same context object as walk transitions.
    // Passing a spread copy here silently discarded anything a start action
    // stored — which is how the verification mail cursor went missing and the
    // suite read a stale code from a previous run.
    ctx.flowParams = phase.flowParams;
    await startAction.action(page, user, ctx);
  });

  const interventions = phase.interventions ?? [];

  // Walk the expected path
  for (let i = 0; i < phase.expectedPath.length; i++) {
    const expectedState = phase.expectedPath[i];

    // Assert we're in the expected state
    await test.step(`Assert page state: ${expectedState}`, async () => {
      await assertPageState(page, expectedState);
      if (expectedState === "tenant-selection") {
        await assertTenantOptions(page, user, manifest);
      }
    });

    // Post-condition for self-transitions: the flow stayed put BECAUSE it was
    // rejected. Only meaningful when from === to, which is why it hangs off the
    // repeated state rather than off the transition.
    if (phase.expectError && i > 0 && phase.expectedPath[i - 1] === expectedState) {
      await test.step(`Assert visible error on: ${expectedState}`, async () => {
        await assertVisibleError(page, expectedState);
      });
    }

    // If there's a next state, run this state's interventions, then resolve
    // and execute the transition action. Final-state interventions run after
    // the token scrape below — they navigate off the terminal.
    if (i < phase.expectedPath.length - 1) {
      for (const iv of interventions) {
        if ("at" in iv && iv.at === expectedState) {
          await runStateIntervention(page, iv);
        }
      }

      const nextState = phase.expectedPath[i + 1];
      const transition = resolveAction(expectedState, nextState);
      const doubled = interventions.some(
        (iv) => "on" in iv && iv.on === `${expectedState} → ${nextState}`,
      );
      if (doubled) {
        ctx.doubleSubmit = true;
        ctx.doubleSubmitConsumed = false;
      }

      await test.step(
        doubled ? `${transition.description} (double submit)` : transition.description,
        async () => {
          await transition.action(page, user, ctx);
        },
      );

      if (doubled) {
        // A set-but-unconsumed flag means the transition's action ignored the
        // modifier: the intervention would be decorative. Fail loudly instead.
        if (!ctx.doubleSubmitConsumed) {
          throw new Error(
            `Transition "${expectedState} → ${nextState}" does not support the double-submit ` +
            `intervention — its action never consumed ctx.doubleSubmit. Forward the flag to the ` +
            `submit helper (helpers/form.ts clickSubmit) and acknowledge it.`,
          );
        }
        ctx.doubleSubmit = false;
      }
    }
  }

  const lastState = phase.expectedPath[phase.expectedPath.length - 1];
  const tokens =
    lastState === "oidc-callback" ? await expectOIDCFlowComplete(page) : undefined;

  // Final-state interventions: the walk is complete and any tokens are
  // captured, so the perturbation is free to navigate off the terminal.
  for (const iv of interventions) {
    if ("at" in iv && iv.at === lastState) {
      await runStateIntervention(page, iv);
    }
  }

  if (phase.finalUrlContains) {
    await test.step(`Assert final URL contains "${phase.finalUrlContains}"`, async () => {
      expect(page.url()).toContain(phase.finalUrlContains!);
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a scenario against a Playwright Page.
 *
 * For single-phase scenarios: runs the expectedPath.
 * For multi-phase scenarios: runs each phase sequentially in the same
 * browser context (cookies/sessions carry over between phases).
 *
 * @param page The Playwright Page to drive
 * @param scenario The scenario to execute
 * @param manifest The seed manifest with user/tenant data
 */

/**
 * Evaluate a scenario's token assertions against what the relying party
 * actually received.
 *
 * This is the only place the suite checks the platform's real output rather
 * than the page the browser landed on. Both tokens are checked: a claim present
 * in one and missing from the other is a defect, not a pass.
 */
async function assertTokenClaims(
  scenario: Scenario,
  user: ManifestUser,
  manifest: Manifest,
  tokens: OIDCTokens,
  phaseTokens: Array<OIDCTokens | undefined> = [],
): Promise<void> {
  const a = scenario.assertions!;
  // Opaque access tokens carry no readable claims (accessTokenClaims is
  // null on access_token_format=opaque rows) — claim assertions then run
  // against the ID token only. Introspection-side assertions are the
  // opaque rows' still-open variant (docs/testing-spec.md, "Open work": scenario variants).
  const sides: [string, TokenClaims][] = tokens.accessTokenClaims
    ? [
        ["access token", tokens.accessTokenClaims],
        ["ID token", tokens.idTokenClaims],
      ]
    : [["ID token", tokens.idTokenClaims]];

  if (a.noTenantId) {
    for (const [label, claims] of sides) {
      expect(
        readClaim(claims, "tenant_id"),
        `${label} must not carry a tenant_id for user "${user.ref}"`,
      ).toBeUndefined();
    }
  }

  if (a.tenantIdFromSeed) {
    const tenantRef = scenario.user.selectTenant ?? user.tenantRefs?.[0];
    const expected = manifest.tenants.find(
      (t) => t.ref === tenantRef || t.name === tenantRef,
    )?.id;
    expect(
      expected,
      `scenario "${scenario.id}" asserts tenantIdFromSeed but no seeded tenant matches "${tenantRef}"`,
    ).toBeDefined();
    for (const [label, claims] of sides) {
      expect(readClaim(claims, "tenant_id"), `${label} tenant_id`).toBe(expected);
    }
  }

  if (a.noGroups) {
    for (const [label, claims] of sides) {
      const groups = readClaim(claims, "groups");
      expect(
        groups === undefined || (Array.isArray(groups) && groups.length === 0),
        `${label} must not carry groups for user "${user.ref}", got ${JSON.stringify(groups)}`,
      ).toBe(true);
    }
  }

  if (a.groups) {
    for (const [label, claims] of sides) {
      const groups = readClaim(claims, "groups");
      expect(
        Array.isArray(groups),
        `${label} must carry a groups array for user "${user.ref}", got ${JSON.stringify(groups)}`,
      ).toBe(true);
      expect([...(groups as string[])].sort(), `${label} groups`).toEqual(
        [...a.groups].sort(),
      );
    }
  }

  if (a.custom) {
    await a.custom({
      accessTokenClaims: tokens.accessTokenClaims,
      idTokenClaims: tokens.idTokenClaims,
      phaseTokens,
    });
  }
}

export async function runScenario(
  page: Page,
  scenario: Scenario,
  extraCtx?: {
    webauthn?: WebAuthnHelper;
    /** Scenario-owned pre-walk work (e.g. registration's delete-before-recreate).
     *  Runs AFTER the lane and satisfies() gates and the manifest read — spec
     *  code placed before runScenario() runs on scenarios the declaration
     *  excludes, which turns their skips into failures the moment a
     *  prerequisite (manifest, admin API) is missing on the lane. */
    prepare?: (manifest: Manifest) => Promise<void>;
  },
): Promise<void> {
  const lane = getExecutionLane();
  const scenarioLanes = scenario.lanes ?? ["live", "internal"];

  // Gating: lane first, then the DECLARATION via satisfies(). One predicate, no
  // env switch. The legacy fallback this replaced enforced only 5 of the 13
  // `requires:` keys and warn-only ignored the rest — and the blocking gate ran
  // exactly that path, so keys like `mfaEnforced`, `localUsersEnabled` and
  // `oidcSequencing` were decorative while the expected-set contract assumed
  // they gated (R-6).
  if (!isLaneEnforcementDisabled() && !scenarioLanes.includes(lane)) {
    test.skip(true, `Skipped: scenario not compatible with lane "${lane}" (supported: ${scenarioLanes.join(", ")})`);
    return;
  }
  const satisfiesResult = satisfies(scenario.requires, readActiveConfig());
  if (!satisfiesResult.met) {
    test.skip(true, `Skipped: ${satisfiesResult.reason}`);
    return;
  }

  // Read the manifest only once the scenario is known to run. Gating must not
  // depend on a file the lane legitimately may not have: an eager read turns
  // every lane/capability skip on an unseeded deployment into a hard
  // "Manifest file not found".
  const manifest = readManifest();

  if (extraCtx?.prepare) {
    await extraCtx.prepare(manifest);
  }

  // Look up the user in the manifest
  const user = findUserByRef(manifest, scenario.user.ref);
  // Snapshot the seeded password NOW. The reset-password transition mutates
  // `user.password` in place so later phases authenticate with the new value,
  // and findUserByRef would hand the cleanup that same mutated object — which
  // would "restore" the password to the one the test just set.
  const seededPassword = user.password;

  // Build the action context
  const ctx: ActionContext = {
    lane,
    flowParams: scenario.flowParams ?? {},
    selectTenant: resolveTenantDisplayName(manifest, scenario.user.selectTenant),
    totpCodeWindow: scenario.totpCodeWindow,
    webauthn: extraCtx?.webauthn,
    // What the settings restore pass submits (transitions.ts
    // "reset-password → reset-password"): the pre-mutation truth, same snapshot
    // the restore-password cleanup uses.
    seededPassword: seededPassword ?? undefined,
  };

  // Populate TOTP secret from the manifest (seeded by the seeder)
  if (scenario.user.totpConfigured) {
    if (!user.totpSecret) {
      throw new Error(
        `Scenario requires TOTP for user "${user.ref}" but totpSecret is null in the manifest. ` +
        `This means the user was not properly seeded. Run "make seed-test-data-clean" to re-seed.`,
      );
    }
    ctx.totpSecret = user.totpSecret;
  }

  // Backup codes are one-shot, so never trust the manifest's seeded value: it
  // records only the first code issued, and the first scenario to use it burns
  // it. Resolve a still-unused code from Kratos instead.
  if (scenario.user.credentials?.includes("lookup_secret")) {
    ctx.backupCode = await getUnusedBackupCode(user.identityId);
  }

  // Normalize to phases
  const phases: Phase[] = scenario.phases ?? [
    {
      name: "default",
      flowParams: scenario.flowParams,
      expectedPath: scenario.expectedPath!,
      expectError: scenario.expectError,
      interventions: scenario.interventions,
      finalUrlContains: scenario.finalUrlContains,
    },
  ];

  // Run cleanup to undo side-effects.
  // Uses try/finally so cleanup runs even if the scenario fails.
  // This is critical for tests like first-login-mfa that set up TOTP —
  // without cleanup, re-running the suite would see login-totp-verify
  // instead of setup-secure.
  const cleanup = scenario.cleanup;
  try {
    // Tokens per phase. Sparse on purpose: index i is phase i, `undefined`
    // where that phase issued none. Two token sources: phases ending at the
    // OIDC callback capture from the consumer page (runPhase), and phases
    // ending at device-complete redeem ctx.deviceCode at the token endpoint —
    // device tokens arrive by RP polling (RFC 8628 §3.4), never a callback,
    // so a failed poll here fails the walk even when no assertion reads the
    // tokens: issuance IS the grant's contract.
    const phaseTokens: Array<OIDCTokens | undefined> = [];
    for (const [index, phase] of phases.entries()) {
      await test.step(`Phase: ${phase.name}`, async () => {
        phaseTokens[index] = await runPhase(page, user, phase, ctx, manifest);
        const terminal = phase.expectedPath[phase.expectedPath.length - 1];
        if (!phaseTokens[index] && terminal === "device-complete" && ctx.deviceCode) {
          phaseTokens[index] = await pollDeviceToken(page, ctx.deviceCode);
        }
      });
    }

    if (scenario.assertions) {
      await test.step("Final assertions", async () => {
        const lastPhase = phases[phases.length - 1]!;
        const lastState = lastPhase.expectedPath[lastPhase.expectedPath.length - 1];

        // defineScenario() rejects this combination at import time, so
        // collection is the real gate. Belt-and-braces for a scenario object
        // built without the constructor: throw, never warn-and-return — a
        // downgraded assertion block is how a dead `noTenantId` shipped.
        // device-complete is the one other token-bearing terminal (RP-polled).
        const deviceTerminal = lastState === "device-complete" && scenario.requires.deviceFlow === true;
        if (lastState !== "oidc-callback" && !deviceTerminal) {
          throw new Error(
            `Scenario "${scenario.id}" declares assertions but ends on "${lastState}", ` +
              "not oidc-callback or a device-flow terminal — no tokens are issued, so they cannot be evaluated.",
          );
        }

        const tokens = phaseTokens[phases.length - 1] ?? (await expectOIDCFlowComplete(page));
        await assertTokenClaims(scenario, user, manifest, tokens, phaseTokens);
      });
    }

    if (scenario.postChecks?.length) {
      await test.step("Post checks", async () => {
        const tokens = phaseTokens[phases.length - 1];
        if (!tokens) {
          throw new Error(
            `Scenario "${scenario.id}" declares postChecks but its final phase captured no tokens.`,
          );
        }
        for (const name of scenario.postChecks!) {
          await test.step(`Post check: ${name}`, async () => {
            await runPostCheck(name, { page, tokens, manifest, user });
          });
        }
      });
    }
  } finally {
    try {
      if (cleanup === "remove-totp") {
        await removeTotpViaPublicApi(page, ctx.totpSecret ?? user.totpSecret);
      } else if (cleanup === "remove-2fa") {
        // Both factors, admin-side and unconditional. The public settings flow
        // needs a live AAL2 session, which is exactly what a scenario that
        // failed at the passkey step no longer has — public-flow cleanup would
        // leave the webauthn archetype carrying a stale TOTP credential across
        // runs.
        if (!user.identityId) {
          throw new Error(`cleanup "remove-2fa": no identityId for user "${user.ref}"`);
        }
        await deleteIdentityCredentialType(user.identityId, "webauthn");
        await deleteIdentityCredentialType(user.identityId, "totp");
      } else if (cleanup === "restore-password") {
        // The recovery scenarios change a shared seeded identity's password.
        // Put the seeded password back so later specs still authenticate —
        // returning-mfa is also used by login, error and session.
        if (seededPassword && user.identityId) {
          await setIdentityPassword(user.identityId, seededPassword);
        }
      }
    } catch (err) {
      // Cleanup best-effort: don't mask the original test failure. But say
      // what it costs — a silently skipped cleanup is why first-login-mfa
      // failed every rerun for a day before anyone saw a message.
      console.warn(
        `Cleanup "${cleanup}" for "${scenario.id}" failed (non-fatal): ${err} — ` +
        `the user's state is now ahead of the manifest, so the next run of this scenario will likely fail until a reseed`,
      );
    }
  }
}
