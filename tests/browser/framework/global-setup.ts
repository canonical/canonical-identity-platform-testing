// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import * as fs from "node:fs";
import { writeActiveConfig, ActiveConfig } from "./active-config";

// Keys /api/v0/app-config serves truthfully WHEN it serves them; present-and-different aborts, absent is a
// version fact (multi_tenancy_enabled entered the payload in login-ui v0.27.0) and only logs.
// canonical/identity-platform-login-ui@973f960 pkg/status/handlers.go `DeploymentInfo.MultiTenancyEnabled`
const TRUTHFUL_APP_CONFIG_KEYS: (keyof ActiveConfig)[] = [
  "multi_tenancy_enabled",
  "oidc_webauthn_sequencing_enabled",
  "identifier_first_enabled",
  "base_url",
];

async function globalSetup() {
  const loginUiUrl = process.env.LOGIN_UI_URL || "http://localhost";
  const url = `${loginUiUrl}/api/v0/app-config`;
  const capabilitiesFile = process.env.BROWSER_TEST_CAPABILITIES;

  if (capabilitiesFile) {
    // Static mode (matrix lane): the declaration IS the active config; app-config is only an assertion subject.
    console.log(`[global-setup] Static configuration from ${capabilitiesFile} (BROWSER_TEST_CAPABILITIES)`);
    const declaredRaw = JSON.parse(fs.readFileSync(capabilitiesFile, "utf-8")) as ActiveConfig & { juju?: Partial<ActiveConfig> };
    const { juju: jujuOverrides, ...declaredBase } = declaredRaw;
    const declared = (process.env.MATRIX_BACKEND === "juju"
      ? { ...declaredBase, ...(jujuOverrides ?? {}) }
      : declaredBase) as ActiveConfig;
    // base_url is substrate-dependent; a runner-supplied LOGIN_UI_URL is the declared base for this run.
    if (process.env.LOGIN_UI_URL) {
      declared.base_url = process.env.LOGIN_UI_URL;
    }
    writeActiveConfig(declared);

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`[global-setup] app-config unreachable (HTTP ${res.status}) — is the deployment up?`);
    }
    const reported = await res.json() as Partial<ActiveConfig>;

    const served = TRUTHFUL_APP_CONFIG_KEYS.filter((k) => k in reported);
    const omitted = TRUTHFUL_APP_CONFIG_KEYS.filter((k) => !(k in reported));
    const drift = served.filter(
      (k) => JSON.stringify(reported[k]) !== JSON.stringify(declared[k]),
    );
    if (drift.length > 0) {
      const detail = drift
        .map((k) => `${k}: declared ${JSON.stringify(declared[k])}, deployment reports ${JSON.stringify(reported[k])}`)
        .join("; ");
      throw new Error(
        `[global-setup] Deployment does not match the declared capabilities — refusing to run: ${detail}. ` +
        `Run \`node matrix/verify.mjs <row>\` for the full three-layer diagnosis.`,
      );
    }
    if (omitted.length > 0) {
      console.log(
        `[global-setup] app-config omits ${omitted.join(", ")} — this login-ui predates those fields; ` +
        `unverifiable from the endpoint, the declaration stands`,
      );
    }
    console.log(`[global-setup] Deployment agrees with the declaration on all ${served.length} truthfully-served key(s)`);
    return;
  }

  console.log(`[global-setup] Discovering dynamic deployment configuration from ${url}...`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }
    const data = await res.json() as ActiveConfig;
    // app-config does not report mail capability; discovery only runs against the compose gate, which ships mailslurper.
    data.mail_api = data.mail_api ?? true;
    writeActiveConfig(data);
    console.log(`[global-setup] Successfully cached active configuration in active-config.json`);

  } catch (err) {
    console.error(`\n[global-setup] FATAL: Failed to fetch active deployment configuration from ${url}`);
    console.error(`[global-setup] Error: ${err instanceof Error ? err.message : err}\n`);
    throw new Error(`Active config discovery failed. Ensure LOGIN_UI_URL is set correctly and services are running.`);
  }
}

export default globalSetup;
