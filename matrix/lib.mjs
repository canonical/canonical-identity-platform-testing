// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Shared row math for the config matrix: dimension order, the charm-faithful
// derivation (mirrors kratos-operator/templates/kratos.yaml.j2 — citations in
// config-model.mjs), the compose materializer, and the capabilities manifest.
// Used by generate.mjs (emit) and verify.mjs (assert the same expectations
// against a live deployment).

import { model } from "./config-model.mjs";

export const DIMS = model.dimensions.map((d) => d.id);
export const VALUES = Object.fromEntries(model.dimensions.map((d) => [d.id, d.values]));

/** Charm-faithful derivation of service-level settings from model coordinates.
 *
 *  `webauthn: null` (pinned gate profiles only) is the documented off-model
 *  shape: kratos webauthn ENABLED as a pure second factor (passwordless:false,
 *  no sequencing). kratos-operator cannot produce it (j2:257-265), so it earns
 *  no pair credit, but the materializer renders it faithfully — null !== "none"
 *  → enabled; null is neither "passwordless" nor "sequencing" → both false. */
export function derive(d) {
  const local = d.local_idp === "on";
  const mfa = d.mfa === "enforced";
  const seq = d.webauthn === "sequencing";
  return {
    password: local,
    profile: local,
    code: local, // (recovery_ui ∨ verification) ∧ local_idp; recovery URL always published
    totp: local && mfa,
    lookup: seq || (mfa && local),
    webauthnEnabled: d.webauthn !== "none",
    passwordless: d.webauthn === "passwordless",
    recovery: local,
    verificationFlow: d.verification === "on" && local,
    aal: seq || (local && mfa) ? "highest_available" : "aal1",
    oidc: d.providers !== "0",
    tenant: d.tenant_service === "present",
    hook: d.hook_service === "present",
    uvs: d.user_verification === "present",
    jwt: d.access_token === "jwt",
  };
}

const B = (b) => (b ? "true" : "false");

/** The exact env the materializer sets on each service — single source for
 *  the override emitter AND the compose-layer verifier. */
export function expectedEnv(dims) {
  const v = derive(dims);
  const kratos = {
    SELFSERVICE_METHODS_PASSWORD_ENABLED: B(v.password),
    SELFSERVICE_METHODS_PROFILE_ENABLED: B(v.profile),
    SELFSERVICE_METHODS_CODE_ENABLED: B(v.code),
    SELFSERVICE_METHODS_TOTP_ENABLED: B(v.totp),
    SELFSERVICE_METHODS_LOOKUP_SECRET_ENABLED: B(v.lookup),
    SELFSERVICE_METHODS_WEBAUTHN_ENABLED: B(v.webauthnEnabled),
    ...(v.webauthnEnabled
      ? { SELFSERVICE_METHODS_WEBAUTHN_CONFIG_PASSWORDLESS: B(v.passwordless) }
      : {}),
    SELFSERVICE_FLOWS_RECOVERY_ENABLED: B(v.recovery),
    SELFSERVICE_FLOWS_VERIFICATION_ENABLED: B(v.verificationFlow),
    SESSION_WHOAMI_REQUIRED_AAL: v.aal,
  };
  const loginUi = {
    MFA_ENABLED: B(dims.mfa === "enforced"),
    OIDC_WEBAUTHN_SEQUENCING_ENABLED: B(dims.webauthn === "sequencing"),
    VERIFICATION_ENABLED: B(v.verificationFlow),
    ...(v.tenant
      ? { MULTI_TENANCY_ENABLED: "true", TENANT_SERVICE_GRPC_ADDRESS: "tenant-service:50051" }
      : {}),
  };
  const hydra = {
    ...(!v.jwt ? { STRATEGIES_ACCESS_TOKEN: "opaque" } : {}),
    ...(v.hook
      ? {
          OAUTH2_TOKEN_HOOK_URL: "http://hook-service:8080/api/v0/hook/hydra",
          OAUTH2_TOKEN_HOOK_AUTH_TYPE: "api_key",
          OAUTH2_TOKEN_HOOK_AUTH_CONFIG_IN: "header",
          OAUTH2_TOKEN_HOOK_AUTH_CONFIG_NAME: "Authorization",
          OAUTH2_TOKEN_HOOK_AUTH_CONFIG_VALUE: "hook-service-token",
          OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS: v.tenant ? "groups,tenant_id" : "groups",
        }
      : {}),
  };
  return { kratos, "login-ui": loginUi, hydra };
}

export function kratosConfigFiles(dims) {
  const files = ["/etc/config/kratos/kratos.yml"];
  if (dims.providers === "1") files.push("/etc/config/kratos/kratos.dex.yml");
  if (dims.providers === "2") files.push("/etc/config/kratos/kratos.google.yml");
  return files;
}

