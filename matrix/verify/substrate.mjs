// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Layer 1: substrate state. Did the row's declaration actually land on the
// deployment substrate? Compose: containers, env, kratos config files, add-on
// status endpoints. Juju: app status, charm config, relation topology.
// This layer compares against the same expectedEnv()/jujuTfvars() that
// generated the artefacts, so it cannot witness a key the service ignores —
// that is the behaviour layer's job.

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { expectedEnv, kratosConfigFiles, TOGGLED_SERVICES } from "../lib.mjs";
import { record, reachable } from "./record.mjs";

const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "identity-platform";
const JUJU_MODEL = process.env.MATRIX_JUJU_MODEL ?? "iam-matrix";

const cli = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const docker = (args) => cli("docker", args);
const juju = (args) => cli("juju", args);

// ── compose ─────────────────────────────────────────────────────────────────

export function verifyCompose(dims) {
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

/** Add-on status endpoints are host-published in compose only; in the juju
 *  backend the apps are always running (presence = relations). */
export async function verifyComposeStatusEndpoints(dims, u) {
  for (const [dim, svc] of Object.entries(TOGGLED_SERVICES)) {
    const declared = dims[dim] === "present";
    const up = await reachable(`${u.serviceStatus[svc]}/api/v0/status`);
    record(
      "compose",
      `${svc} status endpoint ${declared ? "reachable" : "unreachable"}`,
      up === declared,
      up === declared ? "" : `declared ${dims[dim]}, endpoint ${up ? "reachable" : "unreachable"}`,
    );
  }
}

// ── juju: charm config + relation topology ──────────────────────────────────

const MATRIX_APPS = [
  "kratos", "hydra", "login-ui", "tenant-service", "hook-service",
  "user-verification-service", "idp-dex", "idp-dex2",
];

/** The presence dimensions ARE relations on this backend. Each entry is
 *  [app, endpoint, peer, tfvars-key, label]; the attach path in
 *  matrix/juju-backend.mjs must know every one of these as an importable resource. */
export const JUJU_RELATIONS = [
  ["login-ui", "tenant-service-info", "tenant-service", "relate_tenant", "multi-tenancy"],
  ["kratos", "kratos-registration-webhook", "tenant-service", "relate_tenant", "tenant registration webhook"],
  ["kratos", "kratos-login-webhook", "tenant-service", "relate_tenant", "tenant login webhook"],
  ["hydra", "hydra-token-hook", "hook-service", "relate_hook", "token hook"],
  ["hook-service", "tenant-service-info", "tenant-service", "relate_tenant&&relate_hook", "tenant_id claim"],
  ["kratos", "kratos-registration-webhook", "user-verification-service", "relate_uvs", "uvs registration webhook"],
  ["kratos", "ui-endpoint-info", "user-verification-service", "relate_uvs", "uvs registration endpoint"],
];

const relationDeclared = (tfvars, key) => key.split("&&").every((k) => Boolean(tfvars[k]));

function relatedApps(statusJson, app, endpoint) {
  const rel = statusJson.applications?.[app]?.relations?.[endpoint] ?? [];
  return rel.map((e) => (typeof e === "string" ? e : e["related-application"])).filter(Boolean);
}

export function verifyJuju(dims, tfvars) {
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

  for (const [app, endpoint, peer, key, label] of JUJU_RELATIONS) {
    const expected = relationDeclared(tfvars, key);
    const present = relatedApps(s, app, endpoint).includes(peer);
    record(
      "juju",
      `${label} relation ${expected ? "present" : "absent"} (${app}:${endpoint} ↔ ${peer})`,
      present === expected,
      present === expected ? "" : `relation is ${present ? "present" : "absent"}`,
    );
  }
}
