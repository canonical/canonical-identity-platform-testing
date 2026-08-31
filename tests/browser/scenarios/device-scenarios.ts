// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Device authorization grant (RFC 8628) — §10 item 10, landed.
 *
 * The device half is an API call ("start → device-code" mints the code pair
 * with the manifest's RP client against hydra's PUBLIC device endpoint), the
 * user half is a browser walk, and the token half is the runner redeeming
 * ctx.deviceCode at the token endpoint after /ui/device_complete — device
 * tokens arrive by RP polling, never a callback, which is why this suite's
 * terminal is the one sanctioned exception to the callback rule
 * (defineScenario's device-complete carve-out).
 *
 * Surveyed live 2026-08-31 on the compose stack and iam.orange: user code
 * arrives prefilled via verification_uri_complete ("Enter code to continue"
 * → Next), the login journey is the standard challenge walk, and the
 * terminal reads "Sign in successful … successfully connected".
 *
 * Live-lane compatible: public endpoints plus the manifest, no admin API.
 */

import { expect } from "@playwright/test";
import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

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
      // Evaluated against the POLLED tokens (the runner redeems
      // ctx.deviceCode after the walk): proves the grant issued a real,
      // decodable identity token for the user who authenticated in the
      // browser — not merely that the success page rendered.
      assertions: {
        custom: async ({ idTokenClaims }) => {
          expect(idTokenClaims.sub, "device-grant id_token must name a subject").toBeTruthy();
          const amr = idTokenClaims.amr;
          expect(Array.isArray(amr) ? amr : [], "device-grant id_token amr must record the password+totp login").toEqual(
            expect.arrayContaining(["password", "totp"]),
          );
        },
      },
    }),
  ],
});
