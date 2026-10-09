// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Where login-ui v0.28.0 diverges from the spec path a derived walk expects: the walk, the rows it
 *  holds on (`where`, one boolean key at most — the spec variant gets its negation), and today's
 *  path. A pin matching no derived walk fails at import; a pinned divergence that stops reproducing
 *  fails the test, so a fix shows up as a register edit. */

import type { PageStateType } from "../helpers/page-state";
import type { ScenarioRequires } from "../framework/scenario-types";

export interface DerivedPin {
  /** The derived walk's id (`<base> ⟂ <kind>@<index>`). */
  id: string;
  pd: string;
  note: string;
  where?: ScenarioRequires;
  expectedPath: PageStateType[];
  expectError?: true;
  expectErrorText?: string;
  pinnedInvariantViolation?: "I2" | "I3";
}

export const DERIVED_PINS: DerivedPin[] = [
  // login-ui#984: Back on the second-factor page restarts the login without the login_challenge;
  // the redone walk ends on the settings hub and the RP gets no code. Measured 2026-10-07, v0.28.0.
  {
    id: "returning-login-mfa ⟂ back@2",
    pd: "PD-11",
    note: "browser Back on the second-factor page loses the RP's login request; signing in again ends on the settings hub",
    expectedPath: ["login-email", "login-password", "login-totp-verify", "login-email", "login-password", "login-totp-verify", "manage-details"],
  },
  // The same for a user who picks a tenant: the password page is reached from the tenant
  // selection, a second way to it that a fix has to cover as well.
  {
    id: "multi-tenant-selection ⟂ back@3",
    pd: "PD-11",
    note: "browser Back on the second-factor page after a tenant selection loses the RP's login request too",
    expectedPath: ["login-email", "tenant-selection", "login-password", "login-totp-verify", "login-email", "login-password", "login-totp-verify", "manage-details"],
  },
  // login-ui#985: a code submitted on the second-factor page of a login that already completed is
  // answered "Server error" (a Kratos message login-ui does not map). Only where Kratos is not given
  // the login_challenge: with it the flow is a refresh and Kratos takes the code. Measured 2026-10-07.
  {
    id: "returning-login-mfa ⟂ back-resubmit (challenge kept from kratos)",
    pd: "PD-12",
    note: "a code submitted on the second-factor page of a login that already completed is answered with a server error",
    expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback", "login-totp-verify", "login-totp-verify"],
    expectError: true,
    expectErrorText: "Server error",
  },
  // The same on the tenant-selection shape (multi-tenancy never gives Kratos the challenge).
  {
    id: "multi-tenant-selection ⟂ back-resubmit (challenge kept from kratos)",
    pd: "PD-12",
    note: "a code submitted on the second-factor page of a login that already completed is answered with a server error (tenant-selection shape)",
    expectedPath: ["login-email", "tenant-selection", "login-password", "login-totp-verify", "oidc-callback", "login-totp-verify", "login-totp-verify"],
    expectError: true,
    expectErrorText: "Server error",
  },
  // login-ui#990 (merged, not in :stable): a tenant recorded for the request is kept when the email
  // is entered again, so the request opened again skips the tenant selection; the spec says the
  // email submission starts from an empty record and the user selects again. Measured 2026-10-09.
  {
    id: "multi-tenant-selection ⟂ reopen-request@2",
    pd: "PD-14",
    note: "the request opened again from the password step keeps the tenant picked before and skips the selection",
    expectedPath: ["login-email", "tenant-selection", "login-password", "login-email", "login-password", "login-totp-verify", "oidc-callback"],
  },
  {
    id: "multi-tenant-selection ⟂ reopen-request@3",
    pd: "PD-14",
    note: "the request opened again from the second-factor step keeps the tenant picked before and skips the selection",
    expectedPath: ["login-email", "tenant-selection", "login-password", "login-totp-verify", "login-email", "login-password", "login-totp-verify", "oidc-callback"],
  },
];
