// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { readActiveConfig, type ActiveConfig } from "../framework/active-config";

/**
 * Centralized configuration for the unified browser test suite.
 *
 * All service URLs are read from environment variables with sensible defaults
 * matching the canonical port mapping documented in AGENTS.md.
 *
 * Deployment-capability lookups read the active configuration (see
 * `activeConfig()` below); tests use `requireProfile()` to skip when the
 * deployment doesn't include the required service.
 */

/** Read an environment variable or return the default. */
export function envOr(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/** Read a required environment variable or throw. */
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
}

export type ExecutionLane = "live" | "internal";

/**
 * Get the active browser test lane.
 *
 * - live: run only scenarios compatible with externally exposed surfaces
 * - internal: run full suite (default)
 */
export function getExecutionLane(): ExecutionLane {
  const lane = envOr("BROWSER_TEST_LANE", "internal").toLowerCase();
  return lane === "live" ? "live" : "internal";
}

/** Check whether the active lane is live. */
export function isLiveLane(): boolean {
  return getExecutionLane() === "live";
}

/**
 * Runtime toggle for WebAuthn-enabled scenarios.
 * Defaults to true to preserve existing behavior.
 */
export function isWebauthnEnabled(): boolean {
  return envOr("WEBAUTHN_ENABLED", "true").toLowerCase() === "true";
}

/**
 * Rollback toggle: disable lane compatibility enforcement.
 * Useful when rollout issues require temporarily restoring legacy behavior.
 */
