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
import { readManifest, findUserByRef } from "../framework/manifest";
import {
  deleteIdentity,
  deleteIdentitySessions,
  findIdentityByEmail,
} from "../helpers/kratos";

for (const scenario of registrationScenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    const manifest = readManifest();

    // The seeder creates the new-user-* identities so the manifest can carry a
    // stable email, but a registration flow has to start from a clean slate:
    // Kratos rejects a duplicate identifier with "An account with the same
    // identifier already exists, contact support". Deleting first is also what
    // makes this spec idempotent across re-runs.
    const user = findUserByRef(manifest, scenario.user.ref);
    const existing = await findIdentityByEmail(user.email);
    if (existing) {
      await deleteIdentitySessions(existing);
      await deleteIdentity(existing);
    }

    await runScenario(page, scenario);
  });
}
