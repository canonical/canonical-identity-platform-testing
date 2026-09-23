// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Layer 3: product self-report. /api/v0/app-config against the declaration.

import { record, fetchJson } from "./record.mjs";

// Keys /api/v0/app-config serves truthfully WHEN IT SERVES THEM: present and
// disagreeing fails; absent is a login-ui version fact reported as drift
// (`multi_tenancy_enabled` from v0.27.0, canonical/identity-platform-login-ui@973f960
// pkg/status/handlers.go). Gating never reads this endpoint.
const TRUTHFUL_KEYS = ["multi_tenancy_enabled", "oidc_webauthn_sequencing_enabled", "identifier_first_enabled", "base_url"];

export async function verifySelfReport(caps, u) {
  const r = await fetchJson(`${u.loginUi}/api/v0/app-config`);
  if (r.status !== 200) {
    // Keep the transport cause, or every TLS problem reads as a bare "HTTP 0".
    record("self-report", "app-config reachable", false, `GET ${u.loginUi}/api/v0/app-config → HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
    return;
  }
  const appConfig = r.body;

  const omitted = [];
  for (const key of TRUTHFUL_KEYS) {
    if (!(key in appConfig)) {
      omitted.push(key);
      continue;
    }
    // base_url is substrate-dependent; a supplied LOGIN_UI_URL IS the declared base for this run.
    const want = key === "base_url" && u.loginUiOverridden ? u.loginUi : caps[key];
    const ok = JSON.stringify(appConfig[key]) === JSON.stringify(want);
    record("self-report", key, ok, ok ? "" : `declared ${JSON.stringify(want)}, reported ${JSON.stringify(appConfig[key])}`);
  }
  if (omitted.length > 0) {
    record(
      "self-report",
      `app-config omits ${omitted.length} truthful key(s)`,
      false,
      `${omitted.join(", ")} — this login-ui predates those fields; unverifiable from the endpoint, declaration stands`,
      { warn: true },
    );
  }

  const drift = [];
  for (const [key, want] of Object.entries(caps)) {
    if (TRUTHFUL_KEYS.includes(key) || key === "access_token_format") continue;
    const got = appConfig[key];
    if (got === undefined) drift.push(`${key}: omitted`);
    else if (JSON.stringify(got) !== JSON.stringify(want)) drift.push(`${key}: reports ${JSON.stringify(got)}, deployment is ${JSON.stringify(want)}`);
  }
  record("self-report", "PD-5 drift (product finding, non-fatal)", drift.length === 0, drift.join("; "), { warn: true });
}
