// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test, expect, Page } from "@playwright/test";
import { assertPageState } from "../helpers/page-state";
import type { PageStateType } from "../helpers/page-state";
import { resolveAction } from "./action-resolver";
import { runStateIntervention } from "./interventions";
import { runPostCheck } from "./intervention-checks";
import { runClaimAssertions } from "./claim-assertions";
import { listTenantOptions } from "../helpers/navigation";
import { findUserByRef, readManifest, resolveTenantDisplayName } from "./manifest";
import { readClaim } from "../helpers/jwt";
import type { Manifest, ManifestUser } from "../seeder/manifest-schema";
import { expectOIDCFlowComplete, pollDeviceToken, type OIDCTokens } from "../helpers/oidc";
import type { TokenClaims } from "../helpers/jwt";
import type { Scenario, Phase } from "./scenario-types";
import type { ActionContext } from "./transitions";
import { WebAuthnHelper } from "../helpers/webauthn";
import { getExecutionLane, isLaneEnforcementDisabled } from "../helpers/config";
import {
  deleteIdentityCredentialType,
  getUnusedBackupCode,
  removeTotpViaPublicApi,
  setIdentityPassword,
} from "../helpers/kratos";
import { readActiveConfig } from "./active-config";
import { satisfies } from "./requires";
import { restoreViaSelfService } from "./restore";

// --- Phase execution ---

/** Tenant selection must offer exactly the user's tenants: offering a non-member tenant is a leak.
 *  The seeded memberless "Gamma Ltd" is what makes this discriminating. */
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

// Field errors render as Field validation messages, page-level errors as a Notification; neither carries role="alert".
// canonical/identity-platform-login-ui@197703c9 ui/components/Field.tsx:98,:213
// canonical/react-components@5df0690d src/components/Notifications/Notification/Notification.tsx:160,:177
const ERROR_MESSAGE_SELECTORS = [
  ".p-form-validation.is-error .p-form-validation__message",
  ".p-notification--negative .p-notification__message",
] as const;

const ERROR_MESSAGE_TIMEOUT_MS = 10_000;

/** A self-transition is only a rejection if an error is visible with non-empty text: a swallowed
 *  submit, a disabled button or a missing banner all re-detect the same page. */
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

