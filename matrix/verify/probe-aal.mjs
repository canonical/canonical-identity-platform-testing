// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Layer 2 probe: AAL / second-factor behaviour, asked of the deployment
// rather than compared against the expectedEnv() that generated it.
//
// Under `highest_available` kratos compares the session's AAL against what
// the IDENTITY can reach (ory/kratos@64e04ac session/manager_http.go:337-398),
// so a password-only identity passes under either setting: the probe enrols
// lookup_secret (enabled exactly when the required AAL is highest_available
// on a local-idp row, lib.mjs derive()) to make the two observably different.
// Asserts HTTP 403 from /sessions/whoami for the AAL1 session
// (ory/kratos@64e04ac session/manager.go:102-116) and 200 for the AAL2 one;
// the error id is reported, never asserted (it varies across versions).

import { record, fetchJson } from "./record.mjs";
import { createProbeIdentity, deleteProbeIdentity } from "./probe-identity.mjs";

const groupsOf = (flow) => new Set((flow?.ui?.nodes ?? []).map((n) => n.group));

/** Native (API) login: flow init, then a one-shot password submit. Same
 *  shapes as tests/browser/helpers/kratos.ts `createSessionToken`. */
async function nativeLogin(u, email, password) {
  const flow = await fetchJson(`${u.kratosPublic}/self-service/login/api`);
  if (flow.status !== 200 || !flow.body?.id) return { status: flow.status, token: null };
  const res = await fetchJson(`${u.kratosPublic}/self-service/login?flow=${flow.body.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "password", identifier: email, password }),
  });
  return { status: res.status, token: res.body?.session_token ?? null };
}

// `X-Session-Token` is read first and unconditionally (ory/kratos@64e04ac session/manager_http.go:210-231).
const whoami = (u, token) => fetchJson(`${u.kratosPublic}/sessions/whoami`, { headers: { "X-Session-Token": token } });

const settingsSubmit = (u, flowId, token, payload) =>
  fetchJson(`${u.kratosPublic}/self-service/settings?flow=${flowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": token },
    body: JSON.stringify(payload),
  });

export async function verifyAalBehavior(v, u) {
  const check = `whoami AAL enforcement (required_aal=${v.aal})`;
  if (!u.kratosAdmin) {
    record("behavior", check, false, "skipped: no KRATOS_ADMIN_URL — the urls backend has no admin API, so no throwaway identity can be provisioned", { warn: true });
    return;
  }
  if (!v.password) {
    record("behavior", check, false, "skipped: local_idp=off — no password credential can drive a native login, so no AAL1 session is obtainable", { warn: true });
    return;
  }

  let identityId = null;
  try {
    const created = await createProbeIdentity(u.kratosAdmin, u.identitySchemaId, "matrix-verify-aal");
    identityId = created.id;
    if (!identityId) {
      record("behavior", check, false, `throwaway identity not created: POST ${u.kratosAdmin}/admin/identities → HTTP ${created.status}${created.error ? ` (${created.error})` : ""}`);
      return;
    }
    const { email, password } = created;

    const first = await nativeLogin(u, email, password);
    if (!first.token) {
      record("behavior", check, false, `native password login returned no session token (HTTP ${first.status})`);
      return;
    }
    // Control: a password-only identity tops out at AAL1, so whoami accepts this under either setting.
    const control = await whoami(u, first.token);
    if (control.status !== 200) {
      record("behavior", check, false, `whoami refused a fresh AAL1 session (HTTP ${control.status}) before any second factor existed`);
      return;
    }

    // Which second factors can actually be ENROLLED.
    const settings = await fetchJson(`${u.kratosPublic}/self-service/settings/api`, { headers: { "X-Session-Token": first.token } });
    const offered = groupsOf(settings.body);
    for (const [method, expected] of [["totp", v.totp], ["lookup_secret", v.lookup]]) {
      record(
        "behavior",
        `${method} method ${expected ? "enabled" : "disabled"}`,
        offered.has(method) === expected,
        offered.has(method) === expected ? "" : `settings flow ${offered.has(method) ? "offers" : "lacks"} ${method} (HTTP ${settings.status})`,
      );
    }

    if (v.aal !== "highest_available") {
      record("behavior", check, true, "no second factor is enrollable, so no identity here can exceed AAL1 and whoami accepts the AAL1 session");
      return;
    }
    if (!offered.has("lookup_secret")) {
      record("behavior", check, false, `inconclusive: cannot raise the identity to AAL2 — the settings flow offers no lookup_secret method (HTTP ${settings.status})`, { warn: true });
      return;
    }

    const flowId = settings.body?.id;
    const regenerate = await settingsSubmit(u, flowId, first.token, { method: "lookup_secret", lookup_secret_regenerate: true });
    const confirm = await settingsSubmit(u, flowId, first.token, { method: "lookup_secret", lookup_secret_confirm: true });
    if (confirm.status !== 200) {
      record("behavior", check, false, `lookup_secret enrolment failed: regenerate HTTP ${regenerate.status}, confirm HTTP ${confirm.status}`);
      return;
    }

    // Confirming lookup_secret raises the ENROLLING session to AAL2
    // (ory/kratos@64e04ac selfservice/strategy/lookup/settings.go:322-327), so
    // a second login supplies the genuinely AAL1 session. Native login still
    // returns a token when the AAL is unsatisfied — it only nulls
    // `session.identity` (ory/kratos@64e04ac selfservice/flow/login/hook.go:246-257).
    const second = await nativeLogin(u, email, password);
    if (!second.token) {
      record("behavior", check, false, `second native login returned no session token after lookup_secret enrolment (HTTP ${second.status})`);
      return;
    }
    const refused = await whoami(u, second.token);
    const accepted = await whoami(u, first.token);
    const ok = refused.status === 403 && accepted.status === 200;
    record(
      "behavior",
      check,
      ok,
      ok
        ? `AAL1 session refused 403 (${refused.body?.error?.id ?? "no error id"}), AAL2 session accepted`
        : `expected AAL1→403 and AAL2→200; got ${refused.status} (${refused.body?.error?.id ?? "no error id"}) and ${accepted.status}`,
    );
  } finally {
    // A leaked identity would poison the seeder's fresh-mode wipe: a failed deletion is a FAILED check.
    if (identityId) {
      const deleted = await deleteProbeIdentity(u.kratosAdmin, identityId);
      record("behavior", "AAL probe identity deleted", deleted.gone, deleted.gone ? "" : `DELETE ${u.kratosAdmin}/admin/identities/${identityId} → HTTP ${deleted.status}${deleted.error ? ` (${deleted.error})` : ""} — LEAKED`);
    }
  }
}
