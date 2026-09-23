// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Offline tests for the matrix runner's pure logic: the feedback loop for
// harness changes stays in milliseconds. Run: `make matrix-test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyOutcome, collectTests, manifestSecrets, redact } from "../verdict.mjs";
import { buildAttachImports, relationExists, classifyDrift, ATTACH_INTEGRATIONS } from "../juju-backend.mjs";
import { selectRows, JUSTIFIED_SKIP, TIER_A_FILES } from "../run-row.mjs";
import { JUJU_RELATIONS } from "../verify/substrate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── classifyOutcome ──────────────────────────────────────────────────────────
// Playwright statuses: "expected" = passed, "unexpected" = FAILED. The
// `unexpected:` prefix in row output is Playwright DATA, not harness text;
// the tests pin the semantics.

const t = (file, title, status, reason = "") => ({ file, title, status, reason });
const expectedSet = (run) => ({ run: run.map(([file, id]) => ({ file: `specs/${file}`, id })) });

test("a failed test surfaces as 'unexpected: file › title'", () => {
  const failures = classifyOutcome(
    [t("oidc.spec.ts", "oidc-dex-login", "unexpected")],
    expectedSet([["oidc.spec.ts", "oidc-dex-login"]]),
  );
  assert.deepEqual(failures, ["unexpected: oidc.spec.ts › oidc-dex-login"]);
});

test("a flaky pass is a failure (retries are forbidden by contract)", () => {
  const failures = classifyOutcome(
    [t("login.spec.ts", "first-login-mfa", "flaky")],
    expectedSet([["login.spec.ts", "first-login-mfa"]]),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^flaky: /);
});

test("tier-A drift is flagged in BOTH directions", () => {
  const failures = classifyOutcome(
    [t("oidc.spec.ts", "oidc-session-reuse", "expected")],
    expectedSet([["oidc.spec.ts", "oidc-dex-login"]]),
  );
  assert.deepEqual(failures.sort(), [
    "executed but not in the expected set: oidc.spec.ts › oidc-session-reuse",
    "expected to run but did not: oidc.spec.ts › oidc-dex-login",
  ]);
});

test("tier-B executions are never drift (capability-gated hand-written specs may run)", () => {
  const failures = classifyOutcome(
    [t("recovery-code-abuse.spec.ts", "recovery-code-cross-browser-rejected", "expected")],
    expectedSet([]),
  );
  assert.deepEqual(failures, []);
});

test("tier-B skips need a justified reason; real reason shapes pass", () => {
  const justified = [
    "Skipped: requires mailApi=true, ActiveConfig mail_api=false",
    "requires MFA enforcement but the active deployment does not enforce a second factor",
    "requires totp 2FA but the active deployment steps up to webauthn (sequencing) or lacks the totp method",
    "hook-service not in active profile",
    "Internal-only spec in live lane",
    "scenario not compatible with lane \"live\"",
  ];
  for (const reason of justified) {
    assert.deepEqual(
      classifyOutcome([t("recovery-code-abuse.spec.ts", "x", "skipped", reason)], expectedSet([])),
      [],
      `reason should be justified: ${reason}`,
    );
  }
  const failures = classifyOutcome(
    [t("recovery-code-abuse.spec.ts", "x", "skipped", "TODO fix later")],
    expectedSet([]),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^unjustified skip: /);
});

test("JUSTIFIED_SKIP entries are all regexes (allowlist shape)", () => {
  assert.ok(JUSTIFIED_SKIP.length > 0);
  for (const re of JUSTIFIED_SKIP) assert.ok(re instanceof RegExp);
});

// ── buildAttachImports ───────────────────────────────────────────────────────
// The import IDs and their gating burned a full afternoon live; canned
// discovery keeps the table honest offline.

const IAM = "11111111-1111-1111-1111-111111111111";
const CORE = "22222222-2222-2222-2222-222222222222";