export function composeOverride(name, kind, dims) {
  const v = derive(dims);
  const env = expectedEnv(dims);

  const lines = [];
  lines.push(`# Matrix row: ${name} (${kind}) — GENERATED, DO NOT EDIT.`);
  lines.push(`# Source of truth: matrix/config-model.mjs; regenerate with \`make matrix-generate\`.`);
  lines.push(`# ${DIMS.map((k) => `${k}=${dims[k]}`).join(" ")}`);
  lines.push(``);
  lines.push(`services:`);

  lines.push(`  kratos:`);
  lines.push(`    environment:`);
  for (const [k, val] of Object.entries(env.kratos)) lines.push(`      - ${k}=${val}`);
  lines.push(`    command: exec kratos serve ${kratosConfigFiles(dims).map((c) => `-c ${c}`).join(" ")} --dev --watch-courier`);
  lines.push(``);

  lines.push(`  login-ui:`);
  lines.push(`    environment:`);
  for (const [k, val] of Object.entries(env["login-ui"])) lines.push(`      - ${k}=${val}`);
  lines.push(``);

  if (Object.keys(env.hydra).length > 0) {
    lines.push(`  hydra:`);
    lines.push(`    environment:`);
    if (env.hydra.STRATEGIES_ACCESS_TOKEN) {
      lines.push(`      - STRATEGIES_ACCESS_TOKEN=${env.hydra.STRATEGIES_ACCESS_TOKEN}`);
    }
    if (v.hook) {
      lines.push(`      # Compose analog of the hydra-token-hook relation (relation-only in charms;`);
      lines.push(`      # hydra fails token issuance when the hook is unreachable, so this block`);
      lines.push(`      # exists only on rows that deploy hook-service).`);
      for (const k of [
        "OAUTH2_TOKEN_HOOK_URL",
        "OAUTH2_TOKEN_HOOK_AUTH_TYPE",
        "OAUTH2_TOKEN_HOOK_AUTH_CONFIG_IN",
        "OAUTH2_TOKEN_HOOK_AUTH_CONFIG_NAME",
        "OAUTH2_TOKEN_HOOK_AUTH_CONFIG_VALUE",
      ]) {
        lines.push(`      - ${k}=${env.hydra[k]}`);
      }
      lines.push(`      # Charm renders allowed_top_level_claims from the relation's claim list`);
      lines.push(`      # (groups, + tenant_id iff hook↔tenant-service related).`);
      lines.push(`      - OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS=${env.hydra.OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS}`);
    }
    lines.push(``);
  }

  const absent = [];
  if (!v.tenant) absent.push("tenant-service");
  if (!v.hook) absent.push("hook-service");
  if (!v.uvs) absent.push("user-verification-service");
  for (const svc of absent) {
    lines.push(`  ${svc}:`);
    lines.push(`    scale: 0`);
    lines.push(``);
  }

  return lines.join("\n");
}

/** Optional add-on services toggled by the model (base services always run). */
export const TOGGLED_SERVICES = {
  tenant_service: "tenant-service",
  hook_service: "hook-service",
  user_verification: "user-verification-service",
};

