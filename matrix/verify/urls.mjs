// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Row-scoped URL resolution, shared by the preflight verifier and the runner.

/** Env keys carrying a row's URLs to every consumer. On the urls backend this
 *  list IS the interface; compose and juju discover defaults for it. */
export const URL_ENV_KEYS = [
  "LOGIN_UI_URL",
  "KRATOS_PUBLIC_URL",
  "KRATOS_ADMIN_URL",
  "HYDRA_PUBLIC_URL",
  "HYDRA_ADMIN_URL",
  "MAIL_API_URL",
  "DEX_URL",
  "OIDC_CONSUMER_URL",
  "TENANT_SERVICE_URL",
  "HOOK_SERVICE_URL",
  "USER_VERIFICATION_URL",
];

/** Row env for the URL keys: operator `process.env` wins over `discovered`;
 *  unset keys are omitted so a `{ ...process.env, ...rowEnv }` spread never shadows. */
export function rowUrlEnv(discovered = {}) {
  const env = {};
  for (const key of URL_ENV_KEYS) {
    const value = process.env[key] ?? discovered[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Resolve every URL the harness probes, ONCE PER ROW (never module-level:
 *  `run-row --all` would capture row 1's env). Localhost defaults are the
 *  compose host ports; on the urls backend — or a juju attach through a public
 *  ingress (`MATRIX_PUBLIC_URLS=1` in the row env) — unset stays undefined and
 *  each probe warn-skips itself rather than aiming at an unrelated local stack. */
export function resolveUrls(env = {}, backend = "compose") {
  const pick = (key, fallback) => env[key] ?? process.env[key] ?? fallback;
  const noDefaults = backend === "urls" || env.MATRIX_PUBLIC_URLS === "1";
  const local = (key, port) => pick(key, noDefaults ? undefined : `http://localhost:${port}`);
  return {
    // No substrate-side URLs: probes that need kratos itself warn-skip, the BFF witness stays.
    publicOnly: noDefaults,
    kratosPublic: local("KRATOS_PUBLIC_URL", 4433),
    hydraPublic: local("HYDRA_PUBLIC_URL", 4444),
    hydraAdmin: local("HYDRA_ADMIN_URL", 4445),
    // run-row.mjs keys its live-lane subset off kratosAdmin being unset.
    kratosAdmin: local("KRATOS_ADMIN_URL", 4434),
    // The AAL probe creates a throwaway identity and must name the served schema.
    identitySchemaId: pick("KRATOS_IDENTITY_SCHEMA_ID", "default"),
    loginUi: pick("LOGIN_UI_URL", "http://localhost"),
    // Explicitly-supplied login-ui base overrides the declaration's base_url.
    loginUiOverridden: Boolean(env.LOGIN_UI_URL ?? process.env.LOGIN_UI_URL),
    // Mailslurper's JSON service API (4437; 4436 is the web UI).
    mailApi: local("MAIL_API_URL", 4437),
    // No default: compose runs the consumer as a service, juju/urls as a host container.
    oidcConsumer: pick("OIDC_CONSUMER_URL", undefined),
    // Add-on status endpoints (compose backend publishes these host ports).
    serviceStatus: {
      "tenant-service": pick("TENANT_SERVICE_URL", "http://localhost:8081"),
      "hook-service": pick("HOOK_SERVICE_URL", "http://localhost:8080"),
      "user-verification-service": pick("USER_VERIFICATION_URL", "http://localhost:8083"),
    },
    // EXPLICIT only: the in-repo tests/browser/manifest.json is whatever stack
    // was seeded last, and minting with another deployment's client is the
    // cross-stack confusion the consumer origin guard refuses.
    manifest: pick("MANIFEST", undefined),
  };
}
