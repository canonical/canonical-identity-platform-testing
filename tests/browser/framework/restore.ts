// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Self-service cleanup: restore a seeded identity through Kratos's public
 * settings flow, using the browser's own session — no admin API. This is what
 * lets one seed serve every row of a matrix run against a deployment whose
 * admin plane is not reachable (the live lane).
 *
 * The walk may have died anywhere, so the session is never assumed: the
 * identity is signed in again through the OIDC flow (password, then whatever
 * second factor the deployment demands, using the secret the walk captured or
 * the seed's), settings are edited, and the flow is re-read to prove the
 * credential is gone. A restore that cannot prove itself throws.
 */

import { expect, type Page } from "@playwright/test";
import type { ManifestUser } from "../seeder/manifest-schema";
import type { ActionContext } from "./transitions";
import type { CleanupKind } from "./scenario-types";
import { KRATOS_PUBLIC_URL, LOGIN_UI_URL } from "../helpers/config";
import { detectPageState } from "../helpers/page-state";
import { startOIDCFlow } from "../helpers/oidc";
import { enterEmail, enterPassword } from "../helpers/login";
import { completeTotpSetup, generateTotpCode, submitTotpCode } from "../helpers/totp";
import { clickDexLoginButton, loginWithDex } from "../helpers/dex";
import { selectTenant } from "../helpers/navigation";

interface FlowNode {
  type: string;
  group: string;
  attributes: { name?: string; value?: unknown; [k: string]: unknown };
}
interface SettingsFlow {
  id: string;
  ui: { nodes: FlowNode[] };
}

type FlowResult = { status: "ok"; flow: SettingsFlow } | { status: "unauthenticated" } | { status: "aal2" };

/** GET /self-service/settings/browser via the page's cookie jar. Kratos answers
 *  303 + ?flow= (or a redirect to login for a missing/insufficient session); the
 *  login-ui BFF answers 200 with the flow body. */
async function settingsFlow(page: Page): Promise<FlowResult> {
  const res = await page.request.get(`${KRATOS_PUBLIC_URL}/self-service/settings/browser`, {
    maxRedirects: 0,
    headers: { Accept: "application/json" },
  });
  const location = res.headers()["location"];
  if (res.status() === 401) return { status: "unauthenticated" };
  if (res.status() === 403 || (location && /aal=aal2/.test(location))) return { status: "aal2" };
  if (location && /\/login/.test(location)) return { status: "unauthenticated" };

  let flowId = location ? new URL(location, LOGIN_UI_URL).searchParams.get("flow") : null;
  if (!flowId && res.ok()) {
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    flowId = body?.id ?? null;
  }
  if (!flowId) throw new Error(`restore: settings flow not created (HTTP ${res.status()})`);

  const flowRes = await page.request.get(`${KRATOS_PUBLIC_URL}/self-service/settings/flows?id=${flowId}`);
  if (flowRes.status() === 401) return { status: "unauthenticated" };
  if (flowRes.status() === 403) return { status: "aal2" };
  if (!flowRes.ok()) throw new Error(`restore: settings flow ${flowId} unreadable (HTTP ${flowRes.status()})`);
  return { status: "ok", flow: (await flowRes.json()) as SettingsFlow };
}

function nodes(flow: SettingsFlow, name: string, group?: string): FlowNode[] {
  return flow.ui.nodes.filter((n) => n.attributes.name === name && (group === undefined || n.group === group));
}

function csrf(flow: SettingsFlow): string {
  const token = nodes(flow, "csrf_token")[0]?.attributes.value;
  if (typeof token !== "string") throw new Error("restore: settings flow carries no csrf_token");
  return token;
}

async function submit(page: Page, flow: SettingsFlow, data: Record<string, unknown>): Promise<void> {
  const res = await page.request.post(`${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flow.id}`, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    data: { csrf_token: csrf(flow), ...data },
  });
  if (!res.ok()) throw new Error(`restore: settings submit ${JSON.stringify(data.method)} failed: ${res.status()} ${await res.text()}`);
}

/** Sign the identity in through the OIDC flow, driving whatever the deployment
 *  asks for. Enrolment pages reached here (forced TOTP/passkey set-up) are
 *  completed so the walk ends at the callback; the caller unlinks afterwards. */
/** Poll until the page shows a known state other than `previous` (renders and
 *  navigations both pass through "unknown"). */
async function nextState(page: Page, previous: string | null): Promise<string> {
  let state = "unknown";
  await expect
    .poll(async () => (state = (await detectPageState(page)).type), { timeout: 15_000 })
    .not.toMatch(previous === null ? /^unknown$/ : new RegExp(`^(unknown|${previous})$`));
  return state;
}