// Ground-truth capability manifest, shaped like the suite's ActiveConfig
// (tests/browser/framework/active-config.ts) plus two extra keys. This is what
// the deployment ACTUALLY is — comparing it against the live /api/v0/app-config
// response is itself a test of PD-5.
//
// `overrides` is a row's `caps` block (seed rows only): row-level truths that
// are NOT dimensions because no charm option or relation produces them — a
// target with no mailslurper and no dex is a property of that deployment, not
// of the platform's configuration space. It is a SHALLOW override, and it is
// checked rather than trusted: an unknown key is a typo and a no-op value is
// dead weight, so both throw at generation time instead of silently shaping the
// executed set.
export function capabilities(dims, overrides = {}) {
  const v = derive(dims);
  const services = ["kratos", "hydra", "login-ui", "dex", "openfga"];
  if (v.tenant) services.push("tenant-service");
  if (v.hook) services.push("hook-service");
  if (v.uvs) services.push("user-verification-service");

  const methods_1fa = [];
  if (v.password) methods_1fa.push("password");
  if (v.oidc) methods_1fa.push("oidc");
  if (v.passwordless) methods_1fa.push("webauthn");

  const methods_2fa = [];
  if (v.totp) methods_2fa.push("totp");
  if (v.lookup) methods_2fa.push("backup_codes");
  // webauthn is a second factor under sequencing, and on the off-model
  // (webauthn: null) gate profiles whenever a second factor is enforced.
  if (dims.webauthn === "sequencing" || (dims.webauthn === null && dims.mfa === "enforced")) {
    methods_2fa.push("webauthn");
  }

  const flags = [];
  if (v.password) flags.push("password");
  if (v.webauthnEnabled) flags.push("webauthn");
  if (v.totp) flags.push("totp");
  if (v.lookup) flags.push("backup_codes");
  if (v.oidc) flags.push("account_linking");

  const caps = {
    oidc_webauthn_sequencing_enabled: dims.webauthn === "sequencing",
    base_url: "http://localhost",
    identifier_first_enabled: true,
    multi_tenancy_enabled: v.tenant,
    support_email: "",
    flags,
    services,
    methods_1fa,
    methods_2fa,
    mfa_enforced: dims.mfa === "enforced",
    webauthn_enabled: v.webauthnEnabled,
    oidc_enabled: v.oidc,
    local_users_enabled: dims.local_idp === "on",
    registration_enabled: true,
    account_linking_enabled: v.oidc,
    oidc_providers: dims.providers === "0" ? [] : dims.providers === "1" ? ["dex"] : ["dex", "google"],
    verification_enabled: v.verificationFlow,
    access_token_format: dims.access_token,
    // Mail is a declared capability, not an assumption: both backends deploy
    // mailslurper today, so every dims-derived row is true. A row whose TARGET
    // has no mail API declares `caps: { mail_api: false }` in the model and the
    // suite gates mail-dependent scenarios off at runtime (requires.mailApi).
    mail_api: true,
    // login-ui VERSION fork, observed on both sides: the v0.28.0 workload the
    // compose/juju stacks run only offers the backup-code regeneration prompt
    // when the identity is running low (≤3 unused codes — fresh 12, burn 1 →
    // straight to the callback, measured 2026-08-31 on ghcr :stable), while
    // iam.orange.canonical.com (login-ui ≥ v0.27, measured 2026-08-27 and
    // 2026-08-31) renders the prompt after EVERY backup-code sign-in — and its
    // "I don't need new codes" resumption is broken there (session suite
    // note), so the prompt is a terminal on that target. Rows whose target
    // behaves the old way declare `caps: { backup_code_prompt_on_use: true }`;
    // the suite gates the prompt-terminal vs callback-terminal scenario
    // variants on it (requires.backupCodePromptOnUse).
    backup_code_prompt_on_use: false,
    // Backend-divergent keys: the juju lane renders its second provider as
    // a second dex client (idp-dex2 integrator - google needs real
    // credentials the harness lacks), so providers=2 rows offer [dex, dex2]
    // there, not [dex, google]. Consumers flatten `juju` over the base by
    // MATRIX_BACKEND (matrix/verify.mjs, framework/global-setup.ts).
    ...(dims.providers === "2" ? { juju: { oidc_providers: ["dex", "dex2"] } } : {}),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in caps)) {
      throw new Error(`capabilities override '${key}' names no derived capability key`);
    }
    if (JSON.stringify(caps[key]) === JSON.stringify(value)) {
      throw new Error(`capabilities override '${key}' repeats the derived value — delete it`);
    }
    caps[key] = value;
  }
  return caps;
}

export function rowName(dims) {
  const code =
    `l${dims.local_idp === "on" ? 1 : 0}` +
    `m${dims.mfa === "enforced" ? 1 : 0}` +
    `v${dims.verification === "on" ? 1 : 0}` +
    `w${dims.webauthn[0]}` +
    `p${dims.providers}` +
    `t${dims.tenant_service === "present" ? 1 : 0}` +
    `h${dims.hook_service === "present" ? 1 : 0}` +
    `u${dims.user_verification === "present" ? 1 : 0}` +
    `a${dims.access_token[0]}`;
  return `mx-${code}`;
}

/**
 * Juju-backend materialization: model row → terraform variable values for
 * matrix/backends/juju/root. Charm CONFIG here, not service config — the
 * operators render kratos.yaml/hydra.yaml themselves; that is the point of
 * the charmed lane. Presence dimensions become relation toggles (all add-on
 * apps stay deployed), and provider count toggles the integrators' own
 * `enabled` config (the charm's supported disable path) rather than churning
 * relations.
 */
export function jujuTfvars(dims) {
  const v = derive(dims);
  return {
    kratos_config: {
      enable_local_idp: B(dims.local_idp === "on"),
      enforce_mfa: B(dims.mfa === "enforced"),
      enable_verification: B(dims.verification === "on"),
      enable_passwordless_login_method: B(v.passwordless),
      enable_oidc_webauthn_sequencing: B(dims.webauthn === "sequencing"),
    },
    hydra_config: {
      jwt_access_tokens: B(v.jwt),
    },
    idp_dex_enabled: dims.providers !== "0",
    idp_dex2_enabled: dims.providers === "2",
    relate_tenant: v.tenant,
    relate_hook: v.hook,
    relate_uvs: v.uvs,
  };
}