function discovery({ apps, relations = {}, coreRelations = {} }) {
  const statusOf = (rel) => ({
    applications: Object.fromEntries(
      Object.entries(rel).map(([app, endpoints]) => [
        app,
        {
          relations: Object.fromEntries(
            Object.entries(endpoints).map(([ep, peers]) => [
              ep,
              peers.map((p) => ({ "related-application": p })),
            ]),
          ),
        },
      ]),
    ),
  });
  return {
    iamUuid: IAM,
    coreUuid: CORE,
    apps: new Set(apps),
    offerUrls: {
      "traefik-route": "admin/iam-matrix-core.traefik-route",
      postgresql: "admin/iam-matrix-core.postgresql",
      "send-ca-cert": "admin/iam-matrix-core.send-ca-cert",
      openfga: "admin/iam-matrix-core.openfga",
      certificates: "admin/iam-matrix-core.certificates",
    },
    status: statusOf(relations),
    coreStatus: statusOf(coreRelations),
  };
}

test("models import by uuid; the send-ca-cert offer imports at BOTH addresses", () => {
  const imports = buildAttachImports(discovery({ apps: [] }), { tenant: false, hook: false, uvs: false });
  const byTo = Object.fromEntries(imports.map((i) => [i.to, i.id]));
  assert.equal(byTo["juju_model.iam"], IAM);
  assert.equal(byTo["juju_model.core"], CORE);
  assert.equal(byTo["juju_offer.send_ca_certificate"], "admin/iam-matrix-core.send-ca-cert");
  assert.equal(byTo["module.certificates.juju_offer.send_ca_cert"], "admin/iam-matrix-core.send-ca-cert");
});

test("apps import as <model-uuid>:<name> with the right model per app", () => {
  const imports = buildAttachImports(
    discovery({ apps: ["kratos", "traefik-public"] }),
    { tenant: false, hook: false, uvs: false },
  );
  const byTo = Object.fromEntries(imports.map((i) => [i.to, i.id]));
  assert.equal(byTo["module.kratos.juju_application.application"], `${IAM}:kratos`);
  assert.equal(byTo["module.traefik.juju_application.traefik"], `${CORE}:traefik-public`);
  assert.ok(!("module.hydra.juju_application.application" in byTo), "absent app must not import");
});

test("integration IDs keep the provider-canonical part order", () => {
  const imports = buildAttachImports(
    discovery({
      apps: ["kratos"],
      relations: { kratos: { "receive-ca-cert": ["send-ca-cert"] } },
    }),
    { tenant: false, hook: false, uvs: false },
  );
  const entry = imports.find((i) => i.to === "juju_integration.kratos_ca_cert");
  assert.equal(entry?.id, `${IAM}:send-ca-cert:send-ca-cert:kratos:receive-ca-cert`);
});

test("relate-gated relations import only when they EXIST and phase A wants them", () => {
  const rel = { "tenant-service": { "tenant-service-info": ["login-ui"] } };
  const withRelate = buildAttachImports(
    discovery({ apps: ["tenant-service", "login-ui"], relations: rel }),
    { tenant: true, hook: false, uvs: false },
  );
  assert.ok(withRelate.some((i) => i.to === "juju_integration.login_ui_tenant_service_info[0]"));

  // Exists on cluster but phase A says no -> no import (count would be 0).
  const withoutRelate = buildAttachImports(
    discovery({ apps: ["tenant-service", "login-ui"], relations: rel }),
    { tenant: false, hook: false, uvs: false },
  );
  assert.ok(!withoutRelate.some((i) => i.to === "juju_integration.login_ui_tenant_service_info[0]"));

  // Wanted but does not exist -> no import (terraform will CREATE it).
  const notExisting = buildAttachImports(
    discovery({ apps: ["tenant-service", "login-ui"] }),
    { tenant: true, hook: false, uvs: false },
  );
  assert.ok(!notExisting.some((i) => i.to === "juju_integration.login_ui_tenant_service_info[0]"));
});

test("app-gated relations never import when their app is absent", () => {
  const imports = buildAttachImports(
    discovery({
      apps: ["kratos"],
      relations: { "idp-dex": { "kratos-external-idp": ["kratos"] } },
    }),
    { tenant: false, hook: false, uvs: false },
  );
  assert.ok(!imports.some((i) => i.to === "juju_integration.kratos_idp_dex[0]"));
});

test("relationExists reads both string and object peer shapes", () => {
  const objStatus = { applications: { a: { relations: { ep: [{ "related-application": "b" }] } } } };
  const strStatus = { applications: { a: { relations: { ep: ["b"] } } } };
  assert.ok(relationExists(objStatus, "a", "ep", "b"));
  assert.ok(relationExists(strStatus, "a", "ep", "b"));
  assert.ok(!relationExists(objStatus, "a", "ep", "c"));
});

