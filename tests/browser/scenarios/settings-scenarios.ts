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
        // The prompt-terminal variant of the settings-created-codes proof:
        // only on targets where the regeneration prompt renders after every
        // backup-code sign-in (iam.orange). The callback-terminal variant is
        // backup-code-reuse-rejected's burn phase.
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

    // ── Backup codes: deactivate, and prove the credential is gone ─────────
    // The UI walk alone cannot falsify deactivation: with no lookup_secret
    // credential the login UI stops OFFERING the backup-code method, so the
    // post-deactivation login walk looks identical whether the deactivate
    // stuck or not. The dialog + collapsed-shape assertions live in the
    // deactivate pass of the "setup-backup-codes → setup-backup-codes"
    // action; the server-side witness is the "backup-codes-deactivated" post
    // check (admin API ⇒ internal lane). The archetype is seeded WITHOUT
    // lookup_secret, so create → deactivate leaves it exactly as seeded.
    defineScenario({
      id: "settings-backup-codes-deactivate",
      description:
        "Create backup codes from the settings hub, deactivate them, and prove the lookup_secret credential is removed",
      requires: {
        mfaEnabled: true,
        multiTenancy: false,
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
          // Second traversal of the self-pair: ctx.backupCode is set, so the
          // action takes its deactivate branch (confirmation dialog, then the
          // page collapses to the no-codes shape).
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

    // ── Backup codes are single-use ────────────────────────────────────────
    // Create codes, spend one on a real sign-in, then replay it: Kratos must
    // reject the spent code visibly ("This backup code was already used") and
    // keep the flow where it is — the expectError self-transition is the
    // assertion. Fully public-surface, so it runs on the live lane too. Own
    // archetype (seeded without lookup_secret): the walk rotates and burns
    // codes, which must never consume another scenario's precondition.
    defineScenario({
      id: "backup-code-reuse-rejected",
      description:
        "A backup code that already signed in once is rejected on replay, visibly",
      requires: {
        mfaEnabled: true,
        multiTenancy: false,
        localUsersEnabled: true,
        secondFactorMethods: ["totp", "backup_codes"],
        // The burn phase ends at the callback, which only exists where the
        // regeneration prompt does NOT intercept every backup-code sign-in
        // (the v0.28.0 workload; on iam.orange the prompt is a terminal and
        // settings-backup-codes-regenerate is that target's variant).
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
          // 12 fresh codes, spend 1 → 11 left, so the regeneration prompt
          // (≤3 unused) cannot intercept the walk to the callback.
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
    }),

    // ── TOTP unlink: the authenticator page's other shape ──────────────────
    // The archetype is seeded in the post-unlink product state (backup codes,
    // no totp credential), and the walk both proves that state's login
    // behaviour and RESTORES it:
    //  1. password lands directly on backup-code verify (the lookup-only
    //     shape), and enforced MFA then walks the accepted code straight into
    //     TOTP re-enrolment — not the callback;
    //  2. the re-enrolled secret (ctx.totpSecret) now authenticates a fresh
    //     session;
    //  3. settings → Authenticator renders the linked shape, and Unlink
    //     re-renders enrolment in place;
    //  4. a fresh login proves the unlink stuck server-side: password lands
    //     on backup-code verify again. Ending there is deliberate — walking
    //     further would re-enrol and mutate the restored state.
    // The runner resolves an unused code via the admin API before any phase
    // (the archetype declares lookup_secret) ⇒ internal lane. remove-2fa is
    // crash-insurance only: a walk that dies after re-enrolment but before
    // the unlink would otherwise leave a totp credential the next run's
    // phase 1 does not expect (admin-side, idempotent, webauthn no-op).
    defineScenario({
      id: "settings-totp-unlink",
      description:
        "Backup-code login forces TOTP re-enrolment; unlinking from settings restores the codes-only identity",
      requires: {
        mfaEnabled: true,
        mfaEnforced: true,
        multiTenancy: false,
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
