// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Layer 2 probe: hydra access-token shape + token hook, minted with a
// throwaway hydra client.
//
// Token hook: "`groups` iff hook_service=present" is unreachable pre-seed
// (hook-service omits the key for non-members, canonical/hook-service@295273b
// pkg/hooks/handlers.go:174-176), so the ABSENT direction is asserted outright
// and the PRESENT direction asserts that hydra CALLS the hook: a granted but
// unauthorized audience is refused 403 by hook-service's deny-by-default
// (canonical/hook-service@295273b pkg/hooks/service.go:203-241) and hydra
// surfaces it as HTTP 403 access_denied (ory/hydra@de9baaa9 oauth2/token_hook.go:119-130).
// Any other outcome is a warned INCONCLUSIVE, not a failure.

import * as fs from "node:fs";
import * as path from "node:path";
import { record, fetchJson } from "./record.mjs";

const PROBE_CLIENT_ID = "matrix-verify-probe";
const PROBE_CLIENT_SECRET = "matrix-verify-probe-secret";
// Granted on the throwaway client, authorized for nobody in openfga.
const PROBE_AUDIENCE = "https://matrix-verify-probe.invalid";

// ── mint ────────────────────────────────────────────────────────────────────

/** client_credentials mint with HTTP basic client auth. */
function minter(u, clientId, clientSecret) {
  return (body) =>
    fetchJson(`${u.hydraPublic}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body,
    });
}

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

const dropProbeClient = (u) =>
  fetch(`${u.hydraAdmin}/admin/clients/${PROBE_CLIENT_ID}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});

const registerProbeClient = (u) =>
  fetchJson(`${u.hydraAdmin}/admin/clients`, {
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

// ── decode ──────────────────────────────────────────────────────────────────

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

/** Extras sit under `ext` on access tokens and introspection, top-level on ID tokens. */
function readClaim(claims, name) {
  if (!claims || typeof claims !== "object") return undefined;
  if (claims[name] !== undefined) return claims[name];
  const ext = claims.ext;
  return ext && typeof ext === "object" ? ext[name] : undefined;
}

/** Claim surface: decoded directly on jwt rows, via admin introspection on opaque ones. */
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

// ── shape checks ────────────────────────────────────────────────────────────

const tokenShape = (token) =>
  token.startsWith("ory_at_") ? "opaque" : /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? "jwt" : `unrecognized (${token.slice(0, 12)}…)`;

function recordTokenShape(caps, token, okDetail = "", mismatchSuffix = "") {
  const shape = tokenShape(token);
  const ok = shape === caps.access_token_format;
  record("behavior", `access-token shape ${caps.access_token_format}`, ok, ok ? okDetail : `minted token is ${shape}${mismatchSuffix}`);
}

/** Absent direction: no hook-service, so nothing may have written `groups`. */
function recordNoGroupsClaim(groups) {
  record(
    "behavior",
    "no groups claim (hook_service=absent)",
    groups === undefined,
    groups === undefined ? "" : `minted token carries groups=${JSON.stringify(groups)} with no hook-service deployed`,
  );
}

// ── hook witness ────────────────────────────────────────────────────────────

/** hook-service's prometheus counter for hydra's hook route; null when no
 *  hook-service answers. */
async function hookCallCount(u) {
  const base = u.serviceStatus?.["hook-service"];
  if (!base) return null;
  const res = await fetch(`${base}/api/v0/metrics`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) return null;
  const text = await res.text();
  let total = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const m = line.match(/^http_response_time_seconds_count\{([^}]*)\}\s+(\d+)/);
    if (m && m[1].includes('route="POST/api/v0/hook/hydra"')) {
      total += Number(m[2]);
      seen = true;
    }
  }
  return seen ? total : 0;
}

/** Two witnesses that hydra calls the hook: (a) DENIAL of the unauthorized
 *  audience when hook-service runs with authorization ON; (b) the prometheus
 *  counter for `POST /api/v0/hook/hydra` advancing when authorization is OFF
 *  (compose default; canonical/hook-service@295273b cmd/serve.go:117-124 allows all). */
