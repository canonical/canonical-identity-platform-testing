// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Active Config reader/writer for the scenario-driven test framework.
 *
 * This module manages the cached runtime deployment configuration fetched from
 * the login-ui at the start of a test run.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ActiveConfig {
  oidc_webauthn_sequencing_enabled: boolean;
  base_url: string;
  identifier_first_enabled: boolean;
  multi_tenancy_enabled: boolean;
  support_email: string;
  flags: string[];

  services: string[];
  methods_1fa: string[];
  methods_2fa: string[];
  mfa_enforced: boolean | null;
  webauthn_enabled: boolean | null;
  oidc_enabled: boolean | null;
  local_users_enabled: boolean | null;
  registration_enabled: boolean | null;
  account_linking_enabled: boolean | null;
  oidc_providers: string[];

  /**
   * Mailslurper API reachable in this deployment. Discovery mode defaults to
   * true (the compose gate always ships mailslurper); static mode reads the
   * capabilities file verbatim — a mail-less target declares false.
   */
  mail_api?: boolean;
  /** login-ui version fork: true = the regeneration prompt renders after
   *  EVERY backup-code sign-in (iam.orange, ≥ v0.27); false/absent = only
   *  when ≤3 unused codes remain (the v0.28.0 workload). Gates the
   *  prompt-terminal vs callback-terminal scenario variants. */
  backup_code_prompt_on_use?: boolean;
  /** Hydra access-token shape: "jwt" | "opaque" (capabilities.json key; absent = unknown). */
  access_token_format?: string;
}

export const ACTIVE_CONFIG_FILENAME = "active-config.json";

/** Get the default active config path (in tests/browser/). */
export function getDefaultActiveConfigPath(): string {
  return path.resolve(__dirname, "..", ACTIVE_CONFIG_FILENAME);
}

/**
 * Read the active config from a JSON file.
 * Throws if the file doesn't exist or is invalid JSON.
 */
export function readActiveConfig(configPath?: string): ActiveConfig {
  const filePath = configPath ?? getDefaultActiveConfigPath();

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Active config file not found: ${filePath}\n` +
      `Ensure the global setup has run successfully, or check LOGIN_UI_URL.`
    );
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as ActiveConfig;
}

/**
 * Write the active config to a JSON file.
 * Creates the directory if it doesn't exist.
 */
export function writeActiveConfig(config: ActiveConfig, configPath?: string): void {
  const filePath = configPath ?? getDefaultActiveConfigPath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}
