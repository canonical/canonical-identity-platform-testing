#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Matrix-lane runner: deploy → verify → seed → test one materialized row,
// with declaration-driven gating and an expected-set verdict.
//
//   node matrix/run-row.mjs <row-name> [--backend=compose|juju|urls]
//   node matrix/run-row.mjs --all      [--backend=compose|juju|urls]
//
// Contract (why this cannot silently shrink coverage):
//   1. matrix/verify.mjs must pass BEFORE any test runs — a failed
//      reconfiguration aborts the row with the drifted dimension named.
//   2. Tests run with BROWSER_TEST_CAPABILITIES=<row>/capabilities.json:
//      gating consumes the DECLARATION, never runtime discovery (the runner
//      has no second predicate — `satisfies()` is it).
//   3. The executed set is compared against scripts/expected-set.ts, which is
//      computed from the same declaration with the same `satisfies()` —
//      a tier-A test that skips when it was expected to run (or vice versa)
//      fails the row even if every executed test passed.
// Tier B (specs with extra runtime predicates: google-oidc credentials,
// hand-written flows) is judged by the same skip-reason allowlist the gate
// uses, plus the enforce-mode reason shapes.
//
// Backends:
//   compose — `make matrix-up ROW=…`; URLs default to localhost ports.
//   juju    — `terraform apply -var-file=<row>/juju.tfvars.json` on the row
//             root; URLs discovered from the live model (cluster IPs are
//             host-routable on microk8s). Requires JUJU_CONTROLLER — this
//             workstation also has a production JIMM controller registered.
//             The browser leg runs by default (set MATRIX_JUJU_BROWSER=0 to
//             skip); deploy + preflight + seed always run and decide the verdict.
//   urls    — mode 5: no juju, no docker, no substrate access. The row's
//             contract runs against externally provided URLs; env is the
//             whole interface (see urlsEnv()). LOGIN_UI_URL is required.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assertController } from "./controller-guard.mjs";
import { JUSTIFIED_SKIP } from "../tests/browser/scripts/skip-allowlist.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const BROWSER_DIR = path.join(REPO, "tests", "browser");
const JUJU_ROOT = path.join(HERE, "backends", "juju", "root");
const JUJU_MODEL = process.env.MATRIX_JUJU_MODEL ?? "iam-matrix";
const JUJU_CORE_MODEL = process.env.MATRIX_JUJU_CORE_MODEL ?? "iam-matrix-core";

// The scenario-driven (tier-A) spec files. MUST stay identical to the TIER_A
// table in tests/browser/scripts/expected-set.ts: a file missing here is
// counted as tier B, so its declared executions are reported as "expected to
// run but did not" while its runtime skips are held to the tier-B allowlist.
// matrix/tests/runner.test.mjs pins the two lists against each other.
export const TIER_A_FILES = new Set([
  "error.spec.ts",
  "oidc-error.spec.ts",
  "login.spec.ts",
  "oidc.spec.ts",
  "recovery.spec.ts",
  "resilience.spec.ts",
  "registration.spec.ts",
  "session.spec.ts",
  "settings.spec.ts",
  "tenant.spec.ts",
  "verification.spec.ts",
  "webauthn.spec.ts",
]);

// Justified skip reasons for tier B — ONE definition, shared with the blocking
// gate (tests/browser/scripts/skip-allowlist.mjs). Re-exported so
// matrix/tests/ can assert both consumers resolve to the same array.
export { JUSTIFIED_SKIP };

