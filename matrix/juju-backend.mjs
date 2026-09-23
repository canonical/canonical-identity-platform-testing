// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// The charmed backend: clean deploy (terraform apply of the row's var-file),
// attach mode (adopt an EXISTING deployment via ephemeral-state terraform
// import, then transition it), the shared settle loop, and URL discovery.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JUJU_ROOT = path.join(HERE, "backends", "juju", "root");
export const JUJU_MODEL = process.env.MATRIX_JUJU_MODEL ?? "iam-matrix";
const JUJU_CORE_MODEL = process.env.MATRIX_JUJU_CORE_MODEL ?? "iam-matrix-core";

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

// A `juju status --format short` line matching this keeps the model from counting as settled.
const NOT_SETTLED = /waiting|maintenance|executing|allocating|blocked|error/;

/** Status lines that kept a model from settling. */
export function nonCleanLines(statusShort) {
  return (statusShort ?? "").split("\n").filter((l) => l.trim() !== "" && NOT_SETTLED.test(l));
}

/** Wait for TWO CONSECUTIVE clean polls (statuses flap), 20-minute budget.
 *  Observe only: never `juju resolved`, never a config kick — a retry at the
 *  deployment layer would launder a novel charm bug into a green row. */
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

/** Resource changes a plan still wants, as `address: actions`. */
function pendingChanges(planJson) {
  return (planJson.resource_changes ?? [])
    .filter((rc) => !(rc.change?.actions ?? []).every((a) => a === "no-op" || a === "read"))
    .map((rc) => `${rc.address}: ${rc.change.actions.join("+")}`);
}

// Local-origin charms are not a supported shape in this lane: clean mode
// applies the var-file unmodified and attach refuses them outright.
// -parallelism=1: juju's remote-relations worker restarts mid-batch when ~25
// cross-model relations are created at once, and freshly created relations
// die or lose their data (observed 2026-09-19, juju 3.6.28). The post-apply
// plan then names anything the substrate dropped — no re-apply (D-3).
//
// One resume is allowed for a single provider transient: terraform-provider-juju
// offers an application before juju has its charm metadata ("not available to
// be offered"). That is the API racing the deploy, not a charm state, so the
// apply resumes where it stopped; any other failure ends the row.
const OFFER_TRANSIENT = /Unable to create offer, got error: the application was not available/;
export function deployJuju(rowName) {
  const varFile = path.join(HERE, "rows", rowName, "juju.tfvars.json");
  const applyArgs = ["apply", "-auto-approve", "-input=false", "-parallelism=1", `-var-file=${varFile}`];
  let apply = sh("terraform", applyArgs, { cwd: JUJU_ROOT, env: process.env });
  if (apply.status !== 0 && OFFER_TRANSIENT.test(apply.stderr ?? "")) {
    console.log("  apply stopped on the provider's offer-before-ready transient; resuming once");
    apply = sh("terraform", applyArgs, { cwd: JUJU_ROOT, env: process.env });
  }
  if (apply.status !== 0) {
    process.stderr.write(apply.stderr ?? "");
    return false;
  }
  const planFile = path.join(JUJU_ROOT, "converge.tfplan");
  try {
    const plan = sh("terraform", ["plan", "-detailed-exitcode", "-input=false", `-var-file=${varFile}`, `-out=${planFile}`], { cwd: JUJU_ROOT, env: process.env });
    if (plan.status === 1) {
      process.stderr.write(plan.stderr ?? "");
      return false;
    }
    if (plan.status === 2) {
      const show = sh("terraform", ["show", "-json", planFile], { cwd: JUJU_ROOT, env: process.env });
      const pending = show.status === 0 ? pendingChanges(JSON.parse(show.stdout)) : ["(plan unreadable)"];
      console.error("✗ deploy: the substrate diverged from a successful apply — juju dropped resources terraform created:");
      for (const p of pending) console.error(`    ${p}`);
      return false;
    }
  } finally {
    fs.rmSync(planFile, { force: true });
  }
  return settleModel("deploy");
}

// ── Attach mode: configure an EXISTING deployment via pure terraform ────────
// Ephemeral state (isolated workspace, wiped per run), declarative import
// blocks, then plan/apply in two phases (an import cannot target a count=0 address):
//   A "adopt":      relate_* forced to DISCOVERED reality -> imports commit.
//   B "transition": relate_* from the row -> plan is exactly the transition.
// Never deploys new apps, never manages foreign secrets (manage_secrets=false).