// ── selectRows ───────────────────────────────────────────────────────────────
// A row bound to other backends is named as out of scope, never deployed, and
// never dropped from the verdict silently.
const MATRIX = {
  rows: [
    { name: "core", kind: "pinned", dims: { webauthn: null } },
    { name: "seed-everywhere", kind: "seed", dims: {} },
    { name: "seed-target", kind: "seed", dims: {}, backends: ["urls"] },
    { name: "mx-generated", kind: "generated", dims: {} },
  ],
};

test("--all takes every non-pinned row the backend can run and names the rest", () => {
  const compose = selectRows(MATRIX, "compose", null);
  assert.deepEqual(compose.rows, ["seed-everywhere", "mx-generated"]);
  assert.deepEqual(compose.outOfScope.map((r) => r.name), ["seed-target"]);

  const urls = selectRows(MATRIX, "urls", null);
  assert.deepEqual(urls.rows, ["seed-everywhere", "seed-target", "mx-generated"]);
  assert.deepEqual(urls.outOfScope, []);
});

test("a single target bound to another backend is out of scope, not run", () => {
  assert.deepEqual(selectRows(MATRIX, "compose", "seed-target").rows, []);
  assert.deepEqual(selectRows(MATRIX, "compose", "seed-target").outOfScope.map((r) => r.name), ["seed-target"]);
  assert.deepEqual(selectRows(MATRIX, "urls", "seed-target").rows, ["seed-target"]);
});

test("an unknown single target passes through for runRow's 'no such row'", () => {
  assert.deepEqual(selectRows(MATRIX, "compose", "nope"), { rows: ["nope"], outOfScope: [], noArtifact: [] });
});

// A row the backend never materialized an artefact for (null dim → no juju
// var-file) is refused up front, separately from out-of-scope: it carries no
// `backends`, so the out-of-scope message would TypeError on it.
test("a row without the backend's artefact is refused, separately from out-of-scope", () => {
  const single = selectRows(MATRIX, "juju", "core");
  assert.deepEqual(single.rows, []);
  assert.deepEqual(single.outOfScope, []);
  assert.deepEqual(single.noArtifact.map((r) => r.name), ["core"]);

  // A dims-complete row keeps its juju var-file and is admitted.
  assert.deepEqual(selectRows(MATRIX, "juju", "mx-generated").rows, ["mx-generated"]);

  // urls has no artefact at all (env is the interface): `backends` decides.
  assert.deepEqual(selectRows(MATRIX, "urls", "seed-target").rows, ["seed-target"]);
  assert.deepEqual(selectRows(MATRIX, "urls", "seed-target").noArtifact, []);

  // compose's artefact follows `backends` exactly, so nothing new is refused.
  assert.deepEqual(selectRows(MATRIX, "compose", "core").rows, ["core"]);
  assert.deepEqual(selectRows(MATRIX, "compose", null).noArtifact, []);
});

