// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Device grant (RFC 8628): tokens arrive by RP polling, so device-complete is the one sanctioned non-callback terminal; live-lane compatible. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";
import { amrRecords, subjectIsSeededIdentity } from "../framework/claim-assertions";

export const deviceScenarios = defineScenarioSuite({
  name: "device",
  defaultLanes: ["live", "internal"],
  scenarios: [
    defineScenario({
      id: "device-flow-login",
      description:
        "Device grant end-to-end: user code confirmed, MFA login in the browser, token poll redeems the device_code",
      requires: {
        deviceFlow: true,
        mfaEnabled: true,
        localUsersEnabled: true,
        secondFactorMethods: ["totp"],
      },
      user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
      expectedPath: [
        "device-code",
        "login-email",
        "login-password",
        "login-totp-verify",
        "device-complete",
      ],
      finalUrlContains: "/ui/device_complete",
      // Evaluated against the polled tokens: the runner redeems ctx.deviceCode after the walk.
      assertions: {
        claims: [
          subjectIsSeededIdentity(),
          amrRecords({ mustInclude: ["password", "totp"] }),
        ],
      },
      postChecks: ["device-code-replay-rejected"],
    }),

    defineScenario({
      id: "device-code-invalid-rejected",
      description:
        "A user code hydra never issued is rejected visibly, and the unapproved device_code redeems no tokens",
      requires: { deviceFlow: true },
      user: { ref: "no-mfa", credentials: ["password"], totpConfigured: false },
      expectedPath: ["device-code", "device-code"],
      expectError: true,
    }),
  ],
});
