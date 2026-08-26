// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// verify.mjs robustness: behavior probes against an unreachable deployment
// must record a failed CHECK, never crash the runner (a raw undici throw
// once killed a --all loop mid-flight).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import { fetchJson, verifyAalBehavior, verifyHydraTokens, resetResults, recordedResults } from "../verify.mjs";
import { derive } from "../lib.mjs";

// Connection refused, immediately. Ports 1 and 9 are on the WHATWG bad-port
// list, so fetch() rejects them before it ever connects — which would exercise
// a different error path from the one a dead deployment produces.
const DEAD = "http://127.0.0.1:45999";

const deadUrls = () => ({
  kratosPublic: DEAD,
  kratosAdmin: DEAD,
  identitySchemaId: "default",
  hydraPublic: DEAD,
  hydraAdmin: DEAD,
});

const dims = (over = {}) => ({
  local_idp: "on",
  mfa: "enforced",
  verification: "on",
  webauthn: null,
  providers: "1",
  tenant_service: "absent",
  hook_service: "absent",
  user_verification: "absent",
  access_token: "jwt",
  ...over,
});

/** Run a probe with a clean buffer and hand back what it recorded. */
async function probe(fn) {
  resetResults();
  await fn();
  return recordedResults();
}

test("fetchJson returns status 0 + error on connection refused", async () => {
  const res = await fetchJson("http://127.0.0.1:1/nope", { timeout: 500 });
  assert.equal(res.status, 0);
  assert.equal(res.body, null);
  assert.ok(res.error && typeof res.error === "string");
});
// (No black-holed-address case: the abort resolves the CALLER in exactly
// `timeout` ms — measured 300ms against TEST-NET-1 — but undici's orphaned
// socket keeps the event loop alive ~10s until its own connect timeout,
// which only slows tiny processes like this test file, never the runner.)

test("AAL probe records a failed check when the kratos admin API is unreachable", async () => {
  const results = await probe(() => verifyAalBehavior(derive(dims()), deadUrls()));
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.layer, "behavior");
  assert.equal(r.ok, false);
  assert.equal(r.warn, false);
  assert.match(r.check, /^whoami AAL enforcement/);
  assert.match(r.detail, /throwaway identity not created/);
  // Nothing was created, so nothing may be claimed as cleaned up.
  assert.equal(results.some((x) => x.check === "AAL probe identity deleted"), false);
});

test("AAL probe warns instead of failing when the backend has no admin URL", async () => {
  const results = await probe(() => verifyAalBehavior(derive(dims()), { ...deadUrls(), kratosAdmin: undefined }));
  assert.deepEqual(
    results.map((r) => [r.ok, r.warn]),
    [[false, true]],
  );
  assert.match(results[0].detail, /no KRATOS_ADMIN_URL/);
});

test("AAL probe warns instead of failing when local_idp is off", async () => {
  const results = await probe(() => verifyAalBehavior(derive(dims({ local_idp: "off" })), deadUrls()));
  assert.deepEqual(
    results.map((r) => [r.ok, r.warn]),
    [[false, true]],
  );
  assert.match(results[0].detail, /local_idp=off/);
});

test("token-hook probe records failed checks when hydra is unreachable", async () => {
  const results = await probe(() => verifyHydraTokens(derive(dims({ hook_service: "present" })), { access_token_format: "jwt" }, deadUrls()));
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok === false && r.warn === false), "both checks must FAIL, not warn");
  assert.deepEqual(results.map((r) => r.check), ["access-token shape", "token hook wired (hook_service=present)"]);
  assert.ok(results.every((r) => /probe client creation failed: HTTP 0/.test(r.detail)));
});

// The mode-5 counterpart of the AAL guard: on the `urls` backend a missing
// admin API is the documented reality, not a drifted row. Before this guard the
// probe aimed at localhost:4445 and failed every urls row on an unrelated
// socket.
test("token-hook probe warns instead of failing when the backend has no hydra admin URL", async () => {
  const results = await probe(() =>
    verifyHydraTokens(derive(dims({ hook_service: "present" })), { access_token_format: "jwt" }, { ...deadUrls(), hydraAdmin: undefined }),
  );
  assert.deepEqual(
    results.map((r) => [r.check, r.ok, r.warn]),
    [
      ["access-token shape", false, true],
      ["token hook wired (hook_service=present)", false, true],
    ],
  );
  assert.ok(results.every((r) => /no HYDRA_ADMIN_URL/.test(r.detail)));
});

