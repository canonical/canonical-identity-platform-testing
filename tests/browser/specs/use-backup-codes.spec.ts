// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Backup recovery code setup and usage — browser E2E test.
 *
 * Ported from login-ui/ui/tests/use-backup-codes.spec.ts.
 * Tests the backup code flow: login → TOTP setup → backup codes →
 * login with backup code instead of TOTP.
 *
 * Works with any profile that includes Kratos + Hydra + login-ui.
 */

import { test, expect } from "@playwright/test";
import { createIdentity, deleteIdentity, deleteIdentitySessions, markVerified } from "../helpers/kratos";
import { startOIDCFlow, expectOIDCFlowComplete } from "../helpers/oidc";
import { loginWithPassword } from "../helpers/login";
import { completeTotpSetup } from "../helpers/totp";
import { clickButton, verifyBackupCode } from "../helpers/backupCode";
import { uniqueEmail } from "../helpers/utils";
import { LOGIN_UI_URL, getExecutionLane, isMfaEnforced, isOidcSequencingEnabledSync, activeConfig } from "../helpers/config";
import { DEFAULT_TEST_PASSWORD } from "../helpers/test-credentials";

// LIVE_LANE_INTERNAL_ONLY: Runtime identity lifecycle uses admin APIs.

const PASSWORD = DEFAULT_TEST_PASSWORD;

let identityIds: string[] = [];

test.beforeEach(async () => {
  test.skip(
    getExecutionLane() === "live",
    // Wording is load-bearing: the justified-skip allow-list recognises
    // "Internal-only spec in live lane" (tests/browser/scripts/skip-allowlist.mjs),
    // and this spec is tier B, so an off-pattern reason fails the row.
    "Internal-only spec in live lane: runtime identity lifecycle needs the admin API",
  );
  // Backup codes are issued as part of TOTP enrolment, which login-ui only
  // forces where MFA is enforced — so this flow does not exist on a no-MFA
  // profile.
  test.skip(
    !isMfaEnforced(),
    "requires MFA enforcement but profile does not enforce a second factor",
  );
  // The flow drives TOTP enrolment specifically: it requires totp in the
  // deployment's 2FA methods, and NOT webauthn sequencing (there the
  // post-1FA step-up is security-key setup, so the TOTP path never renders).
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

test("backup recovery code setup and usage", async ({ browser, context, page }) => {
  const email = uniqueEmail("backup");
  const id = await createIdentity({ email, password: PASSWORD });
  identityIds.push(id);
  // Admin-created identities are unverified; on verification-enabled
  // deployments the post-password login is intercepted by the
  // "Check your email" page instead of proceeding to MFA setup.
  await markVerified(id);

  await startOIDCFlow(page);
  await loginWithPassword(page, email, PASSWORD);
  await completeTotpSetup(page);
  await expectOIDCFlowComplete(page);

  // Navigate to backup codes setup via the login-ui (Traefik on port 80),
  // not the relative path which would resolve to Kratos on port 4433.
  await page.goto(`${LOGIN_UI_URL}/ui/setup_backup_codes`);
  await clickButton(page, "Create backup codes");

  const backupCode = await page.locator(".p-list__item").first().textContent();
  if (!backupCode) {
    throw new Error("Backup code not found");
  }

  await page.getByText("I saved the backup codes").click();
  await clickButton(page, "Create backup codes");

  await expect(page.getByText("Account setup complete")).toBeVisible();

  // Start login in a new context as user is already authenticated within the current context
  const newContext = await browser.newContext();
  const newPage = await newContext.newPage();

  await startOIDCFlow(newPage);
  await loginWithPassword(newPage, email, PASSWORD);

  await clickButton(newPage, "Use backup code instead");
  await verifyBackupCode(newPage, backupCode);

  await expectOIDCFlowComplete(newPage);

  await newContext.close();
});