async function witnessHookCall(v, u, mint, hookCheck, groups) {
  const seen = groups === undefined
    ? "no groups claim yet (nothing is a member of a hook-service group pre-seed)"
    : `groups=${JSON.stringify(groups)}`;
  const before = await hookCallCount(u);
  const audience = await mint(`grant_type=client_credentials&scope=openid&audience=${encodeURIComponent(PROBE_AUDIENCE)}`);
  const err = audience.body?.error ?? "";
  if (audience.status === 200) {
    const after = await hookCallCount(u);
    const called = before !== null && after !== null && after > before;
    record(
      "behavior",
      hookCheck,
      v.hook ? called : !called,
      v.hook
        ? called
          ? `hook-service allowed the audience (authorization off) but its hook counter advanced ${before}→${after}: hydra called it; ${seen}`
          : `hydra minted an audience-scoped client_credentials token and hook-service's hook counter did not advance (${before}→${after}) — the token hook is not in effect; ${seen}`
        : called
          ? `a hook-service answered hydra's hook call (counter ${before}→${after}) on a row that declares no hook-service`
          : "",
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
}

// ── orchestration ───────────────────────────────────────────────────────────

/** Without the ADMIN API no throwaway client can be registered. Token SHAPE
 *  can still mint with the manifest's svc client; the HOOK discriminator needs
 *  a granted-but-unauthorized audience no seeded client carries, so it warn-skips. */
async function verifyWithManifestClient(v, caps, u, hookCheck) {
  const svc = manifestSvcClient(u.manifest);
  if (!svc) {
    const why =
      "skipped: no HYDRA_ADMIN_URL — no throwaway client can be registered, and no seed manifest with an oauthClients.svc entry is available (MANIFEST=<path>) to mint with instead";
    record("behavior", "access-token shape", false, why, { warn: true });
    record("behavior", hookCheck, false, why, { warn: true });
    return;
  }
  const res = await minter(u, svc.clientId, svc.clientSecret)("grant_type=client_credentials");
  const token = res.body?.access_token ?? "";
  if (!token) {
    record("behavior", "access-token shape", false, `mint with the manifest's svc client (${svc.clientId}) failed: HTTP ${res.status}${res.body?.error ? ` (${res.body.error})` : res.error ? ` (${res.error})` : ""}`);
  } else {
    recordTokenShape(caps, token, `minted with the manifest's svc client (${svc.clientId})`, " (manifest svc client)");
    // Without admin introspection the claim surface is only readable on jwt tokens.
    const claims = jwtClaims(token);
    if (!v.hook && claims) recordNoGroupsClaim(readClaim(claims, "groups"));
  }
  record(
    "behavior",
    hookCheck,
    false,
    "skipped: the hook discriminator is a client with a granted-but-unauthorized audience — no seeded client carries one, and registering it needs HYDRA_ADMIN_URL",
    { warn: true },
  );
}

export async function verifyHydraTokens(v, caps, u) {
  const hookCheck = `token hook ${v.hook ? "wired" : "not wired"} (hook_service=${v.hook ? "present" : "absent"})`;
  if (!u.hydraPublic) {
    const why = "skipped: no HYDRA_PUBLIC_URL — nothing can mint a token";
    record("behavior", "access-token shape", false, why, { warn: true });
    record("behavior", hookCheck, false, why, { warn: true });
    return;
  }
  if (!u.hydraAdmin) {
    await verifyWithManifestClient(v, caps, u, hookCheck);
    return;
  }

  const mint = minter(u, PROBE_CLIENT_ID, PROBE_CLIENT_SECRET);
  try {
    await dropProbeClient(u);
    const created = await registerProbeClient(u);
    if (created.status !== 201) {
      const why = `probe client creation failed: HTTP ${created.status}${created.error ? ` (${created.error})` : ""}`;
      record("behavior", "access-token shape", false, why);
      record("behavior", hookCheck, false, why);
      return;
    }

    const token = (await mint("grant_type=client_credentials&scope=openid")).body?.access_token ?? "";
    recordTokenShape(caps, token);

    const groups = token ? readClaim(await tokenClaims(token, u), "groups") : undefined;
    if (!v.hook) recordNoGroupsClaim(groups);

    await witnessHookCall(v, u, mint, hookCheck, groups);
  } finally {
    await dropProbeClient(u);
  }
}