/** Runs one phase; returns the tokens THIS phase's callback received (scraped, no extra navigation). */
async function runPhase(
  page: Page,
  user: ManifestUser,
  phase: Phase,
  ctx: ActionContext,
  manifest: Manifest,
): Promise<OIDCTokens | undefined> {
  // Cookies only: the virtual authenticator lives on the CDP session and must survive.
  if (phase.freshSession) {
    await test.step("Clear browser session (cookies only — the virtual authenticator persists)", async () => {
      await page.context().clearCookies();
    });
  }

  const firstState = phase.expectedPath[0];
  const startAction = resolveAction("start", firstState);

  await test.step(`Start flow: ${startAction.description}`, async () => {
    // Same context object as the walk: a spread copy would discard what the start action stores.
    ctx.flowParams = phase.flowParams;
    await startAction.action(page, user, ctx);
  });

  const interventions = phase.interventions ?? [];

  for (let i = 0; i < phase.expectedPath.length; i++) {
    const expectedState = phase.expectedPath[i];

    await test.step(`Assert page state: ${expectedState}`, async () => {
      await assertPageState(page, expectedState);
      if (expectedState === "tenant-selection") {
        await assertTenantOptions(page, user, manifest);
      }
    });

    if (phase.expectError && i > 0 && phase.expectedPath[i - 1] === expectedState) {
      await test.step(`Assert visible error on: ${expectedState}`, async () => {
        await assertVisibleError(page, expectedState);
      });
    }

    // Final-state interventions run after the token scrape below — they navigate off the terminal.
    if (i < phase.expectedPath.length - 1) {
      for (const iv of interventions) {
        if ("at" in iv && iv.at === expectedState) {
          await runStateIntervention(page, iv, user, ctx);
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
        // Set-but-unconsumed means the action ignored the modifier: a decorative intervention.
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

  for (const iv of interventions) {
    if ("at" in iv && iv.at === lastState) {
      await runStateIntervention(page, iv, user, ctx);
    }
  }

  if (phase.finalUrlContains) {
    await test.step(`Assert final URL contains "${phase.finalUrlContains}"`, async () => {
      expect(page.url()).toContain(phase.finalUrlContains!);
    });
  }

  return tokens;
}

// --- Scenario runner ---

/** Both tokens are checked: a claim present in one and missing from the other is a defect. */
async function assertTokenClaims(
  scenario: Scenario,
  user: ManifestUser,
  manifest: Manifest,
  tokens: OIDCTokens,
  phaseTokens: Array<OIDCTokens | undefined> = [],
): Promise<void> {
  const a = scenario.assertions!;
  // Opaque access tokens carry no readable claims, so only the ID token is checked; Hydra admin
  // introspection is not an option (internal-network only on every real deployment).
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
    // hook-service's token hook is tenant_id's only writer: without it the claim must be absent.
    const hookPresent = (readActiveConfig().services ?? []).includes("hook-service");
    for (const [label, claims] of sides) {
      if (hookPresent) {
        expect(readClaim(claims, "tenant_id"), `${label} tenant_id`).toBe(expected);
      } else {
        expect(
          readClaim(claims, "tenant_id"),
          `${label} must not carry a tenant_id without hook-service (its only writer) in the profile`,
        ).toBeUndefined();
      }
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

  if (a.claims) {
    await runClaimAssertions(a.claims, {
      accessTokenClaims: tokens.accessTokenClaims,
      idTokenClaims: tokens.idTokenClaims,
      phaseTokens,
      user,
    });
  }
}

export async function runScenario(
  page: Page,
  scenario: Scenario,
  extraCtx?: {
    webauthn?: WebAuthnHelper;
    /** Scenario-owned pre-walk work, run AFTER the lane/satisfies() gates and the manifest read
     *  so an excluded scenario still skips instead of failing on a missing prerequisite. */
    prepare?: (manifest: Manifest) => Promise<void>;
  },
): Promise<void> {
  const lane = getExecutionLane();
  const scenarioLanes = scenario.lanes ?? ["live", "internal"];

  // Gating: lane first, then the declaration via satisfies(); every `requires:` key gates.
  if (!isLaneEnforcementDisabled() && !scenarioLanes.includes(lane)) {
    test.skip(true, `Skipped: scenario not compatible with lane "${lane}" (supported: ${scenarioLanes.join(", ")})`);
    return;
  }
  const satisfiesResult = satisfies(scenario.requires, readActiveConfig());
  if (!satisfiesResult.met) {
    test.skip(true, `Skipped: ${satisfiesResult.reason}`);
    return;
  }

  // Every hop of every phase must resolve BEFORE any browser work, so a typo in phase 3 cannot
  // surface after phases 1-2 already mutated the deployment. After the skips, before the manifest read.
  const phaseWalks = scenario.phases?.map((p) => ({ label: ` (phase "${p.name}")`, expectedPath: p.expectedPath }))
    ?? [{ label: "", expectedPath: scenario.expectedPath ?? [] }];
  const missing: string[] = [];
  for (const { label, expectedPath } of phaseWalks) {
    const fullPath: (PageStateType | "start")[] = ["start", ...expectedPath];
    for (let i = 0; i < fullPath.length - 1; i++) {
      const to = fullPath[i + 1] as PageStateType;
      try {
        resolveAction(fullPath[i], to);
      } catch {
        missing.push(`  ${fullPath[i]} → ${to}${label}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Scenario "${scenario.id}" has transitions in expectedPath with no action in the transition table:\n` +
      missing.join("\n") +
      `\nUpdate the expectedPath or add the transition to framework/transitions.ts.`
    );
  }

  // Read the manifest only once the scenario is known to run: an unseeded lane must still skip.
  const manifest = readManifest();

  if (extraCtx?.prepare) {
    await extraCtx.prepare(manifest);
  }

  const user = findUserByRef(manifest, scenario.user.ref);
  // The reset-password transition mutates `user.password` in place; cleanup restores this snapshot.
  const seededPassword = user.password;

  // The virtual authenticator follows the DECLARATION, not the collecting spec file.
  const walks = scenario.phases?.map((p) => p.expectedPath) ?? [scenario.expectedPath ?? []];
  const needsAuthenticator = walks.some((p) => p.some((s) => s === "setup-passkey" || s === "login-webauthn-verify"));
  const webauthn = extraCtx?.webauthn ?? (needsAuthenticator ? new WebAuthnHelper(page) : undefined);
  if (webauthn && !extraCtx?.webauthn) await webauthn.setup();

  const ctx: ActionContext = {
    lane,
    flowParams: scenario.flowParams ?? {},
    selectTenant: resolveTenantDisplayName(manifest, scenario.user.selectTenant),
    totpCodeWindow: scenario.totpCodeWindow,
    verificationCodeSubmission: scenario.verificationCodeSubmission,
    webauthn,
    seededPassword: seededPassword ?? undefined,
  };

  if (scenario.user.totpConfigured) {
    if (!user.totpSecret) {
      throw new Error(
        `Scenario requires TOTP for user "${user.ref}" but totpSecret is null in the manifest. ` +
        `This means the user was not properly seeded. Run "make seed-test-data-clean" to re-seed.`,
      );
    }
    ctx.totpSecret = user.totpSecret;
  }

  // Backup codes are one-shot: the manifest records only the first code issued, so ask Kratos.
  if (scenario.user.credentials?.includes("lookup_secret")) {
    ctx.backupCode = await getUnusedBackupCode(user.identityId);
  }

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

  const cleanup = scenario.cleanup;
  try {
    // Sparse: index i is phase i. device-complete phases redeem ctx.deviceCode at the token endpoint
    // (RFC 8628 §3.4, RP-polled); a failed poll fails the walk even when nothing reads the tokens.
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

        // defineScenario() rejects this at import; for objects built without it, throw — never warn.
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
            await runPostCheck(name, { page, tokens, manifest, user, deviceCode: ctx.deviceCode });
          });
        }
      });
    }
  } finally {
    // Cleanup runs even when the walk failed, else a re-run sees the mutated identity.
    // Live lane: no admin API — restore through the identity's own settings flow
    // (framework/restore.ts), which is what lets one seed serve a whole matrix run.
    const cleanups = cleanup === undefined ? [] : Array.isArray(cleanup) ? cleanup : [cleanup];
    for (const kind of cleanups) {
      try {
        if (lane === "live") {
          await restoreViaSelfService(page, user, kind, ctx, seededPassword);
        } else if (kind === "remove-totp") {
          // No session left on the page (the walk died early): unlink admin-side instead of leaving the seed dirty.
          const unlinked = await removeTotpViaPublicApi(page, ctx.totpSecret ?? user.totpSecret);
          if (!unlinked && user.identityId) await deleteIdentityCredentialType(user.identityId, "totp");
        } else if (kind === "remove-2fa") {
          // Admin-side and unconditional: a walk that died at the passkey step has no AAL2 session.
          if (!user.identityId) {
            throw new Error(`cleanup "remove-2fa": no identityId for user "${user.ref}"`);
          }
          await deleteIdentityCredentialType(user.identityId, "webauthn");
          await deleteIdentityCredentialType(user.identityId, "totp");
        } else if (kind === "remove-oidc") {
          if (!user.identityId) {
            throw new Error(`cleanup "remove-oidc": no identityId for user "${user.ref}"`);
          }
          await deleteIdentityCredentialType(user.identityId, "oidc");
        } else if (kind === "remove-backup-codes") {
          if (!user.identityId) {
            throw new Error(`cleanup "remove-backup-codes": no identityId for user "${user.ref}"`);
          }
          await deleteIdentityCredentialType(user.identityId, "lookup_secret");
        } else if (kind === "restore-password") {
          // returning-mfa is shared by login, error and session; later specs need the seeded password.
          if (seededPassword && user.identityId) {
            await setIdentityPassword(user.identityId, seededPassword);
          }
        }
      } catch (err) {
        // Never mask the original failure; a skipped cleanup breaks every rerun until a reseed.
        console.warn(
          `Cleanup "${kind}" for "${scenario.id}" failed (non-fatal): ${err} — ` +
          `the user's state is now ahead of the manifest, so the next run of this scenario will likely fail until a reseed`,
        );
      }
    }
  }
}