// ── Token-hook decision table, against a stub hydra ─────────────────────────
//
// The wiring check is two-sided, so its polarity is worth defending: an
// audience-scoped client_credentials mint that comes back 403 access_denied
// means a token hook refused it, which PASSES a hook_service=present row and
// FAILS a hook_service=absent one.

/** Collect the request body, then answer JSON. */
function jsonServer(handle) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      handle(req, Buffer.concat(chunks).toString(), (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
  });
}

/** Bind a stub on a free loopback port, hand its URL to `run`, always close. */
async function serve(server, run) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Minimal hydra stand-in. `onAudienceMint` decides the audience-scoped reply. */
function withStubHydra(onAudienceMint, run) {
  const jwt = ["e30", Buffer.from(JSON.stringify({ sub: "matrix-verify-probe" })).toString("base64url"), "sig"].join(".");
  const server = jsonServer((req, body, send) => {
    if (req.method === "DELETE") return send(204, {});
    if (req.url === "/admin/clients") return send(201, { client_id: "matrix-verify-probe" });
    if (body.includes("audience=")) return onAudienceMint(send);
    return send(200, { access_token: jwt });
  });
  return serve(server, (url) => run({ ...deadUrls(), hydraPublic: url, hydraAdmin: url }));
}

const denyAudience = (send) => send(403, { error: "access_denied", error_description: "The token hook target responded with an error." });
const allowAudience = (send) => send(200, { access_token: "ory_at_stub" });
const rejectAudience = (send) => send(400, { error: "invalid_target", error_description: "Requested audience is not allowed." });

test("token hook check passes on a hook row when the audience mint is denied", async () => {
  const results = await withStubHydra(denyAudience, (u) =>
    probe(() => verifyHydraTokens(derive(dims({ hook_service: "present" })), { access_token_format: "jwt" }, u)),
  );
  const hook = results.find((r) => r.check.startsWith("token hook"));
  assert.equal(hook.ok, true);
  assert.match(hook.detail, /hook denied the unauthorized audience/);
});

test("token hook check fails on a hook row when the audience mint succeeds", async () => {
  const results = await withStubHydra(allowAudience, (u) =>
    probe(() => verifyHydraTokens(derive(dims({ hook_service: "present" })), { access_token_format: "jwt" }, u)),
  );
  const hook = results.find((r) => r.check.startsWith("token hook"));
  assert.equal(hook.ok, false);
  assert.equal(hook.warn, false);
  assert.match(hook.detail, /token hook is not in effect/);
});

test("token hook check fails on a hook-less row when a hook denies the audience mint", async () => {
  const results = await withStubHydra(denyAudience, (u) =>
    probe(() => verifyHydraTokens(derive(dims({ hook_service: "absent" })), { access_token_format: "jwt" }, u)),
  );
  const hook = results.find((r) => r.check.startsWith("token hook"));
  assert.equal(hook.ok, false);
  assert.equal(hook.warn, false);
  // The hook-less row also gets the outright negative assertion on the claim.
  assert.equal(results.find((r) => r.check === "no groups claim (hook_service=absent)").ok, true);
});

test("token hook check is a warned inconclusive when hydra refuses the audience itself", async () => {
  const results = await withStubHydra(rejectAudience, (u) =>
    probe(() => verifyHydraTokens(derive(dims({ hook_service: "present" })), { access_token_format: "jwt" }, u)),
  );
  const hook = results.find((r) => r.check.startsWith("token hook"));
  assert.equal(hook.ok, false);
  assert.equal(hook.warn, true, "an unavailable discriminator must not fail the row");
  assert.match(hook.detail, /inconclusive: audience-scoped mint → HTTP 400 invalid_target/);
});

// ── AAL decision table, against a stub kratos ───────────────────────────────
//
// The probe's whole point is the 403-vs-200 distinction on /sessions/whoami
// after a second factor exists, plus the guarantee that the throwaway identity
// is always deleted. Both are worth defending offline.

/** Minimal kratos stand-in. `methods` are the settings-flow groups on offer;
 *  `onDelete` decides how the cleanup call answers. Second-factor enrolment
 *  upgrades the ENROLLING session, so whoami refuses only later sessions. */
