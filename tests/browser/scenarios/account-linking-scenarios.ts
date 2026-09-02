// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Account-linking scenario suite — S10 item 15.
 *
 * Two surfaces, both observed live 2026-09-01 before being declared:
 *
 *  - LOGIN-TIME: the register page's provider buttons are the entry (the
 *    identifier-first login page only offers providers to identities that
 *    already carry the oidc credential). Dex authenticating an address that
 *    belongs to a seeded PASSWORD identity collides, and kratos redirects to
 *    the authenticate-to-link page (/ui/login?flow=…&no_org_ui=true) — DOM-
 *    identical to the ordinary password page, so it reuses the
 *    login-password state. Submitting the existing password LINKS: the
 *    identity gains the oidc credential with the dex subject bound
 *    (admin-API verified during discovery).
 *
 *  - SETTINGS: /ui/manage_connected_accounts (the `connected-accounts`
 *    state) renders per-provider Connect buttons; Connect runs the dex
 *    ceremony and returns linked, Disconnect re-renders unlinked.
 *
 * Every archetype here has a MATCHING static-password account in
 * docker/dex/config.yml — the email equality is what makes the collision a
 * collision. requires.oidcSequencing: false — on sequencing profiles every
 * post-OIDC login forks into the passkey step-up; canonical-portal (dex,
 * no sequencing, linking on) is the pinned gate profile that runs these.
 *
 * Internal lane: registration/collision bootstrap navigates kratos's
 * public port directly and cleanup needs the admin API.
 */

import { expect } from "@playwright/test";
import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const accountLinkingScenarios = defineScenarioSuite({
  name: "account-linking",
  defaultLanes: ["internal"],
  scenarios: [
    // ── Login-time linking, proven by the tokens ─────────────────────────
    // The linking proof lives in the tokens: the dex sign-in after the link
    // must yield the SEEDED identity (sub === manifest identityId — the
    // linked-identity-tokens post check), not a freshly minted doppelgänger.
    //
    // COLLISION-FIRST ordering, and a password-ONLY archetype, on purpose:
    // the link flow dead-ends behind the BFF for a TOTP-bearing identity
    // (kratos answers error id 1010004, the BFF's known-code switch misses
    // it and answers a bare 500, and the UI renders NOTHING — the S-8
    // status-collapse class, observed on the wire 2026-09-01 and filed in
    // upstreamFindings). A silent dead-end has no walkable expectError
    // shape, so the scenario walks the identity shape that works and the
    // finding tracks the broken one.
    defineScenario({
      id: "link-at-login",
      description:
        "A dex sign-in for an existing local address collides, links after password auth, and then yields the seeded identity's tokens",
      requires: {
        accountLinkingEnabled: true,
        oidcProviders: ["dex"],
        oidcSequencing: false,
        localUsersEnabled: true,
      },
      user: { ref: "link-user", credentials: ["password"], totpConfigured: false },
      phases: [
        {
          name: "dex collides and the existing password links it",
          expectedPath: [
            "register-email",
            "provider:dex:login",
            "login-password",
            "manage-details",
          ],
        },
        {
          name: "dex sign-in now lands the linked identity",
          freshSession: true,
          expectedPath: ["login-email", "provider:dex:login", "oidc-callback"],
        },
      ],
      postChecks: ["linked-identity-tokens"],
      cleanup: "remove-oidc",
    }),

    // ── Settings linking: connect, then disconnect ───────────────────────
    // Self-restoring walk (link then unlink); remove-oidc is crash insurance
    // for a run that dies between the two.
    defineScenario({
      id: "settings-link-and-unlink",
      description:
        "Connect dex from the connected-accounts page, then disconnect it — both shapes render and the walk restores the seeded identity",
      requires: {
        accountLinkingEnabled: true,
        oidcProviders: ["dex"],
        oidcSequencing: false,
        localUsersEnabled: true,
        mfaEnabled: true,
      },
      user: { ref: "settings-link-user", credentials: ["password", "totp"], totpConfigured: true },
      phases: [
        {
          name: "sign in",
          expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
        },
        {
          // The Connect ceremony's settings flow carries no return_to, so
          // kratos's completion lands on selfservice.flows.settings.ui_url —
          // /ui/reset_password (runner-observed 2026-09-01; the same fallback
          // the passkey transition documents). Cosmetic landing; the LINK is
          // done, which phase 3's Disconnect button existing proves.
          name: "connect dex",
          expectedPath: ["manage-details", "connected-accounts", "provider:dex:login", "reset-password"],
        },
        {
          name: "disconnect it",
          expectedPath: ["manage-details", "connected-accounts", "connected-accounts"],
        },
      ],
      cleanup: "remove-oidc",
    }),
  ],
});
