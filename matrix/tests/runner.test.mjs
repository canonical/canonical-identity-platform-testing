// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Offline tests for the matrix runner's pure logic. Every case here was a
// live-cluster bug first (multi-hour loops, one outage) — these keep the
// feedback loop for harness changes in milliseconds. Run: `make matrix-test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyOutcome,
  buildAttachImports,
  relationExists,
  JUSTIFIED_SKIP,
  TIER_A_FILES,
} from "../run-row.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── classifyOutcome ──────────────────────────────────────────────────────────
// Playwright statuses: "expected" = passed, "unexpected" = FAILED. The
// `unexpected:` prefix in row output is Playwright DATA, not harness text —
// this cost a long forensic detour once; the tests pin the semantics.

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
    [t("webhook-flow.spec.ts", "hook-service health check", "expected")],
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
      classifyOutcome([t("webhook-flow.spec.ts", "x", "skipped", reason)], expectedSet([])),
      [],
      `reason should be justified: ${reason}`,
    );
  }
  const failures = classifyOutcome(
    [t("webhook-flow.spec.ts", "x", "skipped", "TODO fix later")],
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

// ── TIER_A_FILES vs the expected-set script ──────────────────────────────────
// These two lists are the same fact stated twice. When they diverged (
// oidc-error.spec.ts and resilience.spec.ts were tier A in expected-set.ts but
// absent from TIER_A_FILES) every row verdict grew phantom "expected to run but
// did not" entries for scenarios that had just run, and those suites' runtime
// skips were held to the tier-B allowlist. Reading the TS table textually keeps
// this offline and dependency-free.
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
