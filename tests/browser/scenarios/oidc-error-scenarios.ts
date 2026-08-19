// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * OIDC authorize-error scenarios — the error matrix testing-spec §10 item 9
 * called for.
 *
 * Hydra splits authorize errors on redirect-URI validity
 * (writeAuthorizeError): a request whose client_id/redirect_uri cannot be
 * validated 302s to `urls.error` — login-ui's /ui/oidc_error page — because
 * redirecting an error to an unvalidated URI would be an open redirect. A
 * validatable request instead carries `?error=` back to the RP callback,
 * where the consumer renders its error page.
 *
 * The malformation is pure scenario data: flowParams override authorize query
 * params (buildAuthorizeUrl replaces existing keys), and the two `start →`
 * error transitions just navigate. These scenarios are ALSO what keeps the
 * login-ui error page honest: `oauth2.expose_internal_errors: true` means
 * `error_debug` is user-visible, so the rendered surface is pinned here.
 *
 * No local users, no MFA, no provider needed — this suite runs on every row
 * that deploys hydra + login-ui, i.e. all of them.
 */

import { defineScenario, defineScenarioSuite } from "../framework/scenario-types";

export const oidcErrorScenarios = defineScenarioSuite({
  name: "oidc-error",
  defaultLanes: ["live", "internal"],
  scenarios: [
    // Unknown client: unvalidatable → login-ui error page.
    defineScenario({
      id: "unknown-client-renders-error-page",
      description: "An authorize request with an unknown client_id lands on /ui/oidc_error with a rendered description",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { client_id: "no-such-client" },
      expectedPath: ["oidc-error-page"],
    }),

    // Unregistered redirect_uri: unvalidatable → login-ui error page (an
    // error redirected to an unvalidated URI would be an open redirect).
    defineScenario({
      id: "invalid-redirect-uri-renders-error-page",
      description: "An authorize request with an unregistered redirect_uri lands on /ui/oidc_error, never on the attacker URI",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { redirect_uri: "http://evil.example/cb" },
      expectedPath: ["oidc-error-page"],
    }),

    // Unknown scope: the client/redirect validate, so the error goes BACK to
    // the RP (`strategies.scope: exact`). Spec-mandated code: invalid_scope.
    defineScenario({
      id: "invalid-scope-redirects-error-to-rp",
      description: "An authorize request with an ungranted scope returns error=invalid_scope to the RP callback",
      requires: {},
      user: { ref: "returning-mfa", credentials: [], totpConfigured: false },
      flowParams: { scope: "openid bogus-scope" },
      expectedPath: ["oidc-callback-error"],
      finalUrlContains: "error=invalid_scope",
    }),

    // prompt=none without a session: OIDC-mandated login_required to the RP —
    // the failure half of the silent-SSO contract. The test context is fresh,
    // so no session exists by construction.
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
