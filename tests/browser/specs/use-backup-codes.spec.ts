// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Backup-code enrolment during TOTP setup, then login with a backup code instead of TOTP. */

import { test, expect, instrumentContext } from "../framework/test";
import { createIdentity, deleteIdentity, deleteIdentitySessions, markVerified } from "../helpers/kratos";
import { startOIDCFlow, expectOIDCFlowComplete } from "../helpers/oidc";
import { loginWithPassword } from "../helpers/login";
import { completeTotpSetup } from "../helpers/totp";
import { clickButton, verifyBackupCode } from "../helpers/backupCode";
import { uniqueEmail } from "../helpers/utils";
import { LOGIN_UI_URL, getExecutionLane, isMfaEnforced, isOidcSequencingEnabledSync, activeConfig } from "../helpers/config";
import { generateTestPassword } from "../helpers/test-credentials";

// LIVE_LANE_INTERNAL_ONLY: Runtime identity lifecycle uses admin APIs.

const PASSWORD = generateTestPassword();

let identityIds: string[] = [];

test.beforeEach(async () => {
  test.skip(
    getExecutionLane() === "live",
    // Wording is load-bearing: scripts/skip-allowlist.mjs recognises "Internal-only spec in live lane".
    "Internal-only spec in live lane: runtime identity lifecycle needs the admin API",
  );
  test.skip(
    !isMfaEnforced(),
    "requires MFA enforcement but profile does not enforce a second factor",
  );
  // Needs totp in methods_2fa and no webauthn sequencing, or the TOTP path never renders.
  const m2 = activeConfig().methods_2fa ?? [];
  test.skip(
    isOidcSequencingEnabledSync() || !m2.includes("totp"),
    "requires totp 2FA but the active deployment steps up to webauthn (sequencing) or lacks the totp method",
  );
  identityIds = [];
});

test.afterEach(async () => {
  if (!identityIds.length) {
    return;
  }
  for (const id of identityIds) {
    await deleteIdentitySessions(id).catch(() => {});
    await deleteIdentity(id).catch(() => {});
  }
});

test("backup recovery code setup and usage", async ({ browser, page }) => {
  const email = uniqueEmail("backup");
  const id = await createIdentity({ email, password: PASSWORD });
  identityIds.push(id);
  // Admin-created identities are unverified; verification-enabled profiles would intercept the login.
  await markVerified(id);

  await startOIDCFlow(page);
  await loginWithPassword(page, email, PASSWORD);
  await completeTotpSetup(page);
  await expectOIDCFlowComplete(page);

  // Go through login-ui (Traefik :80); a relative path would resolve to Kratos :4433.
  await page.goto(`${LOGIN_UI_URL}/ui/setup_backup_codes`);
  await clickButton(page, "Create backup codes");

  const backupCode = await page.locator(".p-list__item").first().textContent();
  if (!backupCode) {
    throw new Error("Backup code not found");
  }

  await page.getByText("I saved the backup codes").click();
  await clickButton(page, "Create backup codes");

  await expect(page.getByText("Account setup complete")).toBeVisible();

  // Fresh context: the current one is already authenticated.
  const newContext = await browser.newContext();
  await instrumentContext(newContext);
  const newPage = await newContext.newPage();

  await startOIDCFlow(newPage);
  await loginWithPassword(newPage, email, PASSWORD);

  await clickButton(newPage, "Use backup code instead");
  await verifyBackupCode(newPage, backupCode);

  await expectOIDCFlowComplete(newPage);

  await newContext.close();
});