function withStubKratos({ methods = ["profile", "password"], onDelete = (send) => send(204, {}) }, run) {
  const issued = [];
  let enrolled = false;
  const server = jsonServer((req, body, send) => {
    const [route] = req.url.split("?");
    if (route === "/admin/identities") return send(201, { id: "stub-identity-id" });
    if (route.startsWith("/admin/identities/") && req.method === "DELETE") return onDelete(send);
    if (route === "/self-service/login/api") return send(200, { id: "login-flow" });
    if (route === "/self-service/login") {
      const token = `session-${issued.length}`;
      issued.push(token);
      return send(200, { session_token: token });
    }
    if (route === "/self-service/settings/api") {
      return send(200, { id: "settings-flow", ui: { nodes: methods.map((group) => ({ group })) } });
    }
    if (route === "/self-service/settings") {
      if (body.includes("lookup_secret_confirm")) enrolled = true;
      return send(200, { id: "settings-flow" });
    }
    if (route === "/sessions/whoami") {
      const token = req.headers["x-session-token"];
      if (enrolled && token !== issued[0]) return send(403, { error: { id: "session_aal2_required", code: 403 } });
      return send(200, { id: "stub-session", identity: { id: "stub-identity-id" } });
    }
    return send(404, {});
  });
  return serve(server, (url) => run({ ...deadUrls(), kratosPublic: url, kratosAdmin: url }));
}

test("AAL probe passes when an enforced row refuses an AAL1 session and accepts the AAL2 one", async () => {
  const results = await withStubKratos({ methods: ["profile", "password", "totp", "lookup_secret"] }, (u) =>
    probe(() => verifyAalBehavior(derive(dims({ mfa: "enforced" })), u)),
  );
  const byCheck = Object.fromEntries(results.map((r) => [r.check, r]));
  assert.equal(byCheck["totp method enabled"].ok, true);
  assert.equal(byCheck["lookup_secret method enabled"].ok, true);
  const aal = byCheck["whoami AAL enforcement (required_aal=highest_available)"];
  assert.equal(aal.ok, true);
  assert.match(aal.detail, /AAL1 session refused 403 \(session_aal2_required\), AAL2 session accepted/);
  assert.equal(byCheck["AAL probe identity deleted"].ok, true);
});

test("AAL probe fails an enforced row whose whoami still accepts an AAL1 session", async () => {
  // Same stub, but nothing is enrollable: the required-AAL claim is then
  // unprovable rather than proven, and must not be reported as a pass.
  const results = await withStubKratos({ methods: ["profile", "password"] }, (u) =>
    probe(() => verifyAalBehavior(derive(dims({ mfa: "enforced" })), u)),
  );
  const byCheck = Object.fromEntries(results.map((r) => [r.check, r]));
  assert.equal(byCheck["totp method enabled"].ok, false);
  assert.equal(byCheck["lookup_secret method enabled"].ok, false);
  const aal = byCheck["whoami AAL enforcement (required_aal=highest_available)"];
  assert.equal(aal.ok, false);
  assert.equal(aal.warn, true);
  assert.match(aal.detail, /cannot raise the identity to AAL2/);
  assert.equal(byCheck["AAL probe identity deleted"].ok, true);
});

test("AAL probe passes an mfa-off row only when no second factor is enrollable", async () => {
  const results = await withStubKratos({ methods: ["profile", "password"] }, (u) =>
    probe(() => verifyAalBehavior(derive(dims({ mfa: "off", webauthn: null })), u)),
  );
  const byCheck = Object.fromEntries(results.map((r) => [r.check, r]));
  assert.equal(byCheck["totp method disabled"].ok, true);
  assert.equal(byCheck["lookup_secret method disabled"].ok, true);
  assert.equal(byCheck["whoami AAL enforcement (required_aal=aal1)"].ok, true);
});

test("AAL probe fails an mfa-off row that still offers a second factor", async () => {
  const results = await withStubKratos({ methods: ["profile", "password", "totp", "lookup_secret"] }, (u) =>
    probe(() => verifyAalBehavior(derive(dims({ mfa: "off", webauthn: null })), u)),
  );
  const byCheck = Object.fromEntries(results.map((r) => [r.check, r]));
  assert.equal(byCheck["totp method disabled"].ok, false);
  assert.match(byCheck["totp method disabled"].detail, /settings flow offers totp/);
  assert.equal(byCheck["lookup_secret method disabled"].ok, false);
});

test("AAL probe records a FAILED check when the throwaway identity cannot be deleted", async () => {
  const results = await withStubKratos(
    { methods: ["profile", "password", "totp", "lookup_secret"], onDelete: (send) => send(500, {}) },
    (u) => probe(() => verifyAalBehavior(derive(dims({ mfa: "enforced" })), u)),
  );
  const deleted = results.find((r) => r.check === "AAL probe identity deleted");
  assert.equal(deleted.ok, false);
  assert.equal(deleted.warn, false, "a leaked identity poisons the seeder's fresh-mode wipe — it must be fatal");
  assert.match(deleted.detail, /HTTP 500.*LEAKED/);
});
