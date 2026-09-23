// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

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
    // Delete-before-recreate runs inside `prepare`, after the lane and satisfies() gates; Kratos rejects duplicate identifiers.
    await runScenario(page, scenario, {
      prepare: async (manifest) => {
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
