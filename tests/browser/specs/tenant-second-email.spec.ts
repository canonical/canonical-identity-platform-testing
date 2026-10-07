// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** PD-14 (login-ui#990), pinned: the tenant of a login is recorded for the login request when an
 *  email is entered, and whoever then signs in for that request gets that record instead of their
 *  own tenant (canonical/identity-platform-login-ui@cff4faf5 pkg/tenants/resolver.go:137-140,
 *  internal/cookies/cookies.go:61-68, pkg/kratos/handlers.go:286-289). Two identities in one walk,
 *  so hand-written. When login-ui resolves the tenant for the user who signs in, both tests fail:
 *  read the expected tenant from `user` instead of `entered` then.
 *
 *  The record reaches the tokens because nothing on this plane checks membership after login-ui:
 *  Kratos has no login webhook to tenant-service (canonical/tenant-service@cc6ae33
 *  pkg/webhooks/service.go:198-246) and hook-service is given no tenant-service address
 *  (canonical/hook-service@10292af5 cmd/serve.go:111-129). If either is wired, the first test fails
 *  for that reason and not for a login-ui fix. */

import { expect, test } from "../framework/test";
import { readManifest, findUserByRef } from "../framework/manifest";
import { activeConfig, isLiveLane, isMfaEnforced, isServiceInProfile, localUsersEnabled } from "../helpers/config";
import { readClaim } from "../helpers/jwt";
import { enterEmail, enterPassword } from "../helpers/login";
import { reopenLoginRequest } from "../helpers/navigation";
import { assertPageState } from "../helpers/page-state";
import { expectOIDCFlowComplete, startOIDCFlow } from "../helpers/oidc";
import { submitTotpCode } from "../helpers/totp";

test.describe("second email for one login request", () => {
  test.beforeEach(() => {
    test.skip(isLiveLane(), "Internal-only spec in live lane");
    // The wording is what scripts/skip-allowlist.mjs recognises as a capability gate.
    test.skip(
      !activeConfig().multi_tenancy_enabled,
      "requires multi-tenancy but the active deployment does not enable it",
    );
    test.skip(
      !localUsersEnabled(),
      "requires local users but the active deployment does not enable password identities",
    );
    test.skip(
      !isMfaEnforced() || !(activeConfig().methods_2fa ?? []).includes("totp"),
      "requires totp 2FA but the active deployment does not enforce it",
    );
    test.skip(
      !isServiceInProfile("hook-service"),
      "requires hook-service but the active deployment does not run it (tenant_id's only writer)",
    );
  });

  for (const [first, second] of [
    // The second user has no tenant and is given the first email's.
    ["single-tenant-user", "zero-tenant-user"],
    // The second user has a tenant and is given the first email's "none".
    ["zero-tenant-user", "single-tenant-user"],
  ]) {
    test(`PD-14: ${second} signs in after the email of ${first} was entered`, async ({ page }) => {
      const manifest = readManifest();
      const entered = findUserByRef(manifest, first);
      const user = findUserByRef(manifest, second);
      // Pinned: the tenant of the email entered first, not the one of the user who signs in.
      const tenantRef = entered.tenantRefs?.[0];
      expect(tenantRef, "the two users differ in tenant, or the walk shows nothing").not.toBe(
        user.tenantRefs?.[0],
      );
      const expected = tenantRef ? manifest.tenants.find((t) => t.ref === tenantRef)?.id : undefined;
      if (tenantRef && !expected) {
        throw new Error(`no seeded tenant "${tenantRef}" in the manifest`);
      }

      await startOIDCFlow(page);
      await enterEmail(page, entered.email);
      await assertPageState(page, "login-password");

      // No credential was given for the first email: the request is opened again for another one.
      await reopenLoginRequest(page);
      await enterEmail(page, user.email);
      await enterPassword(page, user.password as string);
      await submitTotpCode(page, user.totpSecret as string);

      const tokens = await expectOIDCFlowComplete(page);
      expect(readClaim(tokens.idTokenClaims, "sub"), "the tokens are the second user's").toBe(user.identityId);
      for (const [label, claims] of [
        ["id_token", tokens.idTokenClaims],
        ["access_token", tokens.accessTokenClaims],
      ] as const) {
        if (!claims) continue;
        if (expected) {
          expect(readClaim(claims, "tenant_id"), `${label} tenant_id`).toBe(expected);
        } else {
          expect(readClaim(claims, "tenant_id"), `${label} carries no tenant_id`).toBeUndefined();
        }
      }
    });
  }
});
