// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

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
  verification_enabled?: boolean;
  oidc_providers: string[];

  /** Mailslurper API reachable. Discovery defaults to true; static mode reads the capabilities file verbatim. */
  mail_api?: boolean;
  /** login-ui version fork: true = regeneration prompt after EVERY backup-code sign-in (≥ v0.27); false/absent = only when ≤3 unused codes remain. */
  backup_code_prompt_on_use?: boolean;
  /** RFC 8628 device grant wired end-to-end (hydra urls.device + login-ui device pages). */
  device_flow?: boolean;
  /** Hydra access-token shape: "jwt" | "opaque" (absent = unknown). */
  access_token_format?: string;
}

export const ACTIVE_CONFIG_FILENAME = "active-config.json";

export function getDefaultActiveConfigPath(): string {
  return path.resolve(__dirname, "..", ACTIVE_CONFIG_FILENAME);
}

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

export function writeActiveConfig(config: ActiveConfig, configPath?: string): void {
  const filePath = configPath ?? getDefaultActiveConfigPath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}
