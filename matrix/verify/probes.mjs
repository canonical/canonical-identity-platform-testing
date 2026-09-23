// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Layer 2: live behaviour probes — the only INDEPENDENT witness (layer 1
// compares container env against the same expectedEnv() that generated it).
// Catches env keys the service silently ignores by probing kratos flows, the
// AAL a real session is held to, and hydra's token shape and hook.

import { derive } from "../lib.mjs";
import { record, fetchJson } from "./record.mjs";
import { verifyAalBehavior } from "./probe-aal.mjs";
import { verifyHydraTokens } from "./probe-hydra-tokens.mjs";

const groupsOf = (flow) => new Set((flow?.ui?.nodes ?? []).map((n) => n.group));
const oidcProvidersOf = (flow) =>
  (flow?.ui?.nodes ?? [])
    .filter((n) => n.group === "oidc" && n.attributes?.name === "provider")
    .map((n) => n.attributes.value)
    .sort();

const returnTo = (u) => `return_to=${encodeURIComponent(`${u.loginUi}/ui/login`)}`;

// Gate: prove kratos answers directly before reading flow config off it. An
// ingress fronting the login-ui BFF answers 404 for BFF routes it lacks
// (a login-ui VERSION fact), while kratos never 404s a disabled flow
// (ory/kratos@64e04ac selfservice/flow/registration/handler.go:113-115).
// /self-service/login/api is the discriminator: the BFF has never routed it.
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

/** The login flow as the BROWSER gets it when kratos is only reachable behind
 *  the BFF (303 to /ui/login?flow=<id>, flow served at /self-service/login/flows?id=). */
