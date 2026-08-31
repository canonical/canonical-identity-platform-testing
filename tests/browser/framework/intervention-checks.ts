// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Named API-side post checks — the executable half of `Scenario.postChecks`.
 *
 * These run after the walk (and any final-state interventions), against the
 * tokens the relying party received. Scenarios name a check; the
 * implementation lives here — the same contract as claim assertions, for the
 * same reason: no scenario ever implements an assertion.
 */

import { expect, Page } from "@playwright/test";
import { HYDRA_PUBLIC_URL, KRATOS_ADMIN_URL } from "../helpers/config";
import { getRpClient } from "../helpers/oidc";
import type { OIDCTokens } from "../helpers/oidc";
import type { Manifest, ManifestUser } from "../seeder/manifest-schema";
import type { PostCheckName } from "./scenario-types";

export interface PostCheckArgs {
  page: Page;
  tokens: OIDCTokens;
  manifest: Manifest;
  /** The scenario's seeded user — identity-scoped checks read it. */
  user: ManifestUser;
}

/**
 * RFC 6749 §10.5: an authorization code is single-use, and replaying it MUST
 * revoke the tokens already issued for it.
 *
 * The browser-side replay intervention cannot prove this: the CLI consumer's
 * own state guard rejects a replayed callback URL ("States do not match")
 * before the code ever reaches the token endpoint again — that intervention
 * pins the consumer surface. This check replays the code where single-use is
 * enforced: straight at the token endpoint. The page is still on the replayed
 * callback URL, so the code is read from it.
 *
 * Expected: the re-exchange answers invalid_grant, and the refresh token from
 * the LEGITIMATE first exchange is dead afterwards (family revocation).
 */
async function codeReplayRevokesFamily({ page, tokens, manifest }: PostCheckArgs): Promise<void> {
  const rp = getRpClient(manifest);
  if (!rp) {
    throw new Error(
      'postCheck "code-replay-revokes-family": manifest carries no RP client credentials — re-seed.',
    );
  }
  const callback = new URL(page.url());
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new Error(
      'postCheck "code-replay-revokes-family": current URL carries no ?code= — ' +
      "the check must run on a scenario that ends on the (replayed) RP callback.",
    );
  }

  // Re-exchange the already-redeemed code. `redirect_uri` MUST be the one the
  // authorize request carried, which is this very callback URL — the manifest's
  // first registered redirect is NOT it whenever the consumer runs on another
  // port (the seeder registers 4446 and 4447; the charmed and urls lanes use
  // 4447). A mismatch there makes hydra answer `invalid_grant` for the wrong
  // reason, and this check would go green without ever testing code reuse.
  const exchange = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${callback.origin}${callback.pathname}`,
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
    },
  });
  expect(exchange.status(), "replayed code must be rejected").toBeGreaterThanOrEqual(400);
  const exchangeBody = (await exchange.json()) as { error?: string };
  expect(exchangeBody.error, "replayed code must answer invalid_grant").toBe("invalid_grant");

  // Family revocation: the refresh token from the legitimate exchange is dead.
  if (!tokens.refreshToken) {
    throw new Error(
      'postCheck "code-replay-revokes-family": no refresh token was captured from the callback ' +
      'page. The RP client must request the "offline_access" scope for the revocation half.',
    );
  }
  const refresh = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    form: {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
    },
  });
  expect(
    refresh.status(),
    "refresh token must be dead after the code replay (token-family revocation)",
  ).toBeGreaterThanOrEqual(400);
  const refreshBody = (await refresh.json()) as { error?: string };
  expect(refreshBody.error, "revoked refresh token must answer invalid_grant").toBe("invalid_grant");
}

/**
 * Deactivating backup codes must remove the lookup_secret credential, not
 * merely hide the codes. The browser walk cannot prove this: with no
 * lookup_secret the login UI stops OFFERING the backup-code method, so
 * "deactivated" and "button never clicked" render the same reachable pages —
 * the only honest witness is the credential's absence on the identity
 * (observed 2026-08-31: the UI deactivation deletes the credential record
 * outright). Admin API ⇒ internal lane only.
 */
async function backupCodesDeactivated({ user }: PostCheckArgs): Promise<void> {
  const res = await fetch(
    `${KRATOS_ADMIN_URL}/admin/identities/${user.identityId}?include_credential=lookup_secret`,
  );
  expect(res.ok, `admin read of identity ${user.identityId} must succeed (${res.status})`).toBe(true);
  const identity = (await res.json()) as { credentials?: Record<string, unknown> };
  expect(
    identity.credentials?.lookup_secret,
    "deactivation must delete the lookup_secret credential from the identity",
  ).toBeUndefined();
}

const POST_CHECKS: Record<PostCheckName, (args: PostCheckArgs) => Promise<void>> = {
  "code-replay-revokes-family": codeReplayRevokesFamily,
  "backup-codes-deactivated": backupCodesDeactivated,
};

export async function runPostCheck(name: PostCheckName, args: PostCheckArgs): Promise<void> {
  await POST_CHECKS[name](args);
}
