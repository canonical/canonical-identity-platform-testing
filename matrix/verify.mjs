#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Preflight verifier: asserts that the RUNNING deployment matches a matrix
// row's declaration before any test may run. Reconfiguration-instead-of-
// redeploy means a failed reconfiguration would otherwise let discovery-driven
// gating silently shrink the executed set — this is the tripwire.
//
//   node matrix/verify.mjs <row-name>
//
// Three layers, strongest ground truth first:
//   compose   — did the override actually land? (services present/absent,
//               container env, kratos config-file list)
//   behavior  — does the deployment BEHAVE as declared? Catches env keys the
//               service silently ignores (koanf drops unknown keys — the
//               SELFSERVICE_METHODS_OIDC_SEQUENCING_ENABLED no-op proved this
//               class is real) by probing kratos flows, the AAL a real session
//               is held to, and hydra's token shape and token hook. This is the
//               only layer that is an INDEPENDENT witness: layer 1 compares
//               container env against the same expectedEnv() that generated the
//               override, and layer 3 is trusted for four keys only (PD-5).
//   self-report — /api/v0/app-config vs declaration. Keys the endpoint serves
//               truthfully are fatal on mismatch; the rest is reported as
//               PD-5 drift (product finding, not a harness failure).
//
// Exit 0 = deployment matches declaration. Exit 1 = drift; every failure line
// names the dimension, expected, and observed.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { derive, expectedEnv, kratosConfigFiles, jujuTfvars, TOGGLED_SERVICES } from "./lib.mjs";
import { assertController } from "./controller-guard.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "identity-platform";
const JUJU_MODEL = process.env.MATRIX_JUJU_MODEL ?? "iam-matrix";

/** Resolve every URL this verifier probes, ONCE PER ROW.
 *
 *  Never module-level constants: a multi-row process (`run-row --all`) would
 *  capture row 1's environment at first import and verify every later row
 *  against row 1's addresses. `verifyRow` takes the row's environment as an
 *  argument and threads the resolved set down; the `process.env` fallbacks
 *  keep the by-hand `node matrix/verify.mjs <row>` entry point working, and
 *  the localhost defaults are the compose backend's published host ports
 *  (see AGENTS.md "Port Mapping"). */
function resolveUrls(env = {}, backend = "compose") {
  const pick = (key, fallback) => env[key] ?? process.env[key] ?? fallback;
  // A localhost fallback is only meaningful where the backend PUBLISHES that
  // port (compose/juju). In the `urls` backend it is actively harmful: the
  // whole interface is the env, so an unset URL means "this surface is not
  // reachable from here", and guessing localhost aims the probe at whatever
  // unrelated stack happens to be running on this machine — which then FAILS
  // the row on a socket that has nothing to do with the target. Unset stays
  // undefined and each probe warn-skips itself, naming what it could not ask.
  const local = (key, port) => pick(key, backend === "urls" ? undefined : `http://localhost:${port}`);
  return {
    kratosPublic: local("KRATOS_PUBLIC_URL", 4433),
    hydraPublic: local("HYDRA_PUBLIC_URL", 4444),
    hydraAdmin: local("HYDRA_ADMIN_URL", 4445),
    // run-row.mjs keys its live-lane subset off kratosAdmin being unset.
    kratosAdmin: local("KRATOS_ADMIN_URL", 4434),
    // Not a URL, but the same row-scoped resolution: the AAL probe creates a
    // throwaway identity and must name the schema the deployment serves.
    identitySchemaId: pick("KRATOS_IDENTITY_SCHEMA_ID", "default"),
    loginUi: pick("LOGIN_UI_URL", "http://localhost"),
    // Explicitly-supplied login-ui base overrides the declaration's base_url.
    loginUiOverridden: Boolean(env.LOGIN_UI_URL ?? process.env.LOGIN_UI_URL),
    // Mailslurper's JSON service API is a published compose host port (4437 —
    // distinct from the 4436 web UI; helpers/config.ts carries the same
    // default), so it gets the same backend-aware fallback as every other
    // published surface: localhost on compose/juju, undefined on urls.
    mailApi: local("MAIL_API_URL", 4437),
    // Add-on status endpoints (compose backend publishes these host ports).
    serviceStatus: {
      "tenant-service": pick("TENANT_SERVICE_URL", "http://localhost:8081"),
      "hook-service": pick("HOOK_SERVICE_URL", "http://localhost:8080"),
      "user-verification-service": pick("USER_VERIFICATION_URL", "http://localhost:8083"),
    },
    // The seed manifest, when the operator names one. EXPLICIT only — no
    // default path: the in-repo tests/browser/manifest.json is whatever stack
    // was seeded last on this machine, and silently minting with another
    // deployment's client is exactly the cross-stack confusion the consumer
    // origin guard exists to refuse.
    manifest: pick("MANIFEST", undefined),
  };
}

const results = [];
const record = (layer, check, ok, detail, { warn = false } = {}) => {
  results.push({ layer, check, ok, warn, detail });
  const mark = ok ? "✓" : warn ? "⚠" : "✗";
  console.log(`  ${mark} [${layer}] ${check}${detail ? ` — ${detail}` : ""}`);
};

/** Test seams. The results buffer is module state (one verifier process may
 *  verify many rows), so offline tests need to clear it and read it back to
 *  assert that a probe RECORDED a failure instead of throwing. */
export function resetResults() {
  results.length = 0;
}
export function recordedResults() {
  return results.slice();
}

