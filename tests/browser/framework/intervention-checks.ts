// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Executable half of `Scenario.postChecks`: API-side assertions against the tokens the relying party received, run after the walk. */

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
  user: ManifestUser;
  /** Device grant only; replay checks redeem it a second time. */
  deviceCode?: string;
}

/** RFC 6749 §10.5: replaying the redeemed code at the token endpoint must answer invalid_grant and revoke the first exchange's refresh token. */
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

  // redirect_uri must be the callback the authorize request carried, not the manifest's first
  // registered redirect (the consumer may run on another port); a mismatch yields invalid_grant
  // for the wrong reason and the check would pass without testing reuse.
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

/** Deactivation must delete the lookup_secret credential; the UI stops offering the method either way, so only the admin API can tell. Internal lane only. */
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
/** RFC 8628 inherits RFC 6749 §10.5: a spent device_code redeemed again must answer invalid_grant. */
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
/** With verification OFF the registered address must be unverified; looked up by email because registration re-created the identity (manifest identityId is stale). */
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
/** Sign-in via the linked provider must land the seeded identity: sub equals the manifest identityId. */
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