// ── TIER_A_FILES vs the expected-set script ──────────────────────────────────
// The same fact stated twice; a file missing from TIER_A_FILES yields phantom
// "expected to run but did not" entries. Read textually to stay offline.
test("TIER_A_FILES matches the tier-A table in scripts/expected-set.ts", () => {
  const src = fs.readFileSync(
    path.join(REPO, "tests", "browser", "scripts", "expected-set.ts"),
    "utf-8",
  );
  const table = src.slice(src.indexOf("const TIER_A:"), src.indexOf("];", src.indexOf("const TIER_A:")));
  const declared = [...table.matchAll(/"specs\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, "could not read the TIER_A table");
  assert.deepEqual([...TIER_A_FILES].sort(), [...new Set(declared)].sort());
});

// ── ATTACH_INTEGRATIONS vs backends/juju/root/integrations.tf ────────────────
// The attach table restates the terraform file as import addresses in the
// provider-canonical order (hence hand-written, not for_each). A relation
// missing here is destroyed-and-recreated by the first attach apply.
test("ATTACH_INTEGRATIONS matches the juju_integration resources in integrations.tf", () => {
  const src = fs.readFileSync(
    path.join(REPO, "matrix", "backends", "juju", "root", "integrations.tf"),
    "utf-8",
  );
  const declared = new Map();
  for (const m of src.matchAll(/^resource "juju_integration" "([^"]+)" \{([\s\S]*?)^\}/gm)) {
    declared.set(m[1], /^\s*count\s*=/m.test(m[2]));
  }
  assert.ok(declared.size > 0, "could not read integrations.tf");

  const attached = new Map(
    ATTACH_INTEGRATIONS.map((i) => {
      const m = /^juju_integration\.([^[]+)(\[0\])?$/.exec(i.addr);
      assert.ok(m, `unexpected attach address ${i.addr}`);
      return [m[1], m[2] !== undefined];
    }),
  );
  assert.equal(attached.size, ATTACH_INTEGRATIONS.length, "duplicate attach address");
  assert.deepEqual([...attached.keys()].sort(), [...declared.keys()].sort());
  for (const [name, counted] of declared) {
    assert.equal(attached.get(name), counted, `${name}: count in tf ⇔ [0] in ATTACH_INTEGRATIONS`);
  }

  // The presence dimensions ARE relations on this backend: every row-toggled
  // relation the preflight checks must be a resource the attach path knows.
  // The size pin stops an emptied table from passing the loop vacuously.
  assert.equal(JUJU_RELATIONS.length, 7);
  for (const [app, endpoint, peer] of JUJU_RELATIONS) {
    const entry = ATTACH_INTEGRATIONS.find(
      ({ parts: [a1, e1, a2, e2] }) =>
        (a1 === app && e1 === endpoint && a2 === peer) || (a2 === app && e2 === endpoint && a1 === peer),
    );
    assert.ok(entry, `the preflight checks ${app}:${endpoint} ↔ ${peer}, which ATTACH_INTEGRATIONS does not list`);
    assert.ok(declared.has(entry.addr.replace(/^juju_integration\./, "").replace(/\[0\]$/, "")));
  }
});

// ── classifyDrift ────────────────────────────────────────────────────────────
// The adopt plan always carries a baseline (constraints normalized, charm
// defaults declared explicitly, computed attributes); only a deployed value
// that differs from the declaration, a create/delete, or a removed key is drift.
// `before` omits config keys at the charm default, so the classifier compares
// against the deployed effective value (`juju config`).
const change = (address, change) => ({ address, change });
const update = (address, before, after, extra = {}) =>
  change(address, { actions: ["update"], before, after, ...extra });

test("classifyDrift: the adopt baseline is not drift", () => {
  const d = classifyDrift({
    resource_changes: [
      change("module.hydra.juju_application.application", { actions: ["no-op"], importing: { id: "x" }, before: {}, after: {} }),
      update("module.kratos.juju_application.application",
        { name: "kratos", constraints: "arch=amd64", config: { log_level: "info" }, storage: null, machines: null },
        { name: "kratos", constraints: "", config: { log_level: "info", enforce_mfa: "true" }, storage: [{ label: "pgdata" }], machines: null },
        { after_unknown: { machines: true } }),
    ],
  }, { kratos: { enforce_mfa: true, log_level: "info" } });
  assert.equal(d.imported, 1);
  assert.deepEqual(d.real, []);
  assert.equal(d.baseline.length, 3, d.baseline.join("; "));
});

test("classifyDrift: a row overriding a charm default the deployment still runs is drift", () => {
  const deployed = { kratos: { enable_local_idp: true } };
  const want = ['module.kratos.juju_application.application: config.enable_local_idp "true" (charm default) -> "false"'];
  // key absent from before.config
  assert.deepEqual(classifyDrift({ resource_changes: [
    update("module.kratos.juju_application.application",
      { name: "kratos", config: { log_level: "info" } },
      { name: "kratos", config: { log_level: "info", enable_local_idp: "false" } }),
  ] }, deployed).real, want);
  // before.config absent altogether
  assert.deepEqual(classifyDrift({ resource_changes: [
    update("module.kratos.juju_application.application",
      { name: "kratos", config: null },
      { name: "kratos", config: { enable_local_idp: "false" } }),
  ] }, deployed).real, want);
});

test("classifyDrift: an explicit \"\" over a non-empty charm default is drift; a wholly sensitive config is unverifiable", () => {
  const cleared = classifyDrift({ resource_changes: [
    update("module.traefik.juju_application.traefik",
      { name: "traefik-public", config: {} },
      { name: "traefik-public", config: { external_hostname: "" } }),
  ] }, { "traefik-public": { external_hostname: "iam.example.com" } });
  assert.deepEqual(cleared.real, ['module.traefik.juju_application.traefik: config.external_hostname "iam.example.com" (charm default) -> ""']);

  const secret = classifyDrift({ resource_changes: [
    update("module.uvs.juju_application.application",
      { name: "user-verification-service", config: { salesforce_consumer_secret: "old" } },
      { name: "user-verification-service", config: { salesforce_consumer_secret: "new" } },
      { after_sensitive: { config: true } }),
  ] });
  assert.deepEqual(secret.real, []);
  assert.equal(secret.unverifiable.length, 1);
});

test("classifyDrift: a deployed value differing from the declaration is drift, named", () => {
  const d = classifyDrift({
    resource_changes: [
      update("module.kratos.juju_application.application",
        { config: { enforce_mfa: "false", log_level: "info" } },
        { config: { enforce_mfa: "true" } }),
    ],
  });
  assert.deepEqual(d.real, [
    'module.kratos.juju_application.application: config.enforce_mfa "false" -> "true"',
    'module.kratos.juju_application.application: config.log_level "info" -> <removed>',
  ]);
});

test("classifyDrift: create/delete is drift; a write-only secret is unverifiable, not drift", () => {
  const d = classifyDrift({
    resource_changes: [
      change("juju_integration.kratos_database", { actions: ["create"], before: null, after: {} }),
      update("module.uvs.juju_application.application",
        { config: { salesforce_consumer_secret: "old" } },
        { config: { salesforce_consumer_secret: "new" } },
        { after_sensitive: { config: { salesforce_consumer_secret: true } } }),
    ],
  });
  assert.deepEqual(d.real, ["juju_integration.kratos_database: create"]);
  assert.deepEqual(d.unverifiable, ["module.uvs.juju_application.application: config.salesforce_consumer_secret (sensitive)"]);
});

// ── failure evidence (the public lane log and LLM triage input) ───────────────

test("collectTests: a failure names its failing step path and the error's first line", () => {
  const report = { suites: [{ specs: [
    { file: "specs/login.spec.ts", title: "first-login-mfa", tests: [{ status: "unexpected", results: [{
      error: { message: "Error: assertPageState: expected \"login-totp-verify\", got \"unknown\"\n\n\u001b[2mexpect(\u001b[22mreceived).toBe(expected)" },
      steps: [
        { title: "Phase: default", error: {}, steps: [
          { title: "start → login-email" },
          { title: "login-password → login-totp-verify", error: {} },
        ] },
      ],
    }] }] },
    { file: "specs/login.spec.ts", title: "returning-login-mfa", tests: [{ status: "expected", results: [{ steps: [] }] }] },
  ] }] };
  const [failed, passed] = collectTests(report);
  assert.deepEqual(failed.failure, {
    step: "Phase: default › login-password → login-totp-verify",
    message: "Error: assertPageState: expected \"login-totp-verify\", got \"unknown\"",
  });
  assert.equal(passed.failure, null);
});

test("redact: no manifest credential, token or authorization code survives", () => {
  const manifest = {
    users: [{ ref: "u", email: "u@test.example", password: "Secure-Password-123!", totpSecret: "RJXCFOHD4RSMLLNM", backupCode: "k3j9x2ab" }],
    oauthClients: { rp: { client_id: "browser-test-rp", client_secret: "browser-test-rp-secret" } },
  };
  const line =
    "fill Secure-Password-123! then RJXCFOHD4RSMLLNM and k3j9x2ab; secret browser-test-rp-secret; " +
    "token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig and ory_rt_Zzp9F5NFhGPl; " +
    "URL: http://127.0.0.1:4447/callback?code=ory_ac_oE3J3zF&state=abc (user u@test.example)";
  const out = redact(line, manifestSecrets(manifest));
  for (const leaked of ["Secure-Password-123!", "RJXCFOHD4RSMLLNM", "k3j9x2ab", "browser-test-rp-secret", "eyJhbGci", "ory_rt_", "ory_ac_"]) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  // the evidence around the secrets stays readable
  assert.match(out, /callback\?code=«redacted»&state=abc \(user u@test\.example\)/);
});
