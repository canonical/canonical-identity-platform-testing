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
import { HYDRA_PUBLIC_URL } from "../helpers/config";
import { getRpClient } from "../helpers/oidc";
import type { OIDCTokens } from "../helpers/oidc";
import type { Manifest } from "../seeder/manifest-schema";
import type { PostCheckName } from "./scenario-types";

export interface PostCheckArgs {
  page: Page;
  tokens: OIDCTokens;
  manifest: Manifest;
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
  const code = new URL(page.url()).searchParams.get("code");
  if (!code) {
    throw new Error(
      'postCheck "code-replay-revokes-family": current URL carries no ?code= — ' +
      "the check must run on a scenario that ends on the (replayed) RP callback.",
    );
  }

  // Re-exchange the already-redeemed code.
  const exchange = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: rp.redirectUri,
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

const POST_CHECKS: Record<PostCheckName, (args: PostCheckArgs) => Promise<void>> = {
  "code-replay-revokes-family": codeReplayRevokesFamily,
};

export async function runPostCheck(name: PostCheckName, args: PostCheckArgs): Promise<void> {
  await POST_CHECKS[name](args);
}