// Per-test outcome, keyed by "file › title". Mirrors scripts/gate.mjs.
function collectTests(report) {
  const results = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const testCase of spec.tests ?? []) {
        const annotations = [
          ...(testCase.annotations ?? []),
          ...(testCase.results ?? []).flatMap((r) => r.annotations ?? []),
        ];
        results.push({
          file: path.basename(spec.file),
          title: spec.title,
          status: testCase.status,
          reason: annotations
            .filter((a) => a.type === "skip")
            .map((a) => a.description ?? "")
            .join(" | "),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return results;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

// ── Backend: deploy + environment ───────────────────────────────────────────

/** Pure: the row verdict. `tests` are collectTests() entries ({file, title,
 *  status, reason}); `expected` is the expected-set script's output.
 *  Playwright statuses: "expected" = passed, "unexpected" = FAILED,
 *  "flaky" = passed on retry (forbidden here), "skipped".
 *  Three failure classes, all loud:
 *    - hard failures/flakes: `<status>: file › title`
 *    - tier-A declaration drift, BOTH directions (ran-but-undeclared /
 *      declared-but-did-not-run)
 *    - tier-B skips whose reason is not in the JUSTIFIED_SKIP allowlist. */
export function classifyOutcome(tests, expected) {
  const failures = [];

  for (const t of tests) {
    if (t.status !== "expected" && t.status !== "skipped") {
      failures.push(`${t.status}: ${t.file} › ${t.title}`);
    }
  }

  const executedA = new Set(
    tests.filter((t) => TIER_A_FILES.has(t.file) && t.status !== "skipped").map((t) => `${t.file} › ${t.title}`),
  );
  const expectedA = new Set(expected.run.map((e) => `${path.basename(e.file)} › ${e.id}`));
  for (const id of expectedA) {
    if (!executedA.has(id)) failures.push(`expected to run but did not: ${id}`);
  }
  for (const id of executedA) {
    if (!expectedA.has(id)) failures.push(`executed but not in the expected set: ${id}`);
  }

  for (const t of tests) {
    if (t.status !== "skipped" || TIER_A_FILES.has(t.file)) continue;
    if (!JUSTIFIED_SKIP.some((re) => re.test(t.reason))) {
      failures.push(`unjustified skip: ${t.file} › ${t.title} — ${t.reason || "<no reason>"}`);
    }
  }

  return failures;
}

function deployCompose(rowName) {
  const up = sh("make", ["matrix-up", `ROW=${rowName}`], { cwd: REPO });
  if (up.status !== 0) process.stderr.write(up.stderr ?? "");
  return up.status === 0;
}

// A `juju status --format short` line mentioning any of these keeps the model
// from counting as settled.
const NOT_SETTLED = /waiting|maintenance|executing|allocating|blocked|error/;

/** Pure: the status lines that kept a model from settling — the diagnosable
 *  part of a settle timeout. */
export function nonCleanLines(statusShort) {
  return (statusShort ?? "").split("\n").filter((l) => l.trim() !== "" && NOT_SETTLED.test(l));
}

/** Wait for TWO CONSECUTIVE clean polls (charm statuses flap, so a single
 *  green would let the preflight race a momentary one), bounded by a
 *  20-minute budget.
 *
 *  Observe only. No `juju resolved`, no config kick: a retry at the
 *  deployment layer is the very thing `retries: 0` bans one layer up, and an
 *  app-agnostic nudge would also accelerate a NOVEL charm bug through settle
 *  into a green row (decision D-3). A model that cannot converge — including
 *  the documented kratos-operator wedge — fails this budget loudly and the row
 *  stays red until the upstream fixes land. */
function settleModel(label) {
  const deadline = Date.now() + 20 * 60_000;
  let cleanPolls = 0;
  let lastDirty = "";
  for (;;) {
    const st = sh("juju", ["status", "-m", JUJU_MODEL, "--format", "short"]);
    const out = st.stdout ?? "";
    const clean = st.status === 0 && !NOT_SETTLED.test(out);
    if (!clean) lastDirty = out || (st.stderr ?? "");
    cleanPolls = clean ? cleanPolls + 1 : 0;
    if (cleanPolls >= 2) return true;
    if (Date.now() > deadline) {
      const lines = nonCleanLines(lastDirty);
      console.error(`✗ ${label}: model did not settle within 20 min; last non-clean status lines:`);
      process.stderr.write((lines.length > 0 ? lines.join("\n") : lastDirty.trim()) + "\n");
      return false;
    }
    spawnSync("sleep", ["10"]);
  }
}

// Local-origin charms are not a supported deployment shape anywhere in this
// lane (decision D-2): overlay experiments happen on disposable models and no
// lane may depend on one. Clean mode therefore applies the row's var-file
// unmodified — no revision pins, no channel nulling, no tolerated apply
// errors — and attach refuses local charms outright.
function deployJuju(rowName) {
  const varFile = path.join(HERE, "rows", rowName, "juju.tfvars.json");
  const apply = sh("terraform", ["apply", "-auto-approve", `-var-file=${varFile}`], { cwd: JUJU_ROOT, env: process.env });
  if (apply.status !== 0) {
    process.stderr.write(apply.stderr ?? "");
    return false;
  }
  return settleModel("deploy");
}

// ── Attach mode: configure an EXISTING deployment via pure terraform ────────
// Pattern: identity-team charm-deploy.yaml scaled to the whole root -
// ephemeral state (isolated workspace, wiped per run), declarative import
// blocks, then plan/apply. Two phases solve the import-vs-count conflict
// (an import cannot target a count=0 address, so a cluster relation the row
// does not want could never be imported-then-destroyed in one pass):
//   A "adopt":      relate_* forced to DISCOVERED reality -> imports commit.
//   B "transition": relate_* from the row -> plan is exactly the transition.
// Never deploys new apps (apps_present discovered; rows requiring an absent
// app are refused), never manages foreign secrets (manage_secrets=false).

// Optional apps: presence is discoverable and gates module count.
const ATTACH_OPTIONAL = {
  "tenant-service": "tenant_service",
  "hook-service": "hook_service",
  "user-verification-service": "user_verification_service",
  "idp-dex": "idp_dex",
  "idp-dex2": "idp_dex2",
};

// charm_revisions keys per juju app name (revision-pinned modules only).
export const ATTACH_REVISION_KEYS = {
  hydra: "hydra",
  kratos: "kratos",
  "login-ui": "login_ui",
  "tenant-service": "tenant_service",
  "hook-service": "hook_service",
  "user-verification-service": "user_verification_service",
  "idp-dex": "idp_dex",
  "idp-dex2": "idp_dex2",
};

// Application resource addresses inside the root (module-internal names vary).
export const ATTACH_APP_ADDRS = {
  "self-signed-certificates": "module.certificates.juju_application.self-signed-certificates",
  "traefik-public": "module.traefik.juju_application.traefik",
  "postgresql-k8s": "module.postgresql.juju_application.k8s_postgresql",
  "openfga-k8s": "module.openfga.juju_application.openfga",
  hydra: "module.hydra.juju_application.application",
  kratos: "module.kratos.juju_application.application",
  "login-ui": "module.login_ui.juju_application.application",
  "tenant-service": "module.tenant_service[0].juju_application.application",
  "hook-service": "module.hook_service[0].juju_application.application",
  "user-verification-service": "module.user_verification_service[0].juju_application.application",
  "idp-dex": "module.idp_dex[0].juju_application.kratos-external-idp",
  "idp-dex2": "module.idp_dex2[0].juju_application.kratos-external-idp",
};

// Offer resource addresses by offer name (module.certificates also offers
// send-ca-cert under its own address - same underlying juju offer).
export const ATTACH_OFFER_ADDRS = {
  "traefik-route": ["juju_offer.traefik_route"],
  postgresql: ["juju_offer.postgresql"],
  "send-ca-cert": ["juju_offer.send_ca_certificate", "module.certificates.juju_offer.send_ca_cert"],
  openfga: ["juju_offer.openfga"],
  certificates: ["module.certificates.juju_offer.certificates"],
};

// Integration table: address, model, [app1, ep1, app2, ep2] (ID part order
// as the provider canonicalizes it - verified against live state; unseen
// pairs get one swapped-order retry), and the gating source.
//   gate: undefined = always-on; "app" = presence only; "tenant|hook|uvs" =
//   row toggle (relate_*) - phase A uses discovered existence instead.
export const ATTACH_INTEGRATIONS = [
  { addr: "juju_integration.traefik_certs", model: "core", parts: ["self-signed-certificates", "certificates", "traefik-public", "certificates"] },
  { addr: "juju_integration.openfga_db", model: "core", parts: ["postgresql-k8s", "database", "openfga-k8s", "database"] },
  { addr: "juju_integration.hydra_public_route", model: "iam", parts: ["traefik-route", "traefik-route", "hydra", "public-route"] },
  { addr: "juju_integration.kratos_public_route", model: "iam", parts: ["traefik-route", "traefik-route", "kratos", "public-route"] },
  { addr: "juju_integration.login_ui_public_route", model: "iam", parts: ["traefik-route", "traefik-route", "login-ui", "public-route"] },
  { addr: "juju_integration.uvs_public_route[0]", model: "iam", parts: ["traefik-route", "traefik-route", "user-verification-service", "ingress"], app: "user-verification-service" },
  { addr: "juju_integration.hydra_database", model: "iam", parts: ["postgresql", "database", "hydra", "pg-database"] },
  { addr: "juju_integration.kratos_database", model: "iam", parts: ["postgresql", "database", "kratos", "pg-database"] },
  { addr: "juju_integration.tenant_service_database[0]", model: "iam", parts: ["postgresql", "database", "tenant-service", "pg-database"], app: "tenant-service" },
  { addr: "juju_integration.hook_service_database[0]", model: "iam", parts: ["postgresql", "database", "hook-service", "pg-database"], app: "hook-service" },
  { addr: "juju_integration.kratos_ca_cert", model: "iam", parts: ["send-ca-cert", "send-ca-cert", "kratos", "receive-ca-cert"] },
  { addr: "juju_integration.login_ui_ca_cert", model: "iam", parts: ["send-ca-cert", "send-ca-cert", "login-ui", "receive-ca-cert"] },
  { addr: "juju_integration.tenant_service_ca_cert[0]", model: "iam", parts: ["send-ca-cert", "send-ca-cert", "tenant-service", "receive-ca-cert"], app: "tenant-service" },
  { addr: "juju_integration.hook_service_ca_cert[0]", model: "iam", parts: ["send-ca-cert", "send-ca-cert", "hook-service", "receive-ca-cert"], app: "hook-service" },
  { addr: "juju_integration.kratos_hydra_endpoint_info", model: "iam", parts: ["hydra", "hydra-endpoint-info", "kratos", "hydra-endpoint-info"] },
  { addr: "juju_integration.login_ui_hydra_endpoint_info", model: "iam", parts: ["hydra", "hydra-endpoint-info", "login-ui", "hydra-endpoint-info"] },
  { addr: "juju_integration.login_ui_kratos_info", model: "iam", parts: ["kratos", "kratos-info", "login-ui", "kratos-info"] },
  { addr: "juju_integration.kratos_login_ui_endpoint_info", model: "iam", parts: ["login-ui", "ui-endpoint-info", "kratos", "ui-endpoint-info"] },
  { addr: "juju_integration.hydra_login_ui_endpoint_info", model: "iam", parts: ["login-ui", "ui-endpoint-info", "hydra", "ui-endpoint-info"] },
  { addr: "juju_integration.uvs_login_ui_endpoint_info[0]", model: "iam", parts: ["login-ui", "ui-endpoint-info", "user-verification-service", "ui-endpoint-info"], app: "user-verification-service" },
  { addr: "juju_integration.tenant_service_oauth[0]", model: "iam", parts: ["hydra", "oauth", "tenant-service", "oauth"], app: "tenant-service" },
  { addr: "juju_integration.tenant_service_openfga[0]", model: "iam", parts: ["openfga", "openfga", "tenant-service", "openfga"], app: "tenant-service" },
  { addr: "juju_integration.tenant_service_kratos_info[0]", model: "iam", parts: ["kratos", "kratos-info", "tenant-service", "kratos-info"], app: "tenant-service" },
  { addr: "juju_integration.hook_service_openfga[0]", model: "iam", parts: ["openfga", "openfga", "hook-service", "openfga"], app: "hook-service" },
  { addr: "juju_integration.hook_service_oauth[0]", model: "iam", parts: ["hydra", "oauth", "hook-service", "oauth"], app: "hook-service" },
  { addr: "juju_integration.kratos_idp_dex[0]", model: "iam", parts: ["idp-dex", "kratos-external-idp", "kratos", "kratos-external-idp"], app: "idp-dex" },
  { addr: "juju_integration.kratos_idp_dex2[0]", model: "iam", parts: ["idp-dex2", "kratos-external-idp", "kratos", "kratos-external-idp"], app: "idp-dex2" },
  { addr: "juju_integration.login_ui_tenant_service_info[0]", model: "iam", parts: ["tenant-service", "tenant-service-info", "login-ui", "tenant-service-info"], gate: "tenant" },
  { addr: "juju_integration.tenant_service_kratos_registration_webhook[0]", model: "iam", parts: ["tenant-service", "kratos-registration-webhook", "kratos", "kratos-registration-webhook"], gate: "tenant" },
  { addr: "juju_integration.tenant_service_kratos_login_webhook[0]", model: "iam", parts: ["tenant-service", "kratos-login-webhook", "kratos", "kratos-login-webhook"], gate: "tenant" },
  { addr: "juju_integration.hook_service_hydra_token_hook[0]", model: "iam", parts: ["hook-service", "hydra-token-hook", "hydra", "hydra-token-hook"], gate: "hook" },
  { addr: "juju_integration.hook_service_tenant_service_info[0]", model: "iam", parts: ["tenant-service", "tenant-service-info", "hook-service", "tenant-service-info"], gate: "tenant&&hook" },
  { addr: "juju_integration.uvs_kratos_registration_webhook[0]", model: "iam", parts: ["user-verification-service", "kratos-registration-webhook", "kratos", "kratos-registration-webhook"], gate: "uvs" },
  { addr: "juju_integration.uvs_kratos_registration_endpoint_info[0]", model: "iam", parts: ["user-verification-service", "registration-endpoint-info", "kratos", "ui-endpoint-info"], gate: "uvs" },
];

export function relationExists(status, a1, e1, a2) {
  const rels = status.applications?.[a1]?.relations?.[e1] ?? [];
  return rels.some((r) => (typeof r === "string" ? r : r["related-application"]) === a2);
}

/** Read everything attach needs from the live controller. */
function discoverAttach() {
  const models = JSON.parse(sh("juju", ["models", "--format", "json"]).stdout).models ?? [];
  const byName = (n) => models.find((m) => m.name === n || m.name.endsWith(`/${n}`));
  const iam = byName(JUJU_MODEL);
  const core = byName(JUJU_CORE_MODEL);
  if (!iam || !core) {
    console.error(`✗ attach: models not found on controller (want ${JUJU_MODEL} + ${JUJU_CORE_MODEL})`);
    return null;
  }
  const status = JSON.parse(sh("juju", ["status", "-m", JUJU_MODEL, "--format", "json"]).stdout);
  const coreStatus = JSON.parse(sh("juju", ["status", "-m", JUJU_CORE_MODEL, "--format", "json"]).stdout);
  const apps = new Set([...Object.keys(status.applications ?? {}), ...Object.keys(coreStatus.applications ?? {})]);

  const revisions = {};
  for (const [app, key] of Object.entries(ATTACH_REVISION_KEYS)) {
    const rev = status.applications?.[app]?.["charm-rev"];
    if (typeof rev === "number") revisions[key] = rev;
  }

  const offers = JSON.parse(sh("juju", ["offers", "-m", JUJU_CORE_MODEL, "--format", "json"]).stdout ?? "{}");
  const offerUrls = Object.fromEntries(Object.entries(offers).map(([name, o]) => [name, o["offer-url"]]));

  const extHost = JSON.parse(sh("juju", ["config", "-m", JUJU_CORE_MODEL, "traefik-public", "--format", "json"]).stdout ?? "{}")
    .settings?.external_hostname?.value ?? "";

  const secrets = JSON.parse(sh("juju", ["secrets", "-m", JUJU_MODEL, "--format", "json"]).stdout ?? "{}");
  const uvsSecretId = Object.entries(secrets).find(
    ([, s]) => s.name === "user_verification_service_salesforce_credentials",
  )?.[0] ?? "";

  const kratosRes = JSON.parse(sh("juju", ["resources", "kratos", "-m", JUJU_MODEL, "--format", "json"]).stdout ?? "{}");
  const kratosImageRev = Number((kratosRes.resources ?? []).find((r) => r.name === "oci-image")?.revision);

  const relates = {
    tenant: relationExists(status, "login-ui", "tenant-service-info", "tenant-service"),
    hook: relationExists(status, "hook-service", "hydra-token-hook", "hydra"),
    uvs: relationExists(status, "user-verification-service", "kratos-registration-webhook", "kratos"),
  };

  // Provider limitation: terraform-provider-juju cannot update apps running
  // LOCAL charms ('unknown schema for charm URL "local:..."'). Attach
  // requires store-origin charms for every managed app.
  const localCharms = Object.keys(ATTACH_APP_ADDRS).filter((app) => {
    const a = (status.applications ?? {})[app] ?? (coreStatus.applications ?? {})[app];
    return a && `${a.charm ?? ""}`.startsWith("local:");
  });

  return { iamUuid: iam["model-uuid"] ?? iam.uuid, coreUuid: core["model-uuid"] ?? core.uuid, cloud: iam.cloud ?? "", region: iam.region ?? "", status, coreStatus, apps, revisions, offerUrls, extHost, uvsSecretId, kratosImageRev, relates, localCharms };
}

const ATTACH_IMPORTS_FILE = path.join(JUJU_ROOT, "imports.attach.tf.json");
const ATTACH_TFVARS_FILE = path.join(JUJU_ROOT, "attach.tfvars.json");

/** Pure: build the import blocks for resources that EXIST on the cluster.
 *  Import targets must have config count=1 in phase A, so relate-gated
 *  relations are included only when discovery says they exist. */
export function buildAttachImports(d, phaseARelates) {
  const imports = [
    { to: "juju_model.iam", id: d.iamUuid },
    { to: "juju_model.core", id: d.coreUuid },
  ];
  for (const [name, addrs] of Object.entries(ATTACH_OFFER_ADDRS)) {
    const url = d.offerUrls[name];
    if (url) for (const to of addrs) imports.push({ to, id: url });
  }
  for (const [app, addr] of Object.entries(ATTACH_APP_ADDRS)) {
    if (!d.apps.has(app)) continue;
    const uuid = ["self-signed-certificates", "traefik-public", "postgresql-k8s", "openfga-k8s"].includes(app) ? d.coreUuid : d.iamUuid;
    imports.push({ to: addr, id: `${uuid}:${app}` });
  }
  for (const rel of ATTACH_INTEGRATIONS) {
    const st = rel.model === "core" ? d.coreStatus : d.status;
    const [a1, e1, a2] = rel.parts;
    if (!relationExists(st, a1, e1, a2) && !relationExists(st, a2, rel.parts[3], a1)) continue;
    if (rel.app && !d.apps.has(rel.app)) continue;
    if (rel.gate === "tenant" && !phaseARelates.tenant) continue;
    if (rel.gate === "hook" && !phaseARelates.hook) continue;
    if (rel.gate === "uvs" && !phaseARelates.uvs) continue;
    if (rel.gate === "tenant&&hook" && !(phaseARelates.tenant && phaseARelates.hook)) continue;
    const uuid = rel.model === "core" ? d.coreUuid : d.iamUuid;
    imports.push({ to: rel.addr, id: `${uuid}:${rel.parts.join(":")}` });
  }
  return imports;
}

/** Emit import blocks + substrate tfvars for an attach run. */
function emitAttachFiles(d, phaseARelates) {
  fs.writeFileSync(ATTACH_IMPORTS_FILE, JSON.stringify({ import: buildAttachImports(d, phaseARelates) }, null, 2));

  const tfvars = {
    model_name: JUJU_MODEL,
    core_model_name: JUJU_CORE_MODEL,
    cloud_name: d.cloud,
    cloud_region: d.region,
    apps_present: Object.fromEntries(Object.entries(ATTACH_OPTIONAL).map(([app, key]) => [key, d.apps.has(app)])),
    charm_revisions: d.revisions,
    manage_secrets: false,
    uvs_salesforce_secret_id: d.uvsSecretId,
    ingress_hostname: d.extHost,
    ...(Number.isFinite(d.kratosImageRev) ? { kratos_image_revision: d.kratosImageRev } : {}),
  };
  fs.writeFileSync(ATTACH_TFVARS_FILE, JSON.stringify(tfvars, null, 2));
}

function tfAttach(args, phase) {
  const env = { ...process.env, TF_WORKSPACE: "attach" };
  const res = sh("terraform", args, { cwd: JUJU_ROOT, env });
  if (res.status !== 0) {
    console.error(`✗ attach ${phase} failed:`);
    process.stderr.write((res.stderr ?? "").split("\n").slice(0, 40).join("\n") + "\n");
  }
  return res;
}

/** Import-order hedge: on "not found" for an integration import, swap the
 *  pair order in the imports file once and let the caller retry. */
function swapFailedImportOrders(stderr) {
  const doc = JSON.parse(fs.readFileSync(ATTACH_IMPORTS_FILE, "utf-8"));
  let swapped = false;
  for (const imp of doc.import) {
    if (!imp.to.startsWith("juju_integration.")) continue;
    const bare = imp.to.replace(/\[0\]$/, "");
    if (!stderr.includes(bare)) continue;
    const [uuid, a1, e1, a2, e2] = imp.id.split(":");
    imp.id = [uuid, a2, e2, a1, e1].join(":");
    swapped = true;
  }
  if (swapped) fs.writeFileSync(ATTACH_IMPORTS_FILE, JSON.stringify(doc, null, 2));
  return swapped;
}

function attachJuju(rowName, { planOnly }) {
  const d = discoverAttach();
  if (!d) return false;

  const rowVars = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "juju.tfvars.json"), "utf-8"));
  // Universal invariant (D-2): no lane runs against local-origin charms.
  // terraform-provider-juju cannot manage local: charm URLs at all.
  if (d.localCharms.length > 0) {
    console.error(`✗ attach: local-origin charms detected: ${d.localCharms.join(", ")}`);
    console.error("    no lane may run against a local charm - refresh the app back to a store");
    console.error("    revision first (overlay experiments belong on a disposable model).");
    return false;
  }

  // Refuse rows that require apps this cluster lacks - a test run never
  // deploys new apps onto a deployment it does not own.
  const needs = [
    ["relate_tenant", "tenant-service"],
    ["relate_hook", "hook-service"],
    ["relate_uvs", "user-verification-service"],
    ["idp_dex_enabled", "idp-dex"],
    ["idp_dex2_enabled", "idp-dex2"],
  ].filter(([v, app]) => rowVars[v] === true && !d.apps.has(app));
  if (needs.length > 0) {
    console.error(`✗ attach: row '${rowName}' requires apps this deployment lacks - refusing (attach never deploys apps):`);
    for (const [v, app] of needs) console.error(`    ${v} -> ${app}`);
    return false;
  }

  emitAttachFiles(d, d.relates);

  // Isolated workspace, ephemeral state: wiped every run, imports rebuild it.
  // `workspace new` PERSISTENTLY switches the directory's active workspace
  // (.terraform/environment) - switch straight back so bare terraform
  // commands outside this runner never silently run against attach state. Attach
  // invocations select the workspace via TF_WORKSPACE env instead.
  sh("terraform", ["workspace", "new", "attach"], { cwd: JUJU_ROOT, env: process.env });
  sh("terraform", ["workspace", "select", "default"], { cwd: JUJU_ROOT, env: process.env });
  fs.rmSync(path.join(JUJU_ROOT, "terraform.tfstate.d", "attach"), { recursive: true, force: true });

  const varFile = path.join(HERE, "rows", rowName, "juju.tfvars.json");
  const baseArgs = [`-var-file=${varFile}`, `-var-file=${ATTACH_TFVARS_FILE}`];
  const phaseAVars = [
    `-var=relate_tenant=${d.relates.tenant}`,
    `-var=relate_hook=${d.relates.hook}`,
    `-var=relate_uvs=${d.relates.uvs}`,
  ];

  try {
    if (planOnly) {
      // Drift gate: adopt-shaped plan (imports + config diffs), relation
      // transitions reported textually - the cluster is never mutated.
      const plan = tfAttach(["plan", ...baseArgs, ...phaseAVars, "-no-color"], "plan");
      if (plan.status !== 0) return false;
      const summary = (plan.stdout ?? "").split("\n").filter((l) => /^(Plan:|No changes|  # )/.test(l));
      console.log(summary.join("\n"));
      for (const [key, want] of [["tenant", rowVars.relate_tenant], ["hook", rowVars.relate_hook], ["uvs", rowVars.relate_uvs]]) {
        const have = d.relates[key];
        if (Boolean(want) !== have) console.log(`  ~ relation transition pending: relate_${key} ${have} -> ${Boolean(want)}`);
      }
      console.log("✓ drift gate complete (plan-only; nothing applied)");
      return true;
    }

    // Phase A: adopt reality (imports + config reconciliation).
    for (let attempt = 1; ; attempt++) {
      const a = tfAttach(["apply", "-auto-approve", ...baseArgs, ...phaseAVars], `adopt (A${attempt})`);
      if (a.status === 0) break;
      if (attempt >= 4 || !swapFailedImportOrders(a.stderr ?? "")) return false;
      console.log("  retrying adopt with swapped integration import order…");
    }

    // Phase B: transition to the row's declared relations (skip if equal).
    const wants = { tenant: Boolean(rowVars.relate_tenant), hook: Boolean(rowVars.relate_hook), uvs: Boolean(rowVars.relate_uvs) };
    if (wants.tenant !== d.relates.tenant || wants.hook !== d.relates.hook || wants.uvs !== d.relates.uvs) {
      // Imports are single-shot: phase A committed them into workspace state.
      fs.rmSync(ATTACH_IMPORTS_FILE, { force: true });
      const b = tfAttach(["apply", "-auto-approve", ...baseArgs], "transition (B)");
      if (b.status !== 0) return false;
    }

    // Settle before handing over to preflight. Same observer-only double-poll
    // + 20-minute budget as deployJuju.
    return settleModel("attach");
  } finally {
    // MATRIX_ATTACH_KEEP=1 keeps the emitted files for inspection; they are
    // gitignored but MUST NOT linger (any *.tf.json in the root dir is
    // loaded by every terraform run, including clean mode).
    if (!process.env.MATRIX_ATTACH_KEEP) fs.rmSync(ATTACH_IMPORTS_FILE, { force: true });
  }
}

/** Discover suite URLs from the live juju deployment. Env overrides win. */
/** One place where insecure-TLS policy is expressed, so a lane cannot acquire
 *  it by accident. `NODE_TLS_REJECT_UNAUTHORIZED=0` covers node's fetch (the
 *  verifier and seeder); `BROWSER_TEST_INSECURE_TLS=1` is what
 *  playwright.config.ts reads for `ignoreHTTPSErrors` plus chromium's
 *  --ignore-certificate-errors (WebAuthn refuses ceremonies on cert-error
 *  origins unless the browser itself trusts them). */
function insecureTlsEnv(on) {
  return on ? { NODE_TLS_REJECT_UNAUTHORIZED: "0", BROWSER_TEST_INSECURE_TLS: "1" } : {};
}

function jujuEnv() {
  const status = JSON.parse(sh("juju", ["status", "-m", JUJU_MODEL, "--format", "json"]).stdout);
  const addr = (app) => status.applications?.[app]?.address;
  const coreStatus = JSON.parse(sh("juju", ["status", "-m", JUJU_CORE_MODEL, "--format", "json"]).stdout);
  // Ingress base: external_hostname when the substrate sets one (webauthn
  // needs a domain-shaped RP ID - see root/variables.tf ingress_hostname),
  // else the LB address from traefik's status message.
  const extHost = JSON.parse(sh("juju", ["config", "-m", JUJU_CORE_MODEL, "traefik-public", "--format", "json"]).stdout)
    .settings?.external_hostname?.value ?? "";
  const traefikMsg = coreStatus.applications?.["traefik-public"]?.["application-status"]?.message ?? "";
  const lb = extHost ? `https://${extHost}` : traefikMsg.match(/https?:\/\/[^\s"]+/)?.[0];
  // The dex issuer carries the node IP — the NodePort services (mail API,
  // dex) live there. Self-contained discovery, no kubectl dependency.
  const issuer = JSON.parse(sh("juju", ["config", "-m", JUJU_MODEL, "idp-dex", "--format", "json"]).stdout)
    .settings?.issuer_url?.value ?? "";
  const nodeIp = issuer.match(/https?:\/\/([0-9.]+):/)?.[1];

  return {
    KRATOS_PUBLIC_URL: process.env.KRATOS_PUBLIC_URL ?? `http://${addr("kratos")}:4433`,
    KRATOS_ADMIN_URL: process.env.KRATOS_ADMIN_URL ?? `http://${addr("kratos")}:4434`,
    HYDRA_PUBLIC_URL: process.env.HYDRA_PUBLIC_URL ?? `http://${addr("hydra")}:4444`,
    HYDRA_ADMIN_URL: process.env.HYDRA_ADMIN_URL ?? `http://${addr("hydra")}:4445`,
    // Tier-B hand-written specs (webhook-flow, uvs) default to compose's
    // localhost ports; on juju they reach the services via cluster IPs -
    // without these the specs run (capabilities gate them on) and then fail
    // on dead sockets.
    HOOK_SERVICE_URL: process.env.HOOK_SERVICE_URL ?? (addr("hook-service") ? `http://${addr("hook-service")}:8080` : undefined),
    USER_VERIFICATION_URL: process.env.USER_VERIFICATION_URL ?? (addr("user-verification-service") ? `http://${addr("user-verification-service")}:8083` : undefined),
    LOGIN_UI_URL: process.env.LOGIN_UI_URL ?? lb,
    MAIL_API_URL: process.env.MAIL_API_URL ?? (nodeIp ? `http://${nodeIp}:30437` : undefined),
    DEX_URL: process.env.DEX_URL ?? (nodeIp ? `http://${nodeIp}:30556` : undefined),
    OIDC_CONSUMER_URL: process.env.OIDC_CONSUMER_URL ?? "http://127.0.0.1:4447",
    // The charmed lane's own ingress terminates TLS with a self-signed CA that
    // this harness created: verification here would only ever fail against a
    // cert we already know. Not overridable — it IS this lane's reality.
    ...insecureTlsEnv(true),
    MATRIX_BACKEND: "juju",
  };
}

/** URLs-only backend: env is the whole interface — no discovery, no juju,
 *  no substrate access. Only keys that are actually set are passed through;
 *  LOGIN_UI_URL presence is enforced at entry. */
function urlsEnv() {
  const opt = (k) => (process.env[k] ? { [k]: process.env[k] } : {});
  return {
    LOGIN_UI_URL: process.env.LOGIN_UI_URL,
    ...opt("KRATOS_PUBLIC_URL"),
    ...opt("KRATOS_ADMIN_URL"),
    ...opt("HYDRA_PUBLIC_URL"),
    ...opt("HYDRA_ADMIN_URL"),
    ...opt("MAIL_API_URL"),
    ...opt("DEX_URL"),
    ...opt("OIDC_CONSUMER_URL"),
    // TLS verification stays ON here by default — this is precisely the lane
    // pitched at real deployments, where a silently unverified certificate is
    // the failure it exists to catch. Opt in per run with MATRIX_INSECURE_TLS=1.
    ...insecureTlsEnv(process.env.MATRIX_INSECURE_TLS === "1"),
    MATRIX_BACKEND: "urls",
  };
}

// The suite's authorization_code flows start at (and read tokens from) the
// hydra sample consumer. Compose runs it as a service on :4446; the charmed
// lane runs the same CLI in a host container on :4447 (compose owns 4446 and
// both stacks stay up concurrently — the seeder registers both redirects).
// --network host: the consumer must reach the hydra ClusterIP for the token
// exchange; the host provably routes there, while docker's bridge fights the
// CNI's iptables rules.
const CONSUMER_NAME = "matrix-oidc-consumer";

function startConsumer(rowEnv) {
  sh("docker", ["rm", "-f", CONSUMER_NAME]);
  // The consumer is a Go client in its OWN container: it inherits neither the
  // host trust store nor NODE_EXTRA_CA_CERTS, and Go does not chase AIA. On a
  // target whose ingress serves an incomplete chain (iam.orange: leaf only)
  // every browser journey then completes and dies on the very last hop —
  // `Post ".../oauth2/token": x509: certificate signed by unknown authority`.
  // Hand the run's extra CAs to the container: SSL_CERT_FILE makes that file
  // Go's entire root pool, so it must hold every anchor the consumer needs
  // (for the incomplete-chain case: the missing intermediates, which is
  // exactly what NODE_EXTRA_CA_CERTS carries per docs/testing-spec.md §9).
  // Verification stays ON — this completes the chain, never skips it.
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  const run = sh("docker", [
    "run", "-d", "--rm", "--name", CONSUMER_NAME, "--network", "host",
    ...(extraCa ? ["-v", `${path.resolve(extraCa)}:/extra-ca.pem:ro`, "--env", "SSL_CERT_FILE=/extra-ca.pem"] : []),
    "--entrypoint", "hydra", "ghcr.io/canonical/hydra:25.4.0",
    "perform", "authorization-code", "--no-open", "--no-shutdown", "--port", "4447",
    "--client-id", "browser-test-rp", "--client-secret", "browser-test-rp-secret",
    "--endpoint", rowEnv.HYDRA_PUBLIC_URL,
    "--auth-url", `${rowEnv.LOGIN_UI_URL}/oauth2/auth`,
    "--scope", "openid,profile,email,offline_access",
  ]);
  if (run.status !== 0) {
    process.stderr.write(run.stderr ?? "");
    return false;
  }
  return true;
}

function stopConsumer() {
  sh("docker", ["rm", "-f", CONSUMER_NAME]);
}

// ── Row execution ───────────────────────────────────────────────────────────

async function runRow(rowName, backend) {
  const rowDir = path.join(HERE, "rows", rowName);
  const capsPath = path.join(rowDir, "capabilities.json");
  if (!fs.existsSync(capsPath)) {
    console.error(`✗ no such materialized row: ${rowName}`);
    return false;
  }

  console.log(`\n═══ matrix row: ${rowName} (${backend}) ═══`);

  // 1. Deploy (both backends reconcile in place; rows are variable sets).
  //    --attach: configure an EXISTING deployment (ephemeral-state terraform
  //    import + adopt/transition applies); --plan-only stops at the drift
  //    report without mutating anything.
  const planOnly = process.argv.includes("--plan-only");
  if (process.argv.includes("--attach")) {
    console.log(planOnly ? "── drift gate (attach, plan-only)" : "── attach (adopt + transition)");
    if (!attachJuju(rowName, { planOnly })) return false;
    if (planOnly) return true;
  } else if (backend === "urls") {
    console.log("── deploy: SKIPPED (urls backend - external deployment, declaration gating still applies)");
  } else {
    console.log("── deploy");
    if (!(backend === "juju" ? deployJuju(rowName) : deployCompose(rowName))) {
      console.error("✗ deploy failed");
      return false;
    }
  }

  // The row environment is threaded EXPLICITLY into every consumer — never
  // merged into process.env. In `--all`, mutating the parent's env made row 1's
  // discovered URLs sticky: later rows treated them as operator overrides
  // (jujuEnv/urlsEnv both prefer process.env), and the verifier captured them
  // at first import.
  const rowEnv = backend === "juju" ? jujuEnv() : backend === "urls" ? urlsEnv() : {};
  const { verifyRow } = await import("./verify.mjs");

  // 2. Preflight: deployment must MATCH the declaration or nothing runs.
  console.log("── preflight");
  if (!(await verifyRow(rowName, backend, rowEnv))) return false;

  // 3. The declaration becomes the active configuration for the seeder too.
  fs.copyFileSync(capsPath, path.join(BROWSER_DIR, "active-config.json"));

  // 4. Seed fresh against the row. The urls backend without an admin URL is
  //    the live-lane subset: nothing can be seeded, so the suite runs with
  //    BROWSER_TEST_LANE=live and seeded-identity journeys gate off.
  const liveLane = backend === "urls" && !rowEnv.KRATOS_ADMIN_URL;
  if (liveLane) {
    console.log("── seed: SKIPPED (no KRATOS_ADMIN_URL - live-lane subset)");
  } else {
    console.log("── seed");
    const seed = sh("npx", ["tsx", "seeder/seed.ts", "--fresh", "--profile", rowName], {
      cwd: BROWSER_DIR,
      env: { ...process.env, ...rowEnv },
    });
    if (seed.status !== 0) {
      process.stdout.write(seed.stdout ?? "");
      process.stderr.write(seed.stderr ?? "");
      console.error("✗ seeding failed");
      return false;
    }
  }

  // Browser journeys on the charmed stack are opt-in while the journey
  // plumbing matures (docs/testing-spec.md, "The configuration matrix"). Deploy + preflight + seed above are
  // the deployment-validation contract; the leg's absence is LOUD, never
  // silent.
  if (backend === "juju" && process.env.MATRIX_JUJU_BROWSER === "0") {
    console.log("── browser leg: SKIPPED (MATRIX_JUJU_BROWSER=0)");
    console.log(`✓ row ${rowName}: deployed, verified against declaration, seeded (${backend})`);
    return true;
  }

  // The RP consumer container needs docker plus the two URLs it actually talks
  // to — hydra PUBLIC (`--endpoint`, the token exchange) and the login-ui
  // (`--auth-url`). It never touches the admin API: the seeder registers
  // `browser-test-rp` with the 4447 redirect, so requiring HYDRA_ADMIN_URL here
  // only refused the consumer on exactly the deployments that have no admin
  // ingress — the mode-5 target. The charmed lane always runs it for the test
  // leg; the urls backend runs it unless an externally running consumer is
  // already pointed at via OIDC_CONSUMER_URL (compose runs it as a service).
  const wantConsumer =
    backend === "juju" ||
    (backend === "urls" && !!rowEnv.HYDRA_PUBLIC_URL && !rowEnv.OIDC_CONSUMER_URL);
  if (wantConsumer) {
    if (!startConsumer(rowEnv)) {
      console.error("✗ could not start the OIDC consumer container");
      return false;
    }
    if (backend === "urls") rowEnv.OIDC_CONSUMER_URL = "http://127.0.0.1:4447";
  } else if (backend === "urls") {
    console.log("── consumer: SKIPPED (urls backend, no HYDRA_PUBLIC_URL) — authorization_code journeys will fail unless OIDC_CONSUMER_URL points at an externally running consumer");
  }
  try {

  // 5. Expected execution set, from the same declaration + satisfies() — and
  //    from the SAME LANE the run below uses. `getExecutionLane()` reads
  //    BROWSER_TEST_LANE, so computing it in the inherited (internal) lane while
  //    running in `live` compares two different sets and the verdict is noise.
  const laneEnv = liveLane ? { BROWSER_TEST_LANE: "live" } : {};
  const expectedRaw = sh("npx", ["tsx", "scripts/expected-set.ts", capsPath], {
    cwd: BROWSER_DIR,
    env: { ...process.env, ...laneEnv },
  });
  if (expectedRaw.status !== 0) {
    process.stderr.write(expectedRaw.stderr ?? "");
    console.error("✗ expected-set computation failed");
    return false;
  }
  const expected = JSON.parse(expectedRaw.stdout);
  console.log(`── test (expecting ${expected.run.length} scenario executions, ${expected.skip.length} declared skips)`);

  // 6. Single run, retries pinned to 0 by the config. Nightly detector: one
  //    run per row; the gate remains the flake hunter.
  const run = sh("npx", ["playwright", "test", "--reporter=json"], {
    cwd: BROWSER_DIR,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...rowEnv,
      ...(rowEnv.LOGIN_UI_URL ? { BASE_URL: rowEnv.LOGIN_UI_URL } : {}),
      ...laneEnv,
      BROWSER_TEST_CAPABILITIES: capsPath,
    },
  });
  let report;
  try {
    const start = run.stdout?.indexOf("{") ?? -1;
    report = JSON.parse(start === -1 ? "{}" : run.stdout.slice(start));
  } catch {
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    console.error("✗ could not parse the Playwright JSON report");
    return false;
  }
  if ((report.errors ?? []).length > 0) {
    for (const e of report.errors) console.error(`✗ run-level error: ${e.message}`);
    return false;
  }

  const tests = collectTests(report);
  const failures = classifyOutcome(tests, expected);

  const executed = tests.filter((t) => t.status !== "skipped").length;
  const skipped = tests.length - executed;
  if (failures.length > 0) {
    console.error(`✗ row ${rowName}: ${failures.length} problem(s) (${executed} executed, ${skipped} skipped):`);
    for (const f of failures) console.error(`    ${f}`);
    return false;
  }
  console.log(`✓ row ${rowName}: ${executed} executed (matching the declaration exactly), ${skipped} declared skips, 0 failures`);
  return true;
  } finally {
    if (wantConsumer) stopConsumer();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────
// Main-guarded so matrix/tests/ can import the pure functions above without
// triggering a run (mirrors verify.mjs).

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {

const args = process.argv.slice(2);
const backend = args.find((a) => a.startsWith("--backend="))?.split("=")[1] ?? process.env.MATRIX_BACKEND ?? "compose";
const target = args.find((a) => !a.startsWith("--"));
const all = args.includes("--all");
if (!target && !all) {
  console.error("usage: node matrix/run-row.mjs <row-name> [--backend=compose|juju|urls] [--attach [--plan-only]] | --all [--backend=…]");
  process.exit(2);
}
// Controller guard: value-checked, not presence-checked, and reached BEFORE
// the watchdog spawn and before any terraform/juju process on either the
// deploy or the attach path (terraform-provider-juju binds the controller
// transitively through the same `juju show-controller` resolution, so the
// runner-side assert covers the terraform runs this file owns).
if (backend === "juju") {
  assertController();
}
if (backend === "urls" && !process.env.LOGIN_UI_URL) {
  console.error("✗ urls backend requires LOGIN_UI_URL to be set explicitly (the urls backend has no discovery — env is the whole interface)");
  process.exit(2);
}
if (args.includes("--attach") && backend !== "juju") {
  console.error("✗ --attach is a juju-backend mode (attaches to an existing charmed deployment)");
  process.exit(2);
}

const matrix = JSON.parse(fs.readFileSync(path.join(HERE, "matrix.json"), "utf-8"));
const rows = all ? matrix.rows.filter((r) => r.kind !== "pinned").map((r) => r.name) : [target];

// Juju rows run under the model journal (matrix/watchdog.mjs): an
// observer-only process that records workload-status changes and stuck units
// during the phases the settle loops don't watch (seed/test). Spawned here so
// no invocation path (make targets, nightly, by-hand) can forget it; its
// journal interleaves with the run output on purpose - the wedge frequency is
// evidence for the filed upstream bug report. It never mutates the model
// (decision D-3).
let watchdog = null;
if (backend === "juju") {
  watchdog = spawn(process.execPath, [path.join(HERE, "watchdog.mjs")], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

// Nightly baseline (compose + --all only). Postgres SURVIVES reconfiguration
// by design, so rows share accumulated state and "the nightly" would otherwise
// depend on whatever the previous night left behind. One volume-dropping reset
// at the top of the loop makes the night deterministic.
//
// Deliberately narrow: `--all` AND the compose backend AND not attach. A
// single-row run never tears anything down (an operator debugging one row must
// not lose their stack), and the charmed backend is never touched — that is a
// live deployment, and D-2/D-3 keep this harness out of destructive juju
// operations entirely. `make matrix-baseline` owns the compose file list.
if (all && backend === "compose") {
  const first = rows[0];
  console.log(`── nightly baseline: docker compose down --volumes, then up (row ${first})`);
  const reset = sh("make", ["matrix-baseline", `ROW=${first}`], { cwd: REPO });
  if (reset.status !== 0) {
    process.stdout.write(reset.stdout ?? "");
    process.stderr.write(reset.stderr ?? "");
    console.error("✗ nightly baseline reset failed — refusing to run the lane on unknown state");
    process.exit(1);
  }
}

const verdicts = [];
try {
  for (const row of rows) {
    verdicts.push({ row, ok: await runRow(row, backend) });
  }
} finally {
  watchdog?.kill("SIGTERM");
}

if (rows.length > 1) {
  console.log("\n═══ matrix verdict ═══");
  for (const v of verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.row}`);
}
process.exit(verdicts.every((v) => v.ok) ? 0 : 1);

}
