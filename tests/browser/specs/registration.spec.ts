// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Registration scenario-driven browser tests.
 *
 * Generated from the registration scenario suite.
 */

import { test } from "@playwright/test";
import { registrationScenarios } from "../scenarios/registration-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { findUserByRef } from "../framework/manifest";
import {
  deleteIdentity,
  deleteIdentitySessions,
  findIdentityByEmail,
} from "../helpers/kratos";

for (const scenario of registrationScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    // The delete-before-recreate runs as runScenario's `prepare` hook, i.e.
    // AFTER the lane and satisfies() gates: this suite is internal-lane-only
    // and needs the admin API and the mail API, so on lanes that lack those
    // the scenarios must SKIP. Doing this work before runScenario meant a
    // missing manifest failed the two scenarios the declaration had excluded
    // — "executed but not in the expected set", on a lane where they could
    // never run.
    await runScenario(page, scenario, {
      prepare: async (manifest) => {
        // The seeder creates the new-user-* identities so the manifest can
        // carry a stable email, but a registration flow has to start from a
        // clean slate: Kratos rejects a duplicate identifier with "An account
        // with the same identifier already exists". Deleting first is also
        // what makes this spec idempotent across re-runs.
        const user = findUserByRef(manifest, scenario.user.ref);
        const existing = await findIdentityByEmail(user.email);
        if (existing) {
          await deleteIdentitySessions(existing);
          await deleteIdentity(existing);
        }
      },
    });
  });
}
