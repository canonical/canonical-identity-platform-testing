// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The authenticated self-service hub (/ui/manage_details: Password, Backup codes, Authenticator).
 * Every archetype is a zero-tenant user, so nothing here declares multiTenancy; live-lane compatible unless a phase needs the admin API.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

/** Each traversal authenticates with the CURRENT `user.password`, which is what makes the change/restore phases assertions. */
const LOGIN_WALK = [
  "login-email",
  "login-password",
  "login-totp-verify",
  "oidc-callback",
] as const;

export const settingsScenarios = defineScenarioSuite({
  name: "settings",
  defaultLanes: ["live", "internal"],
  scenarios: [
    defineScenario({
      id: "settings-change-password",
      description:
        "Change the password from the settings hub, sign in with the new one, restore the seeded one, sign in again",
      requires: {
        mfaEnabled: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp"],
      },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        { name: "sign in with the seeded password", expectedPath: [...LOGIN_WALK] },
        {
          name: "reject a weak password, then change to a new one",
          expectedPath: ["manage-details", "reset-password", "reset-password"],
        },
        {
          name: "the new password authenticates",
          freshSession: true,
          expectedPath: [...LOGIN_WALK],
        },
        {
          name: "restore the seeded password",
          expectedPath: ["manage-details", "reset-password", "reset-password"],
        },
        {
          name: "the restored password authenticates",
          freshSession: true,
          expectedPath: [...LOGIN_WALK],
        },
      ],
      cleanup: "restore-password",
    }),

    // `credentials` omits lookup_secret on purpose: that key makes the runner resolve a code via the
    // admin API before any phase, and this scenario must run on the live lane with settings-created codes.
    defineScenario({
      id: "settings-backup-codes-regenerate",
      description:
        "Create backup codes from the settings hub and sign in with one of them",
      requires: {
        mfaEnabled: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
        // Prompt-terminal variant, for a login-ui that prompts after every backup-code sign-in (none known
        // today, see known-coverage-gaps.json); backup-code-reuse-rejected's burn phase is the callback-terminal one.
        backupCodePromptOnUse: true,
      },
      user: { ref: "backup-code-user-2", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        { name: "sign in", expectedPath: [...LOGIN_WALK] },
        {
          name: "create fresh backup codes",
          expectedPath: ["manage-details", "setup-backup-codes", "setup-backup-codes"],
        },
        {
          // Reaching the prompt is the assertion; on login-ui ≥ v0.27 "I don't need new codes" lands on manage_details, so no further hop.
          name: "a created code signs in",
          freshSession: true,
          expectedPath: [
            "login-email",
            "login-password",
            "login-totp-verify",
            "login-backup-code-verify",
            "backup-code-regenerate",
          ],
        },
      ],
    }),

    // The UI cannot falsify deactivation (without lookup_secret the method is simply not offered), so the
    // backup-codes-deactivated post check is the witness (admin API ⇒ internal lane).
    defineScenario({
      id: "settings-backup-codes-deactivate",
      description:
        "Create backup codes from the settings hub, deactivate them, and prove the lookup_secret credential is removed",
      requires: {
        mfaEnabled: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
      },
      user: { ref: "backup-code-user-3", credentials: ["password", "totp"], totpConfigured: true },
      lanes: ["internal"],
      phases: [
        { name: "sign in", expectedPath: [...LOGIN_WALK] },
        {
          name: "create backup codes",
          expectedPath: ["manage-details", "setup-backup-codes", "setup-backup-codes"],
        },
        {
          // ctx.backupCode is set, so the self-pair action takes its deactivate branch.
          name: "deactivate them",
          expectedPath: ["manage-details", "setup-backup-codes", "setup-backup-codes"],
        },
        {
          name: "login still works, on TOTP alone",
          freshSession: true,
          expectedPath: [...LOGIN_WALK],
        },
      ],
      postChecks: ["backup-codes-deactivated"],
    }),

    // Own archetype: the walk rotates and burns codes and must never consume another scenario's precondition.
    defineScenario({
      id: "backup-code-reuse-rejected",
      description:
        "A backup code that already signed in once is rejected on replay, visibly",
      requires: {
        mfaEnabled: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
        // The burn phase ends at the callback, which only exists where the regeneration prompt is not a terminal.
        backupCodePromptOnUse: false,
      },
      user: { ref: "backup-code-user-4", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        { name: "sign in", expectedPath: [...LOGIN_WALK] },
        {
          name: "create backup codes",
          expectedPath: ["manage-details", "setup-backup-codes", "setup-backup-codes"],
        },
        {
          // 12 fresh codes, spend 1: the regeneration prompt (≤3 unused) cannot intercept the walk.
          name: "a created code signs in, once",
          freshSession: true,
          expectedPath: [
            "login-email",
            "login-password",
            "login-totp-verify",
            "login-backup-code-verify",
            "oidc-callback",
          ],
        },
        {
          name: "the spent code is rejected on replay",
          freshSession: true,
          expectError: true,
          expectedPath: [
            "login-email",
            "login-password",
            "login-totp-verify",
            "login-backup-code-verify",
            "login-backup-code-verify",
          ],
        },
      ],
      // The walk creates codes on an identity seeded without them; a second pass must find none.
      cleanup: "remove-backup-codes",
    }),

    // The archetype is seeded in the post-unlink state (backup codes, no totp) and the walk restores it; the final
    // phase stops at backup-code verify because walking further would re-enrol. lookup_secret ⇒ admin API ⇒
    // internal lane. remove-2fa is crash insurance for a walk that dies between re-enrolment and unlink.
    defineScenario({
      id: "settings-totp-unlink",
      description:
        "Backup-code login forces TOTP re-enrolment; unlinking from settings restores the codes-only identity",
      requires: {
        mfaEnabled: true,
        mfaEnforced: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
      },
      user: { ref: "totp-unlink-user", credentials: ["password", "lookup_secret"], totpConfigured: false },
      lanes: ["internal"],
      phases: [
        {
          name: "backup code signs in and MFA enforcement walks into TOTP re-enrolment",
          expectedPath: [
            "login-email",
            "login-password",
            "login-backup-code-verify",
            "setup-secure",
            "setup-complete",
            "oidc-callback",
          ],
        },
        {
          name: "the re-enrolled TOTP authenticates",
          freshSession: true,
          expectedPath: [...LOGIN_WALK],
        },
        {
          name: "unlink the authenticator from settings",
          expectedPath: ["manage-details", "setup-secure-linked", "setup-secure"],
        },
        {
          name: "password lands on backup-code verify again — the unlink stuck",
          freshSession: true,
          expectedPath: ["login-email", "login-password", "login-backup-code-verify"],
        },
      ],
      cleanup: "remove-2fa",
    }),
  ],
});