async function loginFlowThroughBff(u) {
  const init = await fetch(`${u.kratosPublic}/self-service/login/browser?${returnTo(u)}`, {
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

/** Login STYLE off the flow's first step (docs/testing-spec.md §10 item 14):
 *  identifier_first puts an `identifier` field + `method=identifier_first`
 *  submit and no credential node on step 1 (ory/kratos@64e04ac
 *  selfservice/strategy/idfirst/strategy_login.go:175-193); the unified style
 *  puts `password` on step 1 (selfservice/strategy/password/login.go:208-213,
 *  switch at driver/config/config.go:1601-1603). */
function recordLoginStyle(check, flow, caps) {
  const nodes = flow?.ui?.nodes ?? [];
  const idFirstSubmit = nodes.some((n) => n.attributes?.name === "method" && n.attributes?.value === "identifier_first");
  const passwordOnStepOne = nodes.some((n) => n.attributes?.name === "password");
  const identifierFirst = idFirstSubmit && !passwordOnStepOne;
  const want = caps.identifier_first_enabled === true;
  const ok = identifierFirst === want;
  record(
    "behavior",
    check,
    ok,
    ok
      ? ""
      : `step 1 carries ${idFirstSubmit ? "a method=identifier_first submit" : "no identifier_first submit"}` +
        ` and ${passwordOnStepOne ? "a password node" : "no password node"} — ` +
        `the ${identifierFirst ? "identifier-first" : "deprecated one-step (unified)"} shape, declared ${want ? "identifier-first" : "one-step"}`,
  );
}

async function verifyKratosFlowShape(v, caps, u) {
  // Registration is two-step: step 1 is method-agnostic (the `profile`
  // chooser is rendered unconditionally, so it is not a local-idp
  // discriminator); credential methods appear on the step reached via
  // method=profile. No identity is created.
  const regRes = await fetch(`${u.kratosPublic}/self-service/registration/browser?${returnTo(u)}`, {
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
      // No two-step chooser: credential nodes live on step 1 directly.
      record(
        "behavior",
        `password method ${v.password ? "enabled" : "disabled"}`,
        g1.has("password") === v.password,
        g1.has("password") === v.password ? "" : `registration flow ${g1.has("password") ? "offers" : "lacks"} password nodes`,
      );
    }
  }

  // The login-ui BFF rejects a login-flow init without return_to
  // (canonical/identity-platform-login-ui@197703c pkg/kratos/handlers.go:101-104).
  const login = await fetchJson(`${u.kratosPublic}/self-service/login/browser?${returnTo(u)}`);
  if (login.status !== 200) {
    record("behavior", "login flow creatable", false, `HTTP ${login.status}`);
  } else {
    recordProviderSet("login flow provider set", login.body, caps, "the login flow");
    recordLoginStyle("login style identifier-first", login.body, caps);
  }

  // Flow toggles: kratos 404s a disabled endpoint with a distinctive body.
  for (const [flowName, expected] of [
    ["recovery", v.recovery],
    ["verification", v.verificationFlow],
  ]) {
    const r = await fetchJson(`${u.kratosPublic}/self-service/${flowName}/browser?${returnTo(u)}`);
    const enabled = r.status === 200;
    record(
      "behavior",
      `${flowName} flow ${expected ? "enabled" : "disabled"}`,
      enabled === expected,
      enabled === expected ? "" : `HTTP ${r.status}`,
    );
  }
}

// Rows declare mail_api; a mail-less target declares false and the suite gates mail scenarios off.
export async function verifyMailApi(caps, u) {
  if (!(caps.mail_api ?? true)) {
    record("behavior", "mail api declared absent", true, "mail_api=false — mail-dependent scenarios (recovery/verification/registration) will gate off");
    return;
  }
  const mailApiUrl = u.mailApi;
  if (!mailApiUrl) {
    // Through a public ingress with no admin URL the suite runs the live lane,
    // which never reads mail: nothing to reach, so warn instead of failing the row.
    const liveOnly = u.publicOnly && !u.kratosAdmin;
    record(
      "behavior",
      "mail api reachable",
      false,
      liveOnly
        ? "skipped: no MAIL_API_URL — public-ingress live lane reads no mail"
        : "capabilities declare mail_api=true but MAIL_API_URL is unset",
      { warn: liveOnly },
    );
    return;
  }
  const r = await fetchJson(`${mailApiUrl}/mail?pagenumber=1`);
  const ok = r.status === 200 && r.body !== null;
  record("behavior", "mail api reachable", ok, ok ? "" : `GET ${mailApiUrl}/mail?pagenumber=1 → HTTP ${r.status}${r.error ? ` (${r.error})` : r.body === null ? " (non-JSON body)" : ""}`);
}

// Device flow (RFC 8628; docs/testing-spec.md §10 item 10). Credential-free:
// GET /oauth2/device/verify without user_code redirects to urls.device.verification
// (/ui/device_code) when configured; unset urls.device falls through to hydra's error page.
async function verifyDeviceFlow(caps, u) {
  const declared = caps.device_flow ?? false;
  const check = `device flow ${declared ? "wired" : "absent"}`;
  if (!u.hydraPublic) {
    record("behavior", check, false, "skipped: no HYDRA_PUBLIC_URL — hydra's device endpoint cannot be asked", { warn: true });
    return;
  }
  let res;
  try {
    res = await fetch(`${u.hydraPublic}/oauth2/device/verify`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    record("behavior", check, false, `GET ${u.hydraPublic}/oauth2/device/verify → ${err?.cause?.message ?? err?.message ?? err}`);
    return;
  }
  const location = res.headers.get("location") ?? "";
  const page = location.split("?")[0];
  const wired = res.status >= 300 && res.status < 400 && location.includes("/ui/device_code");
  record(
    "behavior",
    check,
    wired === declared,
    wired === declared
      ? (declared ? `verify endpoint redirects to ${page}` : "verify endpoint does not redirect to a device page")
      : declared
        ? `declared device_flow=true but GET /oauth2/device/verify → HTTP ${res.status}${location ? ` Location ${page}` : " (no device redirect)"} — hydra's urls.device is not configured`
        : `declared device_flow=false but the verify endpoint redirects to ${page} — the grant is wired`,
  );
}

export async function verifyBehavior(dims, caps, u, backend) {
  const v = derive(dims);

  const direct = await kratosAnswersDirectly(u);
  if (direct.ok) {
    await verifyKratosFlowShape(v, caps, u);
  } else if (backend === "urls" || u.publicOnly) {
    // The normal shape through a public ingress: warn, name what went unasked, keep the BFF witness.
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
        recordLoginStyle("login style identifier-first (through the login-ui BFF)", flow, caps);
      } else {
        record("behavior", "login flow readable through the login-ui BFF", false, why);
      }
    }
  } else {
    // compose and juju both publish kratos's public port: this is a broken deployment.
    record("behavior", "kratos public API answers directly", false, direct.why);
  }

  // Layer 1 can only compare env against the expectedEnv() that generated it; these ask the deployment.
  await verifyAalBehavior(v, u);
  await verifyHydraTokens(v, caps, u);

  await verifyMailApi(caps, u);
  await verifyDeviceFlow(caps, u);
}
