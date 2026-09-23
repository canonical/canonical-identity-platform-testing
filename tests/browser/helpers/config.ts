// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { readActiveConfig, type ActiveConfig } from "../framework/active-config";

export function envOr(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
}

export type ExecutionLane = "live" | "internal";

export function getExecutionLane(): ExecutionLane {
  const lane = envOr("BROWSER_TEST_LANE", "internal").toLowerCase();
  return lane === "live" ? "live" : "internal";
}

export function isLiveLane(): boolean {
  return getExecutionLane() === "live";
}

export function isLaneEnforcementDisabled(): boolean {
  return envOr("BROWSER_DISABLE_LANE_ENFORCEMENT", "false").toLowerCase() === "true";
}

export const KRATOS_PUBLIC_URL = envOr("KRATOS_PUBLIC_URL", "http://localhost:4433");
export const KRATOS_ADMIN_URL = envOr("KRATOS_ADMIN_URL", "http://localhost:4434");
export const HYDRA_PUBLIC_URL = envOr("HYDRA_PUBLIC_URL", "http://localhost:4444");
export const HYDRA_ADMIN_URL = envOr("HYDRA_ADMIN_URL", "http://localhost:4445");
export const OIDC_CONSUMER_URL = envOr("OIDC_CONSUMER_URL", "http://127.0.0.1:4446");
export const TENANT_SERVICE_URL = envOr("TENANT_SERVICE_URL", "http://localhost:8081");
export const HOOK_SERVICE_URL = envOr("HOOK_SERVICE_URL", "http://localhost:8080");
export const LOGIN_UI_URL = envOr("LOGIN_UI_URL", "http://localhost");
export const USER_VERIFICATION_URL = envOr("USER_VERIFICATION_URL", "http://localhost:8083");
/** Mailslurper JSON service API. Distinct port from the 4436 web UI. */
export const MAIL_API_URL = envOr("MAIL_API_URL", "http://localhost:4437");
export const DEX_URL = envOr("DEX_URL", "http://dex:5556");

// Declaration-first: BROWSER_TEST_CAPABILITIES (matrix row capabilities.json) else globalSetup's cached active-config.json.
export function activeConfig(): ActiveConfig {
  const declared = process.env.BROWSER_TEST_CAPABILITIES;
  if (declared) return readActiveConfig(declared);
  return readActiveConfig();
}

export function isServiceInProfile(service: string): boolean {
  return (activeConfig().services ?? []).includes(service);
}

// app-config omits the key; discovery mode defaults to true (every gate profile enables the local IdP).
export function localUsersEnabled(): boolean {
  return activeConfig().local_users_enabled ?? true;
}

// app-config does not report MFA state, so the declaration is the only source of truth (discovery
// defaults to true). No env override: scripts/expected-set.ts reads the declaration; both halves must agree.
export function isMfaEnforced(): boolean {
  return activeConfig().mfa_enforced ?? true;
}

export function isOidcProviderInProfile(provider: string): boolean {
  return (activeConfig().oidc_providers ?? []).includes(provider);
}

export const AUTH_CLIENT_ID = envOr("AUTH_CLIENT_ID", "");
export const AUTH_CLIENT_SECRET = envOr("AUTH_CLIENT_SECRET", "");

// Google test account for live OIDC runs; SUBJECT_ID is the `sub` claim of its ID token.
export const GOOGLE_TEST_EMAIL = envOr("GOOGLE_TEST_EMAIL", "");

export const GOOGLE_TEST_PASSWORD = envOr("GOOGLE_TEST_PASSWORD", "");

export const GOOGLE_TEST_TOTP_SECRET = envOr("GOOGLE_TEST_TOTP_SECRET", "");

export const GOOGLE_TEST_SUBJECT_ID = envOr("GOOGLE_TEST_SUBJECT_ID", "");

export function googleCredentialsAvailable(): boolean {
  return !!(GOOGLE_TEST_EMAIL && GOOGLE_TEST_PASSWORD && GOOGLE_TEST_TOTP_SECRET && GOOGLE_TEST_SUBJECT_ID);
}

let _appConfig: Record<string, unknown> | null = null;

export async function getAppConfig(): Promise<Record<string, unknown>> {
  if (_appConfig) return _appConfig;
  const res = await fetch(`${LOGIN_UI_URL}/api/v0/app-config`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch app-config: ${res.status} ${await res.text()}`);
  }
  _appConfig = await res.json() as Record<string, unknown>;
  return _appConfig;
}

// When enabled, OIDC provider auth is followed by a webauthn verify (AAL2 step-up).
export async function isOidcSequencingEnabled(): Promise<boolean> {
  const config = await getAppConfig().catch(
    (): Record<string, unknown> => ({}),
  );
  return config.oidc_webauthn_sequencing_enabled === true;
}

// Collection-time variant: reads the declaration or cached active-config; neither yet → off.
export function isOidcSequencingEnabledSync(): boolean {
  try {
    return activeConfig().oidc_webauthn_sequencing_enabled === true;
  } catch {
    return false;
  }
}