async function signIn(page: Page, user: ManifestUser, ctx: ActionContext): Promise<void> {
  await page.context().clearCookies();
  await startOIDCFlow(page);
  let state = await nextState(page, null);
  for (let step = 0; step < 8; step++) {
    switch (state) {
      case "oidc-callback":
        return;
      case "login-email":
        await enterEmail(page, user.email);
        break;
      case "tenant-selection": {
        // Same tenant the walk selected; dex identities are offered their provider after it.
        if (!ctx.selectTenant) throw new Error(`restore: "${user.ref}" reached tenant selection but the scenario names no tenant`);
        await selectTenant(page, ctx.selectTenant);
        if (user.credentials.some((c) => c.startsWith("oidc/dex"))) await clickDexLoginButton(page);
        break;
      }
      case "login-password":
        if (!user.password) throw new Error(`restore: user "${user.ref}" has no password to sign in with`);
        await enterPassword(page, user.password);
        break;
      case "login-totp-verify": {
        const secret = ctx.totpSecret ?? user.totpSecret;
        if (!secret) throw new Error(`restore: TOTP demanded for "${user.ref}" but no secret is known`);
        await submitTotpCode(page, secret, Date.now());
        break;
      }
      case "login-webauthn-verify":
        await ctx.webauthn?.setup();
        await page.locator('button[name="webauthn_login_trigger"]').click();
        break;
      case "provider:dex:login":
        await loginWithDex(page, user.dexEmail ?? user.email);
        break;
      case "setup-secure":
        ctx.totpSecret = await completeTotpSetup(page);
        break;
      case "setup-passkey": {
        await ctx.webauthn?.setup();
        await page.locator('[name="webauthn_register_displayname"]').fill("Restore key");
        await page.getByRole("button", { name: /add security key/i }).click();
        break;
      }
      case "setup-complete":
        break;
      default:
        throw new Error(`restore: cannot sign "${user.ref}" in from state "${state}" (${page.url()})`);
    }
    // Each step navigates: wait for the page to leave the state just acted on
    // before detecting again, else the next fill lands on a detaching field.
    state = await nextState(page, state);
  }
  throw new Error(`restore: sign-in for "${user.ref}" did not reach the callback`);
}

/** A settings flow for a session Kratos accepts, signing in if needed. */
async function authenticatedFlow(page: Page, user: ManifestUser, ctx: ActionContext): Promise<SettingsFlow> {
  let result = await settingsFlow(page);
  if (result.status !== "ok") {
    await signIn(page, user, ctx);
    result = await settingsFlow(page);
  }
  if (result.status !== "ok") throw new Error(`restore: no usable session for "${user.ref}" after sign-in (${result.status})`);
  return result.flow;
}

async function unlinkTotp(page: Page, user: ManifestUser, ctx: ActionContext, flow: SettingsFlow): Promise<void> {
  const secret = ctx.totpSecret ?? user.totpSecret;
  if (!secret) throw new Error(`restore: TOTP is enrolled on "${user.ref}" but no secret is known to unlink it`);
  await submit(page, flow, { method: "totp", totp_code: await generateTotpCode(secret), totp_unlink: true });
}

/**
 * Restore one cleanup kind through self-service and prove it. Password
 * restoration also updates `user.password` in memory so later scenarios in the
 * same run sign in with the seed's value.
 */
export async function restoreViaSelfService(
  page: Page,
  user: ManifestUser,
  kind: CleanupKind,
  ctx: ActionContext,
  seededPassword: string | null | undefined,
): Promise<void> {
  let flow = await authenticatedFlow(page, user, ctx);

  if (kind === "remove-2fa" || kind === "remove-totp") {
    if (kind === "remove-2fa") {
      for (const n of nodes(flow, "webauthn_remove")) {
        await submit(page, flow, { method: "webauthn", webauthn_remove: n.attributes.value });
        flow = await authenticatedFlow(page, user, ctx);
      }
    }
    if (nodes(flow, "totp_unlink").length > 0) {
      await unlinkTotp(page, user, ctx, flow);
    }
    flow = await authenticatedFlow(page, user, ctx);
    expect(nodes(flow, "totp_unlink"), `restore: TOTP still enrolled on "${user.ref}"`).toHaveLength(0);
    if (kind === "remove-2fa") {
      expect(nodes(flow, "webauthn_remove"), `restore: a security key is still enrolled on "${user.ref}"`).toHaveLength(0);
    }
    return;
  }

  if (kind === "remove-oidc") {
    for (const n of nodes(flow, "unlink", "oidc")) {
      await submit(page, flow, { method: "oidc", unlink: n.attributes.value });
      flow = await authenticatedFlow(page, user, ctx);
    }
    expect(nodes(flow, "unlink", "oidc"), `restore: an OIDC credential is still linked on "${user.ref}"`).toHaveLength(0);
    return;
  }

  if (kind === "remove-backup-codes") {
    if (nodes(flow, "lookup_secret_disable").length > 0) {
      await submit(page, flow, { method: "lookup_secret", lookup_secret_disable: true });
      flow = await authenticatedFlow(page, user, ctx);
    }
    expect(nodes(flow, "lookup_secret_disable"), `restore: backup codes still enrolled on "${user.ref}"`).toHaveLength(0);
    return;
  }

  if (kind === "restore-password") {
    if (!seededPassword) throw new Error(`restore: no seeded password recorded for "${user.ref}"`);
    if (user.password === seededPassword) return;
    await submit(page, flow, { method: "password", password: seededPassword });
    user.password = seededPassword;
    return;
  }
}
