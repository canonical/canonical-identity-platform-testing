// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import * as fs from "node:fs";
import { FullConfig } from "@playwright/test";
import { writeActiveConfig, ActiveConfig } from "./active-config";

/**
 * Keys /api/v0/app-config currently serves truthfully. Everything else it
 * omits or fabricates (PD-5), so only these may fail a run; the rest is
 * reported as product drift.
 */
const TRUTHFUL_APP_CONFIG_KEYS: (keyof ActiveConfig)[] = [
  "multi_tenancy_enabled",
  "oidc_webauthn_sequencing_enabled",
  "identifier_first_enabled",
  "base_url",
];

async function globalSetup(config: FullConfig) {
  const loginUiUrl = process.env.LOGIN_UI_URL || "http://localhost";
  const url = `${loginUiUrl}/api/v0/app-config`;
  const capabilitiesFile = process.env.BROWSER_TEST_CAPABILITIES;

  if (capabilitiesFile) {
    // Static mode (matrix lane): the declared capabilities file IS the active
    // configuration — discovery never drives gating, so a failed
    // reconfiguration cannot silently shrink the executed set. The live
    // app-config is still fetched, but only as an assertion subject: keys the
    // endpoint serves truthfully must agree with the declaration (drift =
    // deployment does not match the row — abort), and the rest is logged as
    // PD-5 product drift.
    console.log(`[global-setup] Static configuration from ${capabilitiesFile} (BROWSER_TEST_CAPABILITIES)`);
    const declaredRaw = JSON.parse(fs.readFileSync(capabilitiesFile, "utf-8")) as ActiveConfig & { juju?: Partial<ActiveConfig> };
    // Backend-divergent keys (compose: dex+google; juju: dex+dex2) live
    // under `juju` - flatten for the backend this run targets.
    const { juju: jujuOverrides, ...declaredBase } = declaredRaw;
    const declared = (process.env.MATRIX_BACKEND === "juju"
      ? { ...declaredBase, ...(jujuOverrides ?? {}) }
      : declaredBase) as ActiveConfig;
    // base_url is substrate-dependent (compose: http://localhost; juju: the
    // ingress LB). A runner-supplied LOGIN_UI_URL IS the declared base for
    // this run — write it into the active config so every consumer sees the
    // true base, and compare app-config against it below.
    if (process.env.LOGIN_UI_URL) {
      declared.base_url = process.env.LOGIN_UI_URL;
    }
    writeActiveConfig(declared);

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`[global-setup] app-config unreachable (HTTP ${res.status}) — is the deployment up?`);
    }
    const reported = await res.json() as Partial<ActiveConfig>;

    const drift = TRUTHFUL_APP_CONFIG_KEYS.filter(
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
    console.log(`[global-setup] Deployment agrees with the declaration on all truthfully-served keys`);
    return;
  }

  console.log(`[global-setup] Discovering dynamic deployment configuration from ${url}...`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }
    const data = await res.json() as ActiveConfig;
    // app-config does not report mail capability; discovery mode is only used
    // against the compose gate, which always ships mailslurper. Static mode
    // (BROWSER_TEST_CAPABILITIES above) takes the declared value verbatim.
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