function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export async function fetchJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeout ?? 8000),
      headers: { Accept: "application/json", ...(opts.headers ?? {}) },
      method: opts.method ?? "GET",
      body: opts.body,
    });
  } catch (err) {
    // Network failure is a CHECK RESULT (status 0), never a crash - a probe
    // against an unreachable deployment must record and continue.
    return { status: 0, body: null, error: err?.cause?.message ?? err?.message ?? String(err) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

// ── Layer 1: compose ────────────────────────────────────────────────────────

function verifyCompose(dims) {
  const env = expectedEnv(dims);

  for (const [dim, svc] of Object.entries(TOGGLED_SERVICES)) {
    const declared = dims[dim] === "present";
    const inspect = docker(["inspect", "-f", "{{.State.Running}}", `${PROJECT}-${svc}-1`]);
    const running = inspect.ok && inspect.out === "true";
    record(
      "compose",
      `${svc} ${declared ? "running" : "absent"}`,
      running === declared,
      running === declared ? "" : `declared ${dims[dim]}, container ${running ? "running" : "not running"}`,
    );
  }

  for (const [svc, expected] of Object.entries(env)) {
    if (Object.keys(expected).length === 0) continue;
    const inspect = docker(["inspect", "-f", "{{json .Config.Env}}", `${PROJECT}-${svc}-1`]);
    if (!inspect.ok) {
      record("compose", `${svc} env`, false, `container not inspectable: ${inspect.err}`);
      continue;
    }
    const actual = new Map(JSON.parse(inspect.out).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    const bad = Object.entries(expected)
      .filter(([k, v]) => actual.get(k) !== v)
      .map(([k, v]) => `${k}: want ${v}, got ${actual.has(k) ? actual.get(k) : "<unset>"}`);
    record("compose", `${svc} env (${Object.keys(expected).length} vars)`, bad.length === 0, bad.join("; "));
  }

  const cmd = docker(["inspect", "-f", "{{json .Config.Cmd}}", `${PROJECT}-kratos-1`]);
  if (cmd.ok) {
    const joined = JSON.parse(cmd.out).join(" ");
    const want = kratosConfigFiles(dims);
    const allFiles = ["/etc/config/kratos/kratos.yml", "/etc/config/kratos/kratos.dex.yml", "/etc/config/kratos/kratos.google.yml"];
    const bad = [];
    for (const f of allFiles) {
      const should = want.includes(f);
      if (joined.includes(f) !== should) bad.push(`${path.basename(f)} ${should ? "missing" : "unexpectedly loaded"}`);
    }
    record("compose", "kratos config files", bad.length === 0, bad.join("; "));
  } else {
    record("compose", "kratos config files", false, `container not inspectable: ${cmd.err}`);
  }
}

// ── Layer 2: behavior ───────────────────────────────────────────────────────

const groupsOf = (flow) => new Set((flow?.ui?.nodes ?? []).map((n) => n.group));
const oidcProvidersOf = (flow) =>
  (flow?.ui?.nodes ?? [])
    .filter((n) => n.group === "oidc" && n.attributes?.name === "provider")
    .map((n) => n.attributes.value)
    .sort();

// Layer 2's flow-shape probes read kratos's own flow config off kratos's PUBLIC
// API. On a real deployment that API is usually NOT what the ingress serves:
// login-ui-operator's public route rewrites /self-service/* onto the BFF's
// /api/kratos/self-service/* (canonical/identity-platform-login-ui-operator@b8497db
// templates/public-route.json.j2), and the BFF answers from its own chi route
// table — a login-ui VERSION fact, not a kratos config fact. Read through it, a
// missing BFF route is indistinguishable from a disabled kratos flow:
// iam.orange.canonical.com (login-ui v0.24.0-v0.25.0) 404s
// /self-service/registration/browser and .../verification/browser although
// kratos has both, because those routes only exist in the BFF from v0.26.0
// (canonical/identity-platform-login-ui pkg/kratos/handlers.go: 11 routes at
// @ad44e9e, 17 at @48a7049). Kratos itself never 404s a disabled flow — it
// forwards a 400 (ory/kratos@64e04ac
// selfservice/flow/registration/handler.go:113-115,
// selfservice/flow/verification/handler.go:167-170).
//
// Hence the gate: prove kratos answers before reading kratos config off it.
// /self-service/login/api is the discriminator — a native-flow endpoint kratos
// serves and the BFF has never routed at any version.
async function kratosAnswersDirectly(u) {
  if (!u.kratosPublic) {
    return { ok: false, why: "KRATOS_PUBLIC_URL is unset — no kratos public API is reachable from here" };
  }
  const r = await fetchJson(`${u.kratosPublic}/self-service/login/api`);
  if (r.status === 200 && r.body?.id) return { ok: true };
  return {
    ok: false,
    why:
      `GET ${u.kratosPublic}/self-service/login/api → HTTP ${r.status}${r.error ? ` (${r.error})` : ""}` +
      " — that URL does not serve kratos's public API (an ingress fronting the login-ui BFF answers exactly this)",
  };
}

/** The login flow as the BROWSER gets it, when kratos is only reachable behind
 *  the BFF. The BFF answers /self-service/login/browser with a 303 to
 *  /ui/login?flow=<id> and serves the kratos flow itself at
 *  /self-service/login/flows?id=<id>, so the 1FA surface is still readable —
 *  just not off the initiating response. */
async function loginFlowThroughBff(u) {
  const init = await fetch(`${u.kratosPublic}/self-service/login/browser?return_to=${encodeURIComponent(`${u.loginUi}/ui/login`)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!init) return { flow: null, why: "login flow init was unreachable" };
  const id = init.headers.get("location")?.match(/[?&]flow=([^&]+)/)?.[1];
  if (!id) return { flow: null, why: `login flow init → HTTP ${init.status} with no ?flow= in its Location` };
  const cookies = init.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const flow = await fetchJson(`${u.kratosPublic}/self-service/login/flows?id=${id}`, { headers: { Cookie: cookies } });
  if (flow.status !== 200 || !flow.body?.ui) return { flow: null, why: `GET /self-service/login/flows?id=${id} → HTTP ${flow.status}` };
  return { flow: flow.body, why: "" };
}

function recordProviderSet(check, flow, caps, detailPrefix) {
  const seen = oidcProvidersOf(flow);
  const want = [...caps.oidc_providers].sort();
  const ok = JSON.stringify(seen) === JSON.stringify(want);
  record("behavior", check, ok, ok ? "" : `${detailPrefix} offers [${seen.join(", ")}]`);
}

async function verifyBehavior(dims, caps, u, backend) {
  const v = derive(dims);

  const direct = await kratosAnswersDirectly(u);
  if (direct.ok) {
    await verifyKratosFlowShape(v, caps, u);
  } else if (backend === "urls") {
    // Mode 5's normal shape, not a broken deployment: warn, name exactly what
    // went unasked, and keep the one witness the BFF surface still gives.
    record(
      "behavior",
      "kratos public API answers directly",
      false,
      `${direct.why} — registration/recovery/verification flow-config probes skipped`,
      { warn: true },
    );
    if (u.kratosPublic) {
      const { flow, why } = await loginFlowThroughBff(u);
      if (flow) {
        recordProviderSet(`oidc providers [${[...caps.oidc_providers].sort().join(", ") || "none"}] (through the login-ui BFF)`, flow, caps, "the browser login flow");
      } else {
        record("behavior", "login flow readable through the login-ui BFF", false, why);
      }
    }
  } else {
    // compose and juju both publish kratos's public port; anything else here is
    // a broken deployment, not a topology difference.
    record("behavior", "kratos public API answers directly", false, direct.why);
  }

  // The two independent witnesses layer 2 was missing (R-7). Layer 1 can only
  // compare container env against the SAME expectedEnv() that generated it, so
  // these ask the deployment what it actually does with those keys.
  await verifyAalBehavior(v, u);
  await verifyHydraTokens(v, caps, u);

  await verifyMailApi(caps, u);
  await verifyDeviceFlow(caps, u);
}

async function verifyKratosFlowShape(v, caps, u) {
  // Registration is two-step on this kratos: step 1 is method-agnostic (oidc
  // buttons + csrf + the `profile` trait-collection chooser, which kratos
  // renders unconditionally — `methods.profile.enabled` gates the settings
  // method, not this step, so it is NOT a local-idp discriminator; verified
  // empirically against both a password-on and a password-off deployment).
  // Credential methods (password / webauthn-1FA) appear only on the credential
  // step reached via method=profile, so the probe walks both steps. No
  // identity is created — the flow stops at the credential-choice step.
  const regRes = await fetch(`${u.kratosPublic}/self-service/registration/browser?return_to=${encodeURIComponent(`${u.loginUi}/ui/login`)}`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!regRes || regRes.status !== 200) {
    record("behavior", "registration flow creatable", false, `HTTP ${regRes?.status ?? "unreachable"} (registration is always enabled in charm deployments)`);
  } else {
    const cookies = regRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const reg = await regRes.json();
    const g1 = groupsOf(reg);

    recordProviderSet(
      `oidc providers [${[...caps.oidc_providers].sort().join(", ") || "none"}]`,
      reg,
      caps,
      "the registration flow",
    );

    if (g1.has("profile")) {
      // Advance to the credential step to see password/webauthn directly.
      const csrf = (reg.ui?.nodes ?? []).find((n) => n.attributes?.name === "csrf_token")?.attributes?.value;
      const step2 = await fetchJson(`${u.kratosPublic}/self-service/registration?flow=${reg.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({ method: "profile", csrf_token: csrf, "traits.email": "matrix-verify-probe@test.example" }),
      });
      const g2 = groupsOf(step2.body);
      record(
        "behavior",
        `password method ${v.password ? "enabled" : "disabled"}`,
        g2.has("password") === v.password,
        g2.has("password") === v.password ? "" : `credential step ${g2.has("password") ? "offers" : "lacks"} password (HTTP ${step2.status})`,
      );
      record(
        "behavior",
        `webauthn 1FA ${v.passwordless ? "enabled" : "disabled"}`,
        g2.has("webauthn") === v.passwordless,
        g2.has("webauthn") === v.passwordless ? "" : `credential step ${g2.has("webauthn") ? "offers" : "lacks"} webauthn (HTTP ${step2.status})`,
      );
    } else {
      // No trait-collection chooser at all (kratos variant without two-step
      // registration): credential nodes live on step 1 directly.
      record(
        "behavior",
        `password method ${v.password ? "enabled" : "disabled"}`,
        g1.has("password") === v.password,
        g1.has("password") === v.password ? "" : `registration flow ${g1.has("password") ? "offers" : "lacks"} password nodes`,
      );
    }
  }

  // Login flow: provider set must agree with the declaration too. `return_to`
  // is not optional plumbing — the login-ui BFF rejects a login-flow init
  // without it (canonical/identity-platform-login-ui@197703c
  // pkg/kratos/handlers.go:101-104) while kratos accepts it, so passing it
  // keeps one probe shape valid on every surface.
  const login = await fetchJson(`${u.kratosPublic}/self-service/login/browser?return_to=${encodeURIComponent(`${u.loginUi}/ui/login`)}`);
  if (login.status !== 200) {
    record("behavior", "login flow creatable", false, `HTTP ${login.status}`);
  } else {
    recordProviderSet("login flow provider set", login.body, caps, "the login flow");
  }

  // Flow toggles: kratos 404s a disabled endpoint with a distinctive body.
  for (const [flowName, expected] of [
    ["recovery", v.recovery],
    ["verification", v.verificationFlow],
  ]) {
    const r = await fetchJson(`${u.kratosPublic}/self-service/${flowName}/browser?return_to=${encodeURIComponent(`${u.loginUi}/ui/login`)}`);
    const enabled = r.status === 200;
    record(
      "behavior",
      `${flowName} flow ${expected ? "enabled" : "disabled"}`,
      enabled === expected,
      enabled === expected ? "" : `HTTP ${r.status}`,
    );
  }
}

// ── Layer 2 probe: AAL / second-factor behaviour (R-7) ──────────────────────
//
// Layer 1 can only compare `SESSION_WHOAMI_REQUIRED_AAL` and the
// totp/lookup_secret switches against the same `expectedEnv()` that GENERATED
// the override, so a wrong binding in lib.mjs would deploy wrong and preflight
// green. This probe asks the deployment instead.
//
// It has to manufacture an AAL2-capable identity to see anything at all: under
// `highest_available` kratos compares the session's AAL against the AAL the
// IDENTITY can reach, so a password-only identity is accepted under
// `highest_available` and `aal1` alike (ory/kratos@64e04ac, tag v25.4.0,
// session/manager_http.go:337-398). Enrolling lookup_secret is what makes the
// two settings observably different — and lookup_secret is enabled exactly when
// the required AAL is `highest_available` on a local-idp row (matrix/lib.mjs
// `derive()`: lookup = seq ∨ (mfa ∧ local); aal = seq ∨ (local ∧ mfa)).
//
// RESPONSE SHAPE ASSERTED: HTTP **403** from `/sessions/whoami` for the AAL1
// session and **200** for the AAL2 one. 403 is hard-coded by
// `NewErrAALNotSatisfied` (ory/kratos@64e04ac session/manager.go:102-116,
// written out by session/handler.go:234-241). The error ID is only REPORTED,
// never asserted: it is `session_aal2_required` at this pin
// (`text.ErrIDHigherAALRequired`, ory/kratos@64e04ac text/message_error.go:19)
// but other versions report `NoActiveSessionOnAal2`, and pinning it would make
// the tripwire version-fragile for no extra signal — the status already carries
// the whole observable distinction (403 refused vs 200 accepted).
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

  const email = `matrix-verify-aal-${randomUUID()}@test.example`;
  // Random hex sharing no prefix with the identifier: kratos rejects passwords
  // that are too short or too similar to the identifier.
  const password = `${randomUUID().replaceAll("-", "")}Aa1!`;
  let identityId = null;
  try {
    const created = await fetchJson(`${u.kratosAdmin}/admin/identities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_id: u.identitySchemaId,
        credentials: { password: { config: { password } } },
        traits: { email, name: "Matrix", surname: "Verify" },
      }),
    });
    identityId = created.body?.id ?? null;
    if (created.status !== 201 || !identityId) {
      record("behavior", check, false, `throwaway identity not created: POST ${u.kratosAdmin}/admin/identities → HTTP ${created.status}${created.error ? ` (${created.error})` : ""}`);
      return;
    }

    const first = await nativeLogin(u, email, password);
    if (!first.token) {
      record("behavior", check, false, `native password login returned no session token (HTTP ${first.status})`);
      return;
    }
    // Control, not the assertion: a password-only identity tops out at AAL1, so
    // whoami accepts this session under either setting.
    const control = await whoami(u, first.token);
    if (control.status !== 200) {
      record("behavior", check, false, `whoami refused a fresh AAL1 session (HTTP ${control.status}) before any second factor existed`);
      return;
    }

    // Which second factors can actually be ENROLLED — the behavioural reading
    // of SELFSERVICE_METHODS_{TOTP,LOOKUP_SECRET}_ENABLED.
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

    // Confirming lookup_secret adds an AAL2 authentication method to the
    // ENROLLING session (ory/kratos@64e04ac
    // selfservice/strategy/lookup/settings.go:322-327), so `first` is now AAL2
    // and a second login is needed for a genuinely AAL1 session. Native login
    // still returns a token when the AAL is unsatisfied — it only nulls
    // `session.identity` (ory/kratos@64e04ac
    // selfservice/flow/login/hook.go:246-257) — so that second session exists.
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
    // A leaked identity would poison the seeder's fresh-mode wipe assumptions,
    // so a failed deletion is a FAILED check, not a swallowed error.
    if (identityId) {
      const deleted = await fetchJson(`${u.kratosAdmin}/admin/identities/${identityId}`, { method: "DELETE" });
      const gone = deleted.status === 204 || deleted.status === 404;
      record("behavior", "AAL probe identity deleted", gone, gone ? "" : `DELETE ${u.kratosAdmin}/admin/identities/${identityId} → HTTP ${deleted.status}${deleted.error ? ` (${deleted.error})` : ""} — LEAKED`);
    }
  }
}

/** Native (API) login: flow init, then a one-shot password submit. Same request
 *  shapes as tests/browser/helpers/kratos.ts `createSessionToken`, but records
 *  rather than throws. */
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

// `X-Session-Token` is read first and unconditionally by kratos
// (ory/kratos@64e04ac session/manager_http.go:210-231); the Bearer fallback is
// only reached when the request carries no session cookie.
const whoami = (u, token) => fetchJson(`${u.kratosPublic}/sessions/whoami`, { headers: { "X-Session-Token": token } });

const settingsSubmit = (u, flowId, token, payload) =>
  fetchJson(`${u.kratosPublic}/self-service/settings?flow=${flowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": token },
    body: JSON.stringify(payload),
  });

// ── Layer 2 probe: hydra access-token shape + token hook (R-7) ──────────────

const PROBE_CLIENT_ID = "matrix-verify-probe";
const PROBE_CLIENT_SECRET = "matrix-verify-probe-secret";
// Registered on the throwaway client so hydra will GRANT it, and authorized for
// nobody in openfga so hook-service must DENY it.
const PROBE_AUDIENCE = "https://matrix-verify-probe.invalid";

/** Decode a JWT payload. Claim SURFACE only — never a trust decision. */
function jwtClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** hook-service writes its extras under `ext` on access tokens but at the top
 *  level on ID tokens — documented on `readClaim` in
 *  tests/browser/helpers/jwt.ts — and hydra's introspection response nests them
 *  under `ext` too, so both shapes are accepted. */
function readClaim(claims, name) {
  if (!claims || typeof claims !== "object") return undefined;
  if (claims[name] !== undefined) return claims[name];
  const ext = claims.ext;
  return ext && typeof ext === "object" ? ext[name] : undefined;
}

/** Claim surface of a minted token: decoded directly on the jwt rows, read back
 *  through hydra's admin introspection on the opaque ones. */
async function tokenClaims(token, u) {
  const decoded = jwtClaims(token);
  if (decoded) return decoded;
  const introspected = await fetchJson(`${u.hydraAdmin}/admin/oauth2/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
  });
  return introspected.body;
}

// Mints with a throwaway hydra client and asserts two things about the result.
//
// 1. ACCESS-TOKEN SHAPE — the only honest probe for STRATEGIES_ACCESS_TOKEN; the
//    env var could be typo'd and silently ignored.
//
// 2. TOKEN HOOK. The strong assertion — "`groups` appears in a minted token iff
//    hook_service=present" — is not reachable from the verifier: hook-service
//    keys group membership on the user's email (on the client_id for service
//    accounts) and omits the `groups` key entirely when the member has none
//    (canonical/hook-service@295273b pkg/hooks/handlers.go:174-176), and the
//    verifier runs BEFORE the seeder, so no member exists. The ABSENT direction
//    is still asserted outright. For the PRESENT direction the probe asserts the
//    weaker but genuinely independent property that HYDRA IS CONFIGURED TO CALL
//    THE HOOK, by making the hook the only thing that can refuse the request:
//
//      client_credentials + a granted audience nobody is authorized for
//        → hook-service's deny-by-default answers 403
//          (canonical/hook-service@295273b pkg/hooks/service.go:203-241 and
//           :140-142, surfaced by pkg/hooks/handlers.go:103-109)
//        → hydra maps a 403 hook response to fosite.ErrAccessDenied, so the
//          token endpoint answers HTTP 403 `access_denied`
//          (ory/hydra@de9baaa9, tag v25.4.0, oauth2/token_hook.go:119-130)
//
//    With no hook configured nothing refuses that request and hydra mints a
//    token, so the check is two-sided. Any other outcome — notably hydra
//    rejecting the audience itself with HTTP 400 `invalid_*`, before a hook
//    could run — is a warned INCONCLUSIVE, not a failure: it means the
//    discriminator is unavailable here, not that the row drifted.
//
//    TODO(review): the stronger assertion (`groups` present iff
//    hook_service=present) needs a hook-service group whose member is this
//    throwaway client_id, created and torn down through hook-service's
//    /api/v0/authz API with a `hook-service:admin`-scoped token. That is
//    seeder-owned provisioning against a service with no verified group-delete
//    path, so it is deliberately not done here.
/** The seeded service client from the manifest, when one is readable. */
function manifestSvcClient(manifestPath) {
  if (!manifestPath) return null;
  try {
    const svc = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")).oauthClients?.svc;
    return svc?.clientId && svc?.clientSecret ? svc : null;
  } catch {
    return null;
  }
}

const tokenShape = (token) =>
  token.startsWith("ory_at_") ? "opaque" : /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? "jwt" : `unrecognized (${token.slice(0, 12)}…)`;

export async function verifyHydraTokens(v, caps, u) {
  const hookCheck = `token hook ${v.hook ? "wired" : "not wired"} (hook_service=${v.hook ? "present" : "absent"})`;
  if (!u.hydraPublic) {
    const why = "skipped: no HYDRA_PUBLIC_URL — nothing can mint a token";
    record("behavior", "access-token shape", false, why, { warn: true });
    record("behavior", hookCheck, false, why, { warn: true });
    return;
  }
  // Without the ADMIN API no throwaway client can be registered. The two
  // halves degrade differently:
  //  - access-token SHAPE only needs to mint and look, and the seed manifest's
  //    svc client (client_credentials) can do that — so with MANIFEST set the
  //    shape stays verified on exactly the lane that lacks the admin API.
  //  - the token-HOOK discriminator is a client with a granted-but-UNAUTHORIZED
  //    audience, so that the hook is the only thing that can refuse the mint
  //    (see the header comment). No seeded client carries such an audience —
  //    granting one would let suite journeys mint tokens the hook must deny —
  //    so registering the probe client is admin-only and the check warn-skips.
  if (!u.hydraAdmin) {
    const svc = manifestSvcClient(u.manifest);
    if (!svc) {
      const why =
        "skipped: no HYDRA_ADMIN_URL — no throwaway client can be registered, and no seed manifest with an oauthClients.svc entry is available (MANIFEST=<path>) to mint with instead";
      record("behavior", "access-token shape", false, why, { warn: true });
      record("behavior", hookCheck, false, why, { warn: true });
      return;
    }
    const res = await fetchJson(`${u.hydraPublic}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${svc.clientId}:${svc.clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    const token = res.body?.access_token ?? "";
    if (!token) {
      record("behavior", "access-token shape", false, `mint with the manifest's svc client (${svc.clientId}) failed: HTTP ${res.status}${res.body?.error ? ` (${res.body.error})` : res.error ? ` (${res.error})` : ""}`);
    } else {
      const shape = tokenShape(token);
      record(
        "behavior",
        `access-token shape ${caps.access_token_format}`,
        shape === caps.access_token_format,
        shape === caps.access_token_format ? `minted with the manifest's svc client (${svc.clientId})` : `minted token is ${shape} (manifest svc client)`,
      );
      // The absent-direction hook witness needs the claim surface; without the
      // admin introspection API that is only readable on jwt tokens.
      const claims = jwtClaims(token);
      if (!v.hook && claims) {
        const groups = readClaim(claims, "groups");
        record(
          "behavior",
          "no groups claim (hook_service=absent)",
          groups === undefined,
          groups === undefined ? "" : `minted token carries groups=${JSON.stringify(groups)} with no hook-service deployed`,
        );
      }
    }
    record(
      "behavior",
      hookCheck,
      false,
      "skipped: the hook discriminator is a client with a granted-but-unauthorized audience — no seeded client carries one, and registering it needs HYDRA_ADMIN_URL",
      { warn: true },
    );
    return;
  }
  const dropClient = () => fetch(`${u.hydraAdmin}/admin/clients/${PROBE_CLIENT_ID}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
  const mint = (body) =>
    fetchJson(`${u.hydraPublic}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${PROBE_CLIENT_ID}:${PROBE_CLIENT_SECRET}`).toString("base64")}`,
      },
      body,
    });

  try {
    await dropClient();
    const created = await fetchJson(`${u.hydraAdmin}/admin/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PROBE_CLIENT_ID,
        client_secret: PROBE_CLIENT_SECRET,
        grant_types: ["client_credentials"],
        response_types: ["token"],
        scope: "openid",
        audience: [PROBE_AUDIENCE],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    if (created.status !== 201) {
      const why = `probe client creation failed: HTTP ${created.status}${created.error ? ` (${created.error})` : ""}`;
      record("behavior", "access-token shape", false, why);
      record("behavior", hookCheck, false, why);
      return;
    }

    const tokenRes = await mint("grant_type=client_credentials&scope=openid");
    const token = tokenRes.body?.access_token ?? "";
    const shape = tokenShape(token);
    record(
      "behavior",
      `access-token shape ${caps.access_token_format}`,
      shape === caps.access_token_format,
      shape === caps.access_token_format ? "" : `minted token is ${shape}`,
    );

    const groups = token ? readClaim(await tokenClaims(token, u), "groups") : undefined;
    if (!v.hook) {
      record(
        "behavior",
        "no groups claim (hook_service=absent)",
        groups === undefined,
        groups === undefined ? "" : `minted token carries groups=${JSON.stringify(groups)} with no hook-service deployed`,
      );
    }

    const seen = groups === undefined
      ? "no groups claim yet (nothing is a member of a hook-service group pre-seed)"
      : `groups=${JSON.stringify(groups)}`;
    const audience = await mint(`grant_type=client_credentials&scope=openid&audience=${encodeURIComponent(PROBE_AUDIENCE)}`);
    const err = audience.body?.error ?? "";
    if (audience.status === 200) {
      record(
        "behavior",
        hookCheck,
        !v.hook,
        v.hook ? `hydra minted an audience-scoped client_credentials token that hook-service must have denied — the token hook is not in effect; ${seen}` : "",
      );
    } else if (audience.status === 403 && err === "access_denied") {
      record(
        "behavior",
        hookCheck,
        v.hook,
        v.hook ? `hook denied the unauthorized audience (403 access_denied); ${seen}` : "token issuance was intercepted with 403 access_denied on a row that declares no hook-service",
      );
    } else {
      record(
        "behavior",
        hookCheck,
        false,
        `inconclusive: audience-scoped mint → HTTP ${audience.status} ${err || "(no error code)"} — nothing reached a token hook, so wired-vs-unwired is unobservable here`,
        { warn: true },
      );
    }
  } finally {
    await dropClient();
  }
}

// Mail capability probe: rows declare mail_api (mailslurper on both backends
// today); a hand-written capabilities file for a mail-less target declares
// false and the suite gates mail-dependent scenarios off at runtime.
async function verifyMailApi(caps, u) {
  if (!(caps.mail_api ?? true)) {
    record("behavior", "mail api declared absent", true, "mail_api=false — mail-dependent scenarios (recovery/verification/registration) will gate off");
    return;
  }
  const mailApiUrl = u.mailApi;
  if (!mailApiUrl) {
    record("behavior", "mail api reachable", false, "capabilities declare mail_api=true but MAIL_API_URL is unset");
    return;
  }
  try {
    const r = await fetchJson(`${mailApiUrl}/mail?pagenumber=1`);
    const ok = r.status === 200 && r.body !== null;
    record("behavior", "mail api reachable", ok, ok ? "" : `GET ${mailApiUrl}/mail?pagenumber=1 → HTTP ${r.status}${r.body === null ? " (non-JSON body)" : ""}`);
  } catch (err) {
    record("behavior", "mail api reachable", false, `GET ${mailApiUrl}/mail?pagenumber=1 → ${err?.cause?.code ?? err}`);
  }
}
// Device-flow capability probe (RFC 8628, §10 item 10). Credential-free
// discriminator: GET /oauth2/device/verify (no user_code) makes hydra
// redirect to urls.device.verification — a Location naming /ui/device_code
// proves the URLs are configured, while an unset urls.device falls through
// to hydra's built-in "configuration key missing" error page (no such
// redirect). Works through a public ingress, so it runs on the urls backend
// with zero credentials (measured 2026-08-31 on compose and iam.orange:
// both answer 302 → /ui/device_code).
async function verifyDeviceFlow(caps, u) {
  const declared = caps.device_flow ?? false;
  if (!u.hydraPublic) {
    record("behavior", `device flow ${declared ? "wired" : "absent"}`, false, "skipped: no HYDRA_PUBLIC_URL — hydra's device endpoint cannot be asked", { warn: true });
    return;
  }
  let res;
  try {
    res = await fetch(`${u.hydraPublic}/oauth2/device/verify`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    record("behavior", `device flow ${declared ? "wired" : "absent"}`, false, `GET ${u.hydraPublic}/oauth2/device/verify → ${err?.cause?.message ?? err?.message ?? err}`);
    return;
  }
  const location = res.headers.get("location") ?? "";
  const wired = res.status >= 300 && res.status < 400 && location.includes("/ui/device_code");
  record(
    "behavior",
    `device flow ${declared ? "wired" : "absent"}`,
    wired === declared,
    wired === declared
      ? (declared ? `verify endpoint redirects to ${location.split("?")[0]}` : "verify endpoint does not redirect to a device page")
      : declared
        ? `declared device_flow=true but GET /oauth2/device/verify → HTTP ${res.status}${location ? ` Location ${location.split("?")[0]}` : " (no device redirect)"} — hydra's urls.device is not configured`
        : `declared device_flow=false but the verify endpoint redirects to ${location.split("?")[0]} — the grant is wired`,
  );
}


// ── Layer 3: self-report ────────────────────────────────────────────────────

// Keys /api/v0/app-config serves truthfully — WHEN IT SERVES THEM. A key that
// is present and disagrees with the declaration is a harness/deployment
// failure. A key the running login-ui does not emit at all is a version fact
// about the endpoint, i.e. the PD-5 class, and is reported as drift instead:
// `multi_tenancy_enabled` only entered the payload in login-ui v0.27.0
// (canonical/identity-platform-login-ui@973f960 pkg/status/handlers.go
// `DeploymentInfo.MultiTenancyEnabled`; absent at @48a7049 = v0.26.0), and
// `flags` in v0.24.0 (@72d4b5b; absent at @b964996 = v0.23.1). Failing a row
// because the deployment predates a field would make mode 5 unusable against
// exactly the deployments it exists for — and gating never reads this endpoint
// anyway: the declaration is the gating source (BROWSER_TEST_CAPABILITIES).
const TRUTHFUL_KEYS = ["multi_tenancy_enabled", "oidc_webauthn_sequencing_enabled", "identifier_first_enabled", "base_url"];

async function verifySelfReport(caps, u) {
  let appConfig;
  try {
    const r = await fetchJson(`${u.loginUi}/api/v0/app-config`);
    // `fetchJson` reports a transport failure as status 0 plus the cause; drop
    // the cause and every TLS problem in this lane reads as a bare "HTTP 0".
    if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
    appConfig = r.body;
  } catch (err) {
    record("self-report", "app-config reachable", false, `GET ${u.loginUi}/api/v0/app-config → ${err.message ?? err}`);
    return;
  }

  const omitted = [];
  for (const key of TRUTHFUL_KEYS) {
    if (!(key in appConfig)) {
      omitted.push(key);
      continue;
    }
    // base_url is substrate-dependent (compose: http://localhost; juju: the
    // ingress LB) — when the runner supplies LOGIN_UI_URL, that IS the
    // declared base for this run, overriding the capabilities file's value.
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

// ── Layer 1 (juju backend): charm config + relation topology ────────────────

function juju(args) {
  const r = spawnSync("juju", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const MATRIX_APPS = [
  "kratos", "hydra", "login-ui", "tenant-service", "hook-service",
  "user-verification-service", "idp-dex", "idp-dex2",
];

function relatedApps(statusJson, app, endpoint) {
  const rel = statusJson.applications?.[app]?.relations?.[endpoint] ?? [];
  return rel.map((e) => (typeof e === "string" ? e : e["related-application"])).filter(Boolean);
}

function verifyJuju(dims, tfvars) {
  const status = juju(["status", "-m", JUJU_MODEL, "--format", "json"]);
  if (!status.ok) {
    record("juju", "model status readable", false, status.err);
    return;
  }
  const s = JSON.parse(status.out);

  for (const app of MATRIX_APPS) {
    const st = s.applications?.[app]?.["application-status"]?.current;
    record("juju", `${app} active`, st === "active", st === "active" ? "" : `status: ${st ?? "missing"}`);
  }

  // Charm config must equal the row's declared values — the charm renders
  // service config from these, so this is the juju analog of the env check.
  for (const [app, expected] of [
    ["kratos", tfvars.kratos_config],
    ["hydra", tfvars.hydra_config],
    ["idp-dex", { enabled: tfvars.idp_dex_enabled ? "true" : "false" }],
    ["idp-dex2", { enabled: tfvars.idp_dex2_enabled ? "true" : "false" }],
  ]) {
    if (Object.keys(expected).length === 0) continue;
    const cfg = juju(["config", "-m", JUJU_MODEL, app, "--format", "json"]);
    if (!cfg.ok) {
      record("juju", `${app} config readable`, false, cfg.err);
      continue;
    }
    const settings = JSON.parse(cfg.out).settings ?? {};
    const bad = Object.entries(expected)
      .filter(([k, v]) => String(settings[k]?.value) !== String(v))
      .map(([k, v]) => `${k}: want ${v}, got ${settings[k] === undefined ? "<no such option>" : String(settings[k]?.value)}`);
    record("juju", `${app} config (${Object.keys(expected).length} option(s))`, bad.length === 0, bad.join("; "));
  }

  // Relation topology: the presence dimensions ARE relations in this backend.
  const relations = [
    ["login-ui", "tenant-service-info", "tenant-service", tfvars.relate_tenant, "multi-tenancy"],
    ["kratos", "kratos-registration-webhook", "tenant-service", tfvars.relate_tenant, "tenant registration webhook"],
    ["kratos", "kratos-login-webhook", "tenant-service", tfvars.relate_tenant, "tenant login webhook"],
    ["hydra", "hydra-token-hook", "hook-service", tfvars.relate_hook, "token hook"],
    ["hook-service", "tenant-service-info", "tenant-service", tfvars.relate_tenant && tfvars.relate_hook, "tenant_id claim"],
    ["kratos", "kratos-registration-webhook", "user-verification-service", tfvars.relate_uvs, "uvs registration webhook"],
    ["kratos", "ui-endpoint-info", "user-verification-service", tfvars.relate_uvs, "uvs registration endpoint"],
  ];
  for (const [app, endpoint, peer, expected, label] of relations) {
    const present = relatedApps(s, app, endpoint).includes(peer);
    record(
      "juju",
      `${label} relation ${expected ? "present" : "absent"} (${app}:${endpoint} ↔ ${peer})`,
      present === expected,
      present === expected ? "" : `relation is ${present ? "present" : "absent"}`,
    );
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function verifyRow(rowName, backend = process.env.MATRIX_BACKEND ?? "compose", rowEnv = {}) {
  // The row's environment is a PARAMETER, not ambient state: `run-row --all`
  // must not leak row 1's discovered URLs into row 2.
  const u = resolveUrls(rowEnv, backend);
  // Multi-row processes (run-row --all) import this module ONCE; the
  // results buffer must reset per verification or verdicts accumulate
  // across rows and every later row fails on its predecessors' history.
  resetResults();
  const matrix = JSON.parse(fs.readFileSync(path.join(HERE, "matrix.json"), "utf-8"));
  const row = matrix.rows.find((r) => r.name === rowName);
  if (!row) throw new Error(`no such row: ${rowName} (see matrix/matrix.json)`);
  if (row.kind === "pinned") throw new Error(`${rowName} is a pinned profile — it runs through \`make gate\`, not the matrix lane`);
  const rawCaps = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "capabilities.json"), "utf-8"));
  // Backend-divergent keys (e.g. the second oidc provider: compose renders
  // dex+google, juju renders dex+dex2) live under a `juju` sub-object -
  // flatten for the active backend so every check compares lane truth.
  const caps = backend === "juju" ? { ...rawCaps, ...(rawCaps.juju ?? {}) } : rawCaps;

  console.log(`Verifying deployment against row: ${rowName} (backend: ${backend})`);
  console.log(`  ${Object.entries(row.dims).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  if (backend === "urls") {
    // No substrate access in the urls backend — layers 2-3 (behavior +
    // self-report) are already env-URL-driven and carry the verification.
    console.log("layer 1: SKIPPED (urls backend - no substrate access)");
  } else if (backend === "juju") {
    // Guardrail: this workstation also has a production JIMM controller
    // registered — refuse to run juju commands unless the RESOLVED
    // controller is the allowed one (matrix/controller-guard.mjs).
    assertController();
    const tfvars = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "juju.tfvars.json"), "utf-8"));
    verifyJuju(row.dims, tfvars);
  } else {
    verifyCompose(row.dims);
    // Add-on status endpoints are host-published in compose; in the juju
    // backend the apps are always running (presence = relations), so this
    // check is compose-only.
    for (const [dim, svc] of Object.entries(TOGGLED_SERVICES)) {
      const declared = row.dims[dim] === "present";
      const up = await reachable(`${u.serviceStatus[svc]}/api/v0/status`);
      record(
        "compose",
        `${svc} status endpoint ${declared ? "reachable" : "unreachable"}`,
        up === declared,
        up === declared ? "" : `declared ${row.dims[dim]}, endpoint ${up ? "reachable" : "unreachable"}`,
      );
    }
  }
  await verifyBehavior(row.dims, caps, u, backend);
  await verifySelfReport(caps, u);

  const failures = results.filter((r) => !r.ok && !r.warn);
  const warnings = results.filter((r) => !r.ok && r.warn);
  console.log(
    `\n${failures.length === 0 ? "✓" : "✗"} ${results.length} checks: ` +
      `${results.filter((r) => r.ok).length} ok, ${failures.length} failed, ${warnings.length} warning(s)`,
  );
  if (failures.length > 0) {
    console.error(`✗ deployment does not match declaration '${rowName}' — refusing to test against it:`);
    for (const f of failures) console.error(`    [${f.layer}] ${f.check}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  return failures.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const backendArg = args.find((a) => a.startsWith("--backend="))?.split("=")[1];
  const rowName = args.find((a) => !a.startsWith("--"));
  if (!rowName) {
    console.error("usage: node matrix/verify.mjs <row-name> [--backend=compose|juju|urls]");
    process.exit(2);
  }
  verifyRow(rowName, backendArg ?? process.env.MATRIX_BACKEND ?? "compose").then((ok) => process.exit(ok ? 0 : 1), (err) => {
    console.error(String(err));
    process.exit(2);
  });
}
