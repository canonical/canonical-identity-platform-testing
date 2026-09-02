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
  /** The walk's RFC 8628 device_code, when the scenario ran the device
   *  grant — replay checks redeem it a second time. */
  deviceCode?: string;
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
/**
 * RFC 8628 inherits RFC 6749 §10.5: a device_code is single-use. The happy
 * walk's runner poll already redeemed it, so a second redemption at the token
 * endpoint must answer invalid_grant — otherwise anyone holding a spent
 * device_code could mint fresh token families forever (observed rejection
 * 2026-08-31: HTTP 400 invalid_grant "… not_found").
 */
async function deviceCodeReplayRejected({ page, manifest, deviceCode }: PostCheckArgs): Promise<void> {
  if (!deviceCode) {
    throw new Error("device-code-replay-rejected: the walk recorded no device_code — declare it on a device-flow scenario");
  }
  const rp = getRpClient(manifest);
  if (!rp) {
    throw new Error("device-code-replay-rejected: no RP client in the manifest");
  }
  const res = await page.request.post(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    form: {
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    },
  });
  expect(res.status(), "replayed device_code must be rejected").toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error, "replayed device_code must answer invalid_grant").toBe("invalid_grant");
}
/**
 * The register-without-verification premise, pinned server-side: with the
 * verification flow OFF, the freshly registered identity's address must be
 * UNVERIFIED — otherwise "the unverified account signs in" is vacuous
 * (verified 2026-09-01 on mx-l1m0v0wnp0t1h0u1aj). Looks the identity up by
 * the scenario user's EMAIL: registration deleted and re-created it, so the
 * manifest's identityId is stale by design.
 */
async function registeredAddressUnverified({ user }: PostCheckArgs): Promise<void> {
  const res = await fetch(
    `${KRATOS_ADMIN_URL}/admin/identities?credentials_identifier=${encodeURIComponent(user.email)}`,
  );
  expect(res.ok, `admin lookup of ${user.email} must succeed (${res.status})`).toBe(true);
  const identities = (await res.json()) as Array<{
    verifiable_addresses?: Array<{ value: string; verified: boolean }>;
  }>;
  expect(identities.length, `registration must have created an identity for ${user.email}`).toBeGreaterThan(0);
  for (const address of identities[0].verifiable_addresses ?? []) {
    expect(address.verified, `address ${address.value} must be unverified with the verification flow off`).toBe(false);
  }
}
/**
 * Account linking's whole point, pinned on the tokens: the sign-in that rode
 * the LINKED provider must yield the SEEDED identity — sub equals the
 * manifest identityId — not a freshly minted doppelgänger. (Login-time
 * linking never recreates the identity, so the manifest id is current.)
 */
async function linkedIdentityTokens({ tokens, user }: PostCheckArgs): Promise<void> {
  expect(
    tokens.idTokenClaims.sub,
    "the provider sign-in must land the linked (seeded) identity",
  ).toBe(user.identityId);
}

const POST_CHECKS: Record<PostCheckName, (args: PostCheckArgs) => Promise<void>> = {
  "code-replay-revokes-family": codeReplayRevokesFamily,
  "backup-codes-deactivated": backupCodesDeactivated,
  "device-code-replay-rejected": deviceCodeReplayRejected,
  "registered-address-unverified": registeredAddressUnverified,
  "linked-identity-tokens": linkedIdentityTokens,
};

export async function runPostCheck(name: PostCheckName, args: PostCheckArgs): Promise<void> {
  await POST_CHECKS[name](args);
}