// Optional apps: presence is discoverable and gates module count.
const ATTACH_OPTIONAL = {
  "tenant-service": "tenant_service",
  "hook-service": "hook_service",
  "user-verification-service": "user_verification_service",
  "idp-dex": "idp_dex",
  "idp-dex2": "idp_dex2",
};

// charm_revisions keys per juju app name (revision-pinned modules only).
const ATTACH_REVISION_KEYS = {
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
const ATTACH_APP_ADDRS = {
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

// Offer resource addresses by offer name (send-ca-cert is offered twice for one juju offer).
const ATTACH_OFFER_ADDRS = {
  "traefik-route": ["juju_offer.traefik_route"],
  postgresql: ["juju_offer.postgresql"],
  "send-ca-cert": ["juju_offer.send_ca_certificate", "module.certificates.juju_offer.send_ca_cert"],
  openfga: ["juju_offer.openfga"],
  certificates: ["module.certificates.juju_offer.certificates"],
};

// Integration table: address, model, [app1, ep1, app2, ep2] in the provider's
// canonical order (unseen pairs get one swapped-order retry).
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

  // terraform-provider-juju cannot update apps running LOCAL charms.
  const localCharms = Object.keys(ATTACH_APP_ADDRS).filter((app) => {
    const a = (status.applications ?? {})[app] ?? (coreStatus.applications ?? {})[app];
    return a && `${a.charm ?? ""}`.startsWith("local:");
  });

  return { iamUuid: iam["model-uuid"] ?? iam.uuid, coreUuid: core["model-uuid"] ?? core.uuid, cloud: iam.cloud ?? "", region: iam.region ?? "", status, coreStatus, apps, revisions, offerUrls, extHost, uvsSecretId, kratosImageRev, relates, localCharms };
}

const ATTACH_IMPORTS_FILE = path.join(JUJU_ROOT, "imports.attach.tf.json");
const ATTACH_TFVARS_FILE = path.join(JUJU_ROOT, "attach.tfvars.json");

/** Import blocks for resources that EXIST on the cluster. Import targets need
 *  count=1 in phase A, so relate-gated relations follow discovery. */
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

/** Effective config per app across both models (`juju config`, defaults
 *  included). null when any read fails: the drift gate must not guess. */
function deployedConfig(d) {
  const out = {};
  for (const [model, st] of [[JUJU_MODEL, d.status], [JUJU_CORE_MODEL, d.coreStatus]]) {
    for (const app of Object.keys(st.applications ?? {})) {
      const res = sh("juju", ["config", "-m", model, app, "--format", "json"]);
      if (res.status !== 0) {
        console.error(`✗ drift gate: cannot read ${model}/${app} config: ${(res.stderr ?? "").trim()}`);
        return null;
      }
      const settings = JSON.parse(res.stdout).settings ?? {};
      out[app] = Object.fromEntries(Object.entries(settings).filter(([, s]) => s.value !== undefined).map(([k, s]) => [k, s.value]));
    }
  }
  return out;
}

/** Classify an adopt-shaped plan (`terraform show -json`) into what the provider
 *  always reports on an adopted deployment versus real drift.
 *  baseline: `constraints` normalized to "" on adopt; a storage/resources key the
 *  provider could not read back; a config key the provider could not read back
 *  (charm default) whose declared value IS the deployed value.
 *  unverifiable: a sensitive (write-only) config value — the provider cannot compare it.
 *  real: create/delete/replace, a declared value differing from the deployed one
 *  (including a charm default the row overrides), a key removed, or any other
 *  attribute change.
 *  `deployed` maps juju app name → { configKey: effective value } (`juju config`,
 *  defaults included): the plan's `before` omits keys at the charm default, so
 *  without it a row overriding a default would read as baseline. */
export function classifyDrift(planJson, deployed = {}) {
  const out = { imported: 0, baseline: [], unverifiable: [], real: [] };
  for (const rc of planJson.resource_changes ?? []) {
    const actions = rc.change?.actions ?? [];
    if (rc.change?.importing) out.imported += 1;
    if (actions.every((a) => a === "no-op" || a === "read")) continue;
    if (actions.some((a) => a === "create" || a === "delete")) {
      out.real.push(`${rc.address}: ${actions.join("+")}`);
      continue;
    }
    const before = rc.change.before ?? {};
    const after = rc.change.after ?? {};
    const sensitive = rc.change.after_sensitive ?? {};
    const unknown = rc.change.after_unknown ?? {};
    const effective = deployed[after.name ?? before.name] ?? {};
    // null, absent, "" and empty containers are the same "nothing" to the provider.
    const empty = (v) => v === null || v === undefined || v === "" || (typeof v === "object" && Object.keys(v).length === 0);
    const same = (x, y) => (empty(x) && empty(y)) || JSON.stringify(x) === JSON.stringify(y);
    for (const attr of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[attr];
      const a = after[attr];
      // Computed after apply (`after_unknown`): not a declared value, so not drift.
      if (unknown[attr] === true || same(b, a)) continue;
      if (attr === "constraints" && empty(a)) {
        out.baseline.push(`${rc.address}: constraints ${JSON.stringify(b)} -> ""`);
        continue;
      }
      if (attr === "config" && a && typeof a === "object") {
        const bc = b && typeof b === "object" ? b : {};
        for (const key of new Set([...Object.keys(bc), ...Object.keys(a)])) {
          // Strict: an absent key (charm default) and an explicit "" are different declarations.
          if (JSON.stringify(bc[key]) === JSON.stringify(a[key])) continue;
          const label = `${rc.address}: config.${key}`;
          if (sensitive.config === true || sensitive.config?.[key] === true) out.unverifiable.push(`${label} (sensitive)`);
          else if (bc[key] !== undefined) out.real.push(`${label} ${JSON.stringify(bc[key])} -> ${a[key] === undefined ? "<removed>" : JSON.stringify(a[key])}`);
          else if (effective[key] !== undefined && String(effective[key]) !== String(a[key])) {
            out.real.push(`${label} ${JSON.stringify(String(effective[key]))} (charm default) -> ${JSON.stringify(a[key])}`);
          } else out.baseline.push(`${label} unset -> ${JSON.stringify(a[key])}`);
        }
        continue;
      }
      if (["storage", "resources"].includes(attr) && b && a && typeof b === "object" && typeof a === "object") {
        for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
          if (same(b[key], a[key])) continue;
          const label = `${rc.address}: ${attr}.${key}`;
          if (b[key] === undefined) out.baseline.push(`${label} unset -> ${JSON.stringify(a[key])}`);
          else out.real.push(`${label} ${JSON.stringify(b[key])} -> ${a[key] === undefined ? "<removed>" : JSON.stringify(a[key])}`);
        }
        continue;
      }
      // A declared container the deployment reports nothing for (storage pinned by
      // the module, read back as null on adopt) is the same class as an unset default.
      if (empty(b) && !empty(a)) {
        out.baseline.push(`${rc.address}: ${attr} unset -> ${JSON.stringify(a)}`);
        continue;
      }
      out.real.push(`${rc.address}: ${attr} ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
  }
  return out;
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

export function attachJuju(rowName, { planOnly }) {
  const d = discoverAttach();
  if (!d) return false;

  const rowVars = JSON.parse(fs.readFileSync(path.join(HERE, "rows", rowName, "juju.tfvars.json"), "utf-8"));
  // No lane runs against local-origin charms; the provider cannot manage them anyway.
  if (d.localCharms.length > 0) {
    console.error(`✗ attach: local-origin charms detected: ${d.localCharms.join(", ")}`);
    console.error("    no lane may run against a local charm - refresh the app back to a store");
    console.error("    revision first (overlay experiments belong on a disposable model).");
    return false;
  }

  // A test run never deploys new apps onto a deployment it does not own.
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

  // Isolated workspace, ephemeral state. `workspace new` persistently switches
  // the directory's active workspace: switch straight back so bare terraform
  // runs never hit attach state (attach selects it via TF_WORKSPACE).
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
      // Drift gate: adopt-shaped plan, classified so the baseline the provider always
      // reports on an adopted deployment cannot hide real drift; never mutates.
      const planFile = path.join(JUJU_ROOT, "attach.tfplan");
      try {
        const plan = tfAttach(["plan", ...baseArgs, ...phaseAVars, "-input=false", `-out=${planFile}`], "plan");
        if (plan.status !== 0) return false;
        const show = tfAttach(["show", "-json", planFile], "show");
        if (show.status !== 0) return false;
        const deployed = deployedConfig(d);
        if (!deployed) return false;
        const drift = classifyDrift(JSON.parse(show.stdout), deployed);
        for (const [key, want] of [["tenant", rowVars.relate_tenant], ["hook", rowVars.relate_hook], ["uvs", rowVars.relate_uvs]]) {
          const have = d.relates[key];
          if (Boolean(want) !== have) drift.real.push(`relation transition pending: relate_${key} ${have} -> ${Boolean(want)}`);
        }
        console.log(`  imported: ${drift.imported}; baseline normalizations: ${drift.baseline.length}; unverifiable (write-only secrets): ${drift.unverifiable.length}; real drift: ${drift.real.length}`);
        for (const l of drift.unverifiable) console.log(`  ? ${l}`);
        for (const l of drift.real) console.log(`  ~ ${l}`);
        if (drift.real.length > 0) {
          console.error(`✗ drift gate: deployment does not match row '${rowName}' (${drift.real.length} real change(s); nothing applied)`);
          return false;
        }
        console.log("✓ drift gate: no real drift (plan-only; nothing applied)");
        return true;
      } finally {
        fs.rmSync(planFile, { force: true });
      }
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

    // Same observer-only settle as deployJuju before handing over to preflight.
    return settleModel("attach");
  } finally {
    // Any *.tf.json in the root is loaded by every terraform run, including clean mode.
    // MATRIX_ATTACH_KEEP=1 keeps the emitted files for inspection.
    if (!process.env.MATRIX_ATTACH_KEEP) fs.rmSync(ATTACH_IMPORTS_FILE, { force: true });
  }
}

/** Suite URLs discovered from the live model. Cluster IPs are host-routable on microk8s. */
export function discoverJujuUrls() {
  const status = JSON.parse(sh("juju", ["status", "-m", JUJU_MODEL, "--format", "json"]).stdout);
  const addr = (app) => status.applications?.[app]?.address;
  const coreStatus = JSON.parse(sh("juju", ["status", "-m", JUJU_CORE_MODEL, "--format", "json"]).stdout);
  // Ingress base: external_hostname when set (webauthn needs a domain-shaped
  // RP ID - root/variables.tf ingress_hostname), else traefik's LB address.
  const extHost = JSON.parse(sh("juju", ["config", "-m", JUJU_CORE_MODEL, "traefik-public", "--format", "json"]).stdout)
    .settings?.external_hostname?.value ?? "";
  const traefikMsg = coreStatus.applications?.["traefik-public"]?.["application-status"]?.message ?? "";
  const lb = extHost ? `https://${extHost}` : traefikMsg.match(/https?:\/\/[^\s"]+/)?.[0];
  // The dex issuer carries the node IP where the NodePort services (mail API, dex) live.
  const issuer = JSON.parse(sh("juju", ["config", "-m", JUJU_MODEL, "idp-dex", "--format", "json"]).stdout)
    .settings?.issuer_url?.value ?? "";
  const nodeIp = issuer.match(/https?:\/\/([0-9.]+):/)?.[1];

  return {
    KRATOS_PUBLIC_URL: `http://${addr("kratos")}:4433`,
    KRATOS_ADMIN_URL: `http://${addr("kratos")}:4434`,
    HYDRA_PUBLIC_URL: `http://${addr("hydra")}:4444`,
    HYDRA_ADMIN_URL: `http://${addr("hydra")}:4445`,
    // Tier-B specs default to compose's localhost ports; on juju they reach add-ons via cluster IPs.
    HOOK_SERVICE_URL: addr("hook-service") ? `http://${addr("hook-service")}:8080` : undefined,
    USER_VERIFICATION_URL: addr("user-verification-service") ? `http://${addr("user-verification-service")}:8083` : undefined,
    LOGIN_UI_URL: lb,
    MAIL_API_URL: nodeIp ? `http://${nodeIp}:30437` : undefined,
    DEX_URL: nodeIp ? `http://${nodeIp}:30556` : undefined,
  };
}
