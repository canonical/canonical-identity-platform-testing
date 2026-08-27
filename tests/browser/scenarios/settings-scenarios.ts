// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Settings scenario suite — the authenticated self-service hub
 * (/ui/manage_details and its nav: Password, Backup codes, Authenticator).
 *
 * Surveyed live on iam.orange.canonical.com (2026-08-27). Every surface reuses
 * a URL an existing page state already owns, so these scenarios add
 * transitions, not states. Both scenarios are live-lane compatible: they need
 * a seeded user and the public login-ui, never an admin API.
 *
 * Deliberately absent:
 *  - TOTP unlink/relink (manage_secure): the linked and enrolment shapes share
 *    /ui/setup_secure, so expressing unlink → re-enrol needs the state split
 *    into DOM-distinguished states first. Staged; see docs/testing-spec.md §10.
 *  - The unauthenticated bounce (manage_details without a session → login):
 *    its first hop would need a second "start → login-email" entry, and the
 *    transition table holds one action per pair.
 *  - manage_details itself is a disabled email textbox — nothing to drive.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

/** The standard password+TOTP login walk, shared by every phase that has to
 *  prove a credential end-to-end. Each traversal authenticates with the
 *  CURRENT `user.password`, which is exactly what makes the change/restore
 *  phases below assertions rather than ceremony. */
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
    // ── Password change, proven and self-restoring ─────────────────────────
    // The walk is its own cleanup: change → prove by fresh login → restore →
    // prove again. A completed run leaves returning-mfa exactly as seeded; an
    // aborted one is caught by the restore-password cleanup (admin API) on
    // lanes that have it, and by the next reseed elsewhere. The weak-password
    // rejection is asserted inside the change transition — same state pair,
    // one action.
    defineScenario({
      id: "settings-change-password",
      description:
        "Change the password from the settings hub, sign in with the new one, restore the seeded one, sign in again",
      requires: {
        mfaEnabled: true,
        multiTenancy: false,
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

    // ── Backup codes: create on the settings page, sign in with one ────────
    // The only honest assertion about this page is that the codes it hands out
    // WORK: the create transition harvests one into ctx.backupCode and the
    // final phase authenticates with it (burning it — which is why the runner
    // never trusts a manifest's seeded code, and why rotating this user's
    // codes here is safe for every other scenario).
    //
    // `credentials` deliberately omits lookup_secret: that key makes the
    // runner resolve an unused code via the ADMIN API before any phase runs,
    // and this scenario must both run on the live lane and prove the
    // settings-created codes rather than pre-seeded ones.
    defineScenario({
      id: "settings-backup-codes-regenerate",
      description:
        "Create backup codes from the settings hub and sign in with one of them",
      requires: {
        mfaEnabled: true,
        multiTenancy: false,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
      },
      user: { ref: "backup-code-user-2", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        { name: "sign in", expectedPath: [...LOGIN_WALK] },
        {
          name: "create fresh backup codes",
          expectedPath: ["manage-details", "setup-backup-codes", "setup-backup-codes"],
        },
        {
          // Ends at the regenerate prompt: reaching it IS the assertion — the
          // page only renders after the backup code authenticated ("Backup
          // code sign in successful"). The prompt's "I don't need new codes"
          // resumption to the OIDC callback stays the session suite's contract
          // (`session-scenarios`): on iam.orange (login-ui ≥ v0.27) that click
          // landed on manage_details with the login challenge dropped, so it
          // is not a hop this scenario can assert everywhere yet.
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
  ],
});