export function isLaneEnforcementDisabled(): boolean {
  return envOr("BROWSER_DISABLE_LANE_ENFORCEMENT", "false").toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Service URLs (matching AGENTS.md port mapping)
// ---------------------------------------------------------------------------

export const KRATOS_PUBLIC_URL = envOr("KRATOS_PUBLIC_URL", "http://localhost:4433");
export const KRATOS_ADMIN_URL = envOr("KRATOS_ADMIN_URL", "http://localhost:4434");
export const HYDRA_PUBLIC_URL = envOr("HYDRA_PUBLIC_URL", "http://localhost:4444");
export const HYDRA_ADMIN_URL = envOr("HYDRA_ADMIN_URL", "http://localhost:4445");
export const OIDC_CONSUMER_URL = envOr("OIDC_CONSUMER_URL", "http://127.0.0.1:4446");
export const TENANT_SERVICE_URL = envOr("TENANT_SERVICE_URL", "http://localhost:8081");
export const HOOK_SERVICE_URL = envOr("HOOK_SERVICE_URL", "http://localhost:8080");
export const LOGIN_UI_URL = envOr("LOGIN_UI_URL", "http://localhost");
export const USER_VERIFICATION_URL = envOr("USER_VERIFICATION_URL", "http://localhost:8083");
export const OPENFGA_URL = envOr("OPENFGA_URL", "http://localhost:8180");
/** Mailslurper JSON service API. Distinct port from the 4436 web UI. */
export const MAIL_API_URL = envOr("MAIL_API_URL", "http://localhost:4437");
export const DEX_URL = envOr("DEX_URL", "http://dex:5556");

// ---------------------------------------------------------------------------
// Deployment capability lookups
// ---------------------------------------------------------------------------

/**
 * Resolve the active deployment configuration, declaration-first.
 *
 * One declaration system drives gating everywhere (docs/testing-spec.md):
 *  - Static mode: BROWSER_TEST_CAPABILITIES points at a matrix row's
 *    capabilities.json (matrix/rows/<row>/). The Makefile gate/seed targets
 *    and the matrix runner export it; the declaration IS the configuration,
 *    available even before globalSetup runs (seeder, collection time).
 *  - Discovery mode: the active-config.json cached by globalSetup from
 *    /api/v0/app-config. Keys the endpoint omits (PD-5) fall back to the
 *    documented defaults in the helpers below.
 */
export function activeConfig(): ActiveConfig {
  const declared = process.env.BROWSER_TEST_CAPABILITIES;
  if (declared) return readActiveConfig(declared);
  return readActiveConfig();
}

/** Check if a service is included in the active deployment. */
export function isServiceInProfile(service: string): boolean {
  return (activeConfig().services ?? []).includes(service);
}

/**
 * Whether local (password) users can log in on this deployment.
 *
 * In matrix/gate runs this is the row's declared capability; app-config omits
 * the key (PD-5), so discovery mode defaults to true — every gate profile
 * enables the local IdP, only matrix rows turn it off (and those always run
 * with a declaration).
 */
export function localUsersEnabled(): boolean {
  return activeConfig().local_users_enabled ?? true;
}

/**
 * Whether the active deployment enforces a second factor.
 *
 * login-ui's /api/v0/app-config does not report MFA state at all (PD-5) — its
 * `flags` array is identical whether MFA_ENABLED is true or false — so the
 * row's declared capabilities file is the ONLY source of truth. Discovery mode
 * defaults to true, matching the base compose (MFA_ENABLED=true).
 *
 * There is deliberately no env override: one would shift tier-B gating while
 * `scripts/expected-set.ts` (which reads the declaration) ignores it, letting
 * the two halves of the anti-silent-shrink contract disagree about the same
 * run. The declaration decides.
 */
export function isMfaEnforced(): boolean {
  return activeConfig().mfa_enforced ?? true;
}

/** Check if an OIDC provider is available in the active deployment. */
export function isOidcProviderInProfile(provider: string): boolean {
  return (activeConfig().oidc_providers ?? []).includes(provider);
}

/**
 * Require a service to be in the active deployment.
 * Returns true if available, false if the test should be skipped.
 * Use with: `test.skip(!requireProfile('tenant-service'), 'tenant-service not deployed')`
 */
export function requireProfile(service: string): boolean {
  return isServiceInProfile(service);
}

/** Check if multi-tenancy is enabled on the active deployment. */
export function isMultiTenancyEnabled(): boolean {
  return activeConfig().multi_tenancy_enabled === true;
}

// ---------------------------------------------------------------------------
// Auth credentials
// ---------------------------------------------------------------------------

/** Hydra client_credentials for tenant-service API access. */
export const AUTH_CLIENT_ID = envOr("AUTH_CLIENT_ID", "");
export const AUTH_CLIENT_SECRET = envOr("AUTH_CLIENT_SECRET", "");

// ---------------------------------------------------------------------------
// Google OIDC credentials
// ---------------------------------------------------------------------------

/** Google test account email (for browser test automation). */
export const GOOGLE_TEST_EMAIL = envOr("GOOGLE_TEST_EMAIL", "");

/** Google test account password (for browser test automation). */
export const GOOGLE_TEST_PASSWORD = envOr("GOOGLE_TEST_PASSWORD", "");

/** Google test account TOTP secret base32 (for browser test automation). */
export const GOOGLE_TEST_TOTP_SECRET = envOr("GOOGLE_TEST_TOTP_SECRET", "");

/** Google test account OIDC subject ID (the `sub` claim from the Google ID token). */
export const GOOGLE_TEST_SUBJECT_ID = envOr("GOOGLE_TEST_SUBJECT_ID", "");

/** Check if Google OIDC credentials are available for testing. */
export function googleCredentialsAvailable(): boolean {
  return !!(GOOGLE_TEST_EMAIL && GOOGLE_TEST_PASSWORD && GOOGLE_TEST_TOTP_SECRET && GOOGLE_TEST_SUBJECT_ID);
}

// ---------------------------------------------------------------------------
// Login-UI runtime config (fetched from /api/v0/app-config)
// ---------------------------------------------------------------------------

/** Cached app-config response from the login-ui. */
let _appConfig: Record<string, unknown> | null = null;

/**
 * Fetch the login-ui app-config from /api/v0/app-config.
 * Caches the result for the duration of the test run.
 */
export async function getAppConfig(): Promise<Record<string, unknown>> {
  if (_appConfig) return _appConfig;
  const res = await fetch(`${LOGIN_UI_URL}/api/v0/app-config`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch app-config: ${res.status} ${await res.text()}`);
  }
  _appConfig = await res.json() as Record<string, unknown>;
  return _appConfig;
}

/**
 * Check if OIDC WebAuthn sequencing is enabled in the login-ui.
 * When enabled, after OIDC provider authentication, the user must
 * also verify with a webauthn key (AAL2 step-up).
 */
export async function isOidcSequencingEnabled(): Promise<boolean> {
  const config = await getAppConfig().catch(
    (): Record<string, unknown> => ({}),
  );
  return config.oidc_webauthn_sequencing_enabled === true;
}

/**
 * Synchronous variant of `isOidcSequencingEnabled`, for test-collection time
 * where an async fetch is impossible. Reads the declared capabilities file
 * (BROWSER_TEST_CAPABILITIES) or the active-config.json that globalSetup
 * already cached; with neither available yet, sequencing is assumed off.
 */
export function isOidcSequencingEnabledSync(): boolean {
  try {
    return activeConfig().oidc_webauthn_sequencing_enabled === true;
  } catch {
    return false;
  }
}
