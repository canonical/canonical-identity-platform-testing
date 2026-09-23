// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Authorize-error matrix: hydra sends unvalidatable client_id/redirect_uri errors to `urls.error` (/ui/oidc_error), validatable ones back to the RP callback as `?error=`. */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const oidcErrorScenarios = defineScenarioSuite({
  name: "oidc-error",
  defaultLanes: ["live", "internal"],
  scenarios: [
    defineScenario({
      id: "unknown-client-renders-error-page",
      description: "An authorize request with an unknown client_id lands on /ui/oidc_error with a rendered description",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { client_id: "no-such-client" },
      expectedPath: ["oidc-error-page"],
    }),

    defineScenario({
      id: "invalid-redirect-uri-renders-error-page",
      description: "An authorize request with an unregistered redirect_uri lands on /ui/oidc_error, never on the attacker URI",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { redirect_uri: "http://evil.example/cb" },
      expectedPath: ["oidc-error-page"],
    }),

    defineScenario({
      id: "invalid-scope-redirects-error-to-rp",
      description: "An authorize request with an ungranted scope returns error=invalid_scope to the RP callback",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { scope: "openid bogus-scope" },
      expectedPath: ["oidc-callback-error"],
      finalUrlContains: "error=invalid_scope",
    }),

    defineScenario({
      id: "prompt-none-without-session",
      description: "prompt=none with no session returns error=login_required to the RP (silent-SSO failure contract)",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { prompt: "none" },
      expectedPath: ["oidc-callback-error"],
      finalUrlContains: "error=login_required",
    }),
  ],
});
