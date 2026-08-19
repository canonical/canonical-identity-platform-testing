// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Manage Kratos identities via the admin API.
 *
 * Ported from tenant-service/tests/browser/helpers/kratos.ts and
 * login-ui/ui/tests/helpers/kratosIdentities.ts.
 * Uses fetch() API (no execSync) for portability.
 */

import { KRATOS_ADMIN_URL, KRATOS_PUBLIC_URL, LOGIN_UI_URL, envOr } from "./config";

const IDENTITY_SCHEMA_ID = envOr("KRATOS_IDENTITY_SCHEMA_ID", "default");
import { generateTotpCode } from "./totp";

export interface CreateIdentityOpts {
  email: string;
  password: string;
  name?: string;
  surname?: string;
}

export interface CreateIdentityWithOIDCOpts {
  email: string;
  provider: string;
  subject: string;
  name?: string;
  surname?: string;
}

/** Create a Kratos identity with password credentials. Returns the identity id. */
export async function createIdentity(
  opts: CreateIdentityOpts,
): Promise<string> {
  const body = {
    schema_id: IDENTITY_SCHEMA_ID,
    credentials: { password: { config: { password: opts.password } } },
    traits: {
      email: opts.email,
      name: opts.name ?? "Test",
      surname: opts.surname ?? "User",
    },
  };

  const res = await fetch(`${KRATOS_ADMIN_URL}/admin/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `failed to create identity ${opts.email}: ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Mark a Kratos identity's email as verified via JSON Patch.
 *
 * Kratos creates identities with `verifiable_addresses/0/verified: false`
 * and `verifiable_addresses/0/status: "pending"` by default. This function
 * patches both fields to mark the email as verified.
 *
 * @param identityId — The Kratos identity UUID.
 */
export async function markVerified(identityId: string): Promise<void> {
  const patchOps = [
    { op: "replace", path: "/verifiable_addresses/0/verified", value: true },
    { op: "replace", path: "/verifiable_addresses/0/status", value: "completed" },
  ];

  const res = await fetch(
    `${KRATOS_ADMIN_URL}/admin/identities/${identityId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchOps),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `failed to mark identity ${identityId} as verified: ${res.status} ${text}`,
    );
  }
}

/** Delete the identity with the given id. Idempotent (ignores 404). */
export async function deleteIdentity(id: string): Promise<void> {
  const res = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`failed to delete identity ${id}: ${res.status}`);
  }
}

/**
 * Reset an identity's password via the admin API.
 *
 * Used by the "restore-password" scenario cleanup: the recovery scenarios drive
 * a real self-service password change against a shared seeded identity, and
 * every later spec still authenticates with the manifest password.
 *
 * Uses PUT with the full identity rather than a JSON-Patch on
 * /credentials/password/config/password. Kratos accepts that patch with a 200
 * and silently does nothing — the stored credential keeps a hashed password and
 * the plaintext patch never reaches the hasher — so the patch form looks like it
 * works while leaving the old password in place. PUT re-runs the credential
 * pipeline properly; other credential types (totp, webauthn) are preserved.
 */
export async function setIdentityPassword(
  id: string,
  password: string,
): Promise<void> {
  const current = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${id}`);
  if (!current.ok) {
    throw new Error(
      `failed to read identity ${id}: ${current.status} ${await current.text()}`,
    );
  }
  const identity = (await current.json()) as {
    schema_id: string;
    traits: unknown;
    state: string;
    metadata_public?: unknown;
    metadata_admin?: unknown;
  };

  const res = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_id: identity.schema_id,
      traits: identity.traits,
      state: identity.state,
      metadata_public: identity.metadata_public,
      metadata_admin: identity.metadata_admin,
      credentials: { password: { config: { password } } },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `failed to reset password for ${id}: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Return the first unused Kratos lookup secret (backup code) for an identity.
 *
 * Backup codes are one-shot. The manifest records only the first code issued at
 * seed time, so any scenario that reads it burns it — and every later run finds
 * it spent. Reading the live credential instead keeps backup-code scenarios
 * idempotent for as long as unused codes remain.
 */
export async function getUnusedBackupCode(identityId: string): Promise<string> {
  const res = await fetch(
    `${KRATOS_ADMIN_URL}/admin/identities/${identityId}?include_credential=lookup_secret`,
  );
  if (!res.ok) {
    throw new Error(
      `failed to read lookup secrets for ${identityId}: ${res.status} ${await res.text()}`,
    );
  }
  const identity = (await res.json()) as {
    credentials?: {
      lookup_secret?: {
        config?: { recovery_codes?: { code: string; used_at: string | null }[] };
      };
    };
  };
  const codes = identity.credentials?.lookup_secret?.config?.recovery_codes ?? [];
  const unused = codes.find((c) => c.used_at === null);
  if (!unused) {
    throw new Error(
      `identity ${identityId} has no unused backup codes left (${codes.length} seeded, all spent). ` +
        `Run "make seed-test-data-clean" to re-seed.`,
    );
  }
  return unused.code;
}

/**
 * Consume backup codes through native AAL2 login flows, leaving the rest unused.
 *
 * Used by the seeder to put an identity into the "running low on backup codes"
 * state, which is the only state in which login-ui offers the regeneration
 * prompt (it triggers at three or fewer unused codes remaining).
 */
export async function burnBackupCodes(
  sessionToken: string,
  codes: string[],
): Promise<void> {
  for (const code of codes) {
    const flowRes = await fetch(
      `${KRATOS_PUBLIC_URL}/self-service/login/api?aal=aal2&refresh=true`,
      { headers: { "X-Session-Token": sessionToken, Accept: "application/json" } },
    );
    if (!flowRes.ok) {
      throw new Error(
        `failed to create aal2 login flow: ${flowRes.status} ${await flowRes.text()}`,
      );
    }
    const { id } = (await flowRes.json()) as { id: string };

    const submit = await fetch(
      `${KRATOS_PUBLIC_URL}/self-service/login?flow=${id}`,
      {
        method: "POST",
        headers: {
          "X-Session-Token": sessionToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ method: "lookup_secret", lookup_secret: code }),
      },
    );
    if (!submit.ok) {
      throw new Error(
        `failed to burn backup code: ${submit.status} ${await submit.text()}`,
      );
    }
  }
}

/**
 * Delete one credential type from an identity via the admin API.
 *
 * Idempotent: Kratos answers 204 even when the identity does not have that
 * credential, and for `webauthn` it removes the registered keys while leaving
 * the credential record — and therefore the user handle Kratos allocated at
 * identity creation — in place, so the identity is left as the seeder made it.
 *
 * Preferred over a public settings flow for cleanup: it needs no browser
 * session, so it still runs after a scenario failed halfway and left the
 * browser somewhere unauthenticated.
 */
export async function deleteIdentityCredentialType(
  id: string,
  type: "totp" | "webauthn" | "lookup_secret",
): Promise<void> {
  const res = await fetch(
    `${KRATOS_ADMIN_URL}/admin/identities/${id}/credentials/${type}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(
      `failed to delete ${type} credential for ${id}: ${res.status} ${text}`,
    );
  }
}

/** Delete all sessions for the given identity. */
export async function deleteIdentitySessions(id: string): Promise<void> {
  await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${id}/sessions`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Session token helpers (for programmatic settings flow)
// ---------------------------------------------------------------------------

/**
 * Create a session token for a Kratos identity by performing a native login.
 *
 * Uses the Kratos public API's native login flow:
 *   1. Create a login flow via `GET /self-service/login/api`
 *   2. Submit credentials via `POST /self-service/login` to obtain a session token
 *
 * This allows the seeder to drive self-service settings flows on behalf of a
 * user without browser interaction.
 *
 * @param email — The identity's email (login identifier).
 * @param password — The identity's password.
 * @returns The session token string.
 */
export async function createSessionToken(
  email: string,
  password: string,
): Promise<string> {
  // Step 1: Create a native login flow
  const createRes = await fetch(`${KRATOS_PUBLIC_URL}/self-service/login/api`, {
    method: "GET",
    headers: { "Accept": "application/json" },
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`failed to create login flow: ${createRes.status} ${text}`);
  }

  const flowData = (await createRes.json()) as { id: string };
  const flowId = flowData.id;

  // Step 2: Submit credentials to the login flow
  const submitRes = await fetch(
    `${KRATOS_PUBLIC_URL}/self-service/login?flow=${flowId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        method: "password",
        identifier: email,
        password,
      }),
    },
  );

  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(
      `failed to login as ${email}: ${submitRes.status} ${text}`,
    );
  }

  const loginData = (await submitRes.json()) as {
    session_token?: string;
    continue_with?: Array<{ action: string; flow?: { id: string } }>;
  };

  // If the user has TOTP configured, the login flow requires AAL2.
  // The response will contain a `continue_with` array with an
  // `ask_aal2` action instead of a session_token.
  if (!loginData.session_token) {
    // Check if AAL2 is required (TOTP verification needed)
    const aal2Action = loginData.continue_with?.find(
      (c) => c.action === "ask_aal2",
    );
    if (aal2Action) {
      throw new Error(
        `login as ${email} requires AAL2 (TOTP) — cannot create session token for a user that already has TOTP configured. ` +
        `This should only happen during incremental backfill when TOTP is already enrolled.`,
      );
    }
    throw new Error(
      `login as ${email} did not return a session token: ${JSON.stringify(loginData)}`,
    );
  }

  return loginData.session_token;
}

/**
 * Initiate a TOTP settings flow for an authenticated user.
 *
 * Calls `GET /self-service/settings/api` with a Bearer session token,
 * then parses the flow response to find the TOTP secret key node.
 *
 * The TOTP secret is returned in a `text` node with `id: "totp_secret_key"`.
 * The actual base32 secret is in `attributes.text.context.secret`.
 *
 * @param sessionToken — A valid Kratos session token (from createSessionToken).
 * @returns An object with the flow ID and the extracted base32 TOTP secret.
 */
export async function initTotpSettingsFlow(
  sessionToken: string,
): Promise<{ flowId: string; totpSecret: string }> {
  // Step 1: Create a settings flow via the API endpoint
  const createRes = await fetch(`${KRATOS_PUBLIC_URL}/self-service/settings/api`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${sessionToken}`,
      "Accept": "application/json",
    },
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(
      `failed to create settings flow: ${createRes.status} ${text}`,
    );
  }

  const flowData = (await createRes.json()) as {
    id: string;
    ui?: {
      nodes?: Array<{
        type?: string;
        group?: string;
        attributes?: {
          id?: string;
          name?: string;
          node_type?: string;
          text?: {
            context?: {
              secret?: string;
            };
          };
        };
      }>;
    };
  };

  const flowId = flowData.id;

  // Step 2: Find the totp_secret_key text node in the flow UI
  // Kratos returns the TOTP secret in a text node with id "totp_secret_key".
  // The base32 secret is in attributes.text.context.secret.
  const totpNode = flowData.ui?.nodes?.find(
    (n) =>
      n.group === "totp" &&
      n.attributes?.id === "totp_secret_key" &&
      n.attributes?.text?.context?.secret,
  );

  if (!totpNode) {
    const nodeSummary = flowData.ui?.nodes
      ?.filter((n) => n.group === "totp")
      .map((n) => `${n.type}/${n.attributes?.id ?? n.attributes?.name}`)
      .join(", ");
    throw new Error(
      `TOTP secret key not found in settings flow ${flowId}. ` +
      `TOTP nodes: ${nodeSummary ?? "none"}`,
    );
  }

  const totpSecret = totpNode.attributes!.text!.context!.secret!;

  return { flowId, totpSecret };
}

/**
 * Confirm TOTP enrollment by submitting a valid TOTP code.
 *
 * Calls `POST /self-service/settings` with the TOTP code to confirm
 * enrollment. Throws if Kratos returns an error.
 *
 * @param flowId — The settings flow ID (from initTotpSettingsFlow).
 * @param sessionToken — A valid Kratos session token.
 * @param totpCode — A valid TOTP code generated from the secret.
 */
export async function confirmTotpEnrollment(
  flowId: string,
  sessionToken: string,
  totpCode: string,
): Promise<void> {
  const res = await fetch(
    `${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flowId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        method: "totp",
        totp_code: totpCode,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `failed to confirm TOTP enrollment for flow ${flowId}: ${res.status} ${text}`,
    );
  }
}

// ---------------------------------------------------------------------------
// OTPAuth URI parsing
// ---------------------------------------------------------------------------

/**
 * Extract the base32 secret from an `otpauth://totp/...` URI.
 *
 * The URI format is:
 *   otpauth://totp/<issuer>:<email>?secret=<base32>&issuer=<issuer>&algorithm=...
 *
 * @param uri — The otpauth:// URI string.
 * @returns The base32 secret string.
 */
export function extractSecretFromOtpauthUri(uri: string): string {
  if (!uri.startsWith("otpauth://")) {
    throw new Error(`not an otpauth URI: ${uri}`);
  }

  try {
    const url = new URL(uri);
    const secret = url.searchParams.get("secret");
    if (!secret) {
      throw new Error(`missing "secret" query parameter in otpauth URI: ${uri}`);
    }
    return secret;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`malformed otpauth URI: ${uri}`);
    }
    throw err;
  }
}

/**
 * Generate backup codes (lookup_secret) for an authenticated user.
 *
 * After TOTP is configured, backup codes can be generated by submitting
 * a settings flow with `method: "lookup_secret"` and
 * `lookup_secret_regenerate: true`. Kratos will create a set of recovery
 * codes and require confirmation via `lookup_secret_confirm`.
 *
 * IMPORTANT: This must be called in the SAME settings flow as TOTP
 * confirmation, because after TOTP is configured, creating a new settings
 * flow requires AAL2 authentication.
 *
 * @param flowId — The settings flow ID (same flow used for TOTP confirmation).
 * @param sessionToken — A valid Kratos session token.
 * @returns An array of backup code strings.
 */
export async function generateBackupCodes(
  flowId: string,
  sessionToken: string,
): Promise<string[]> {
  // Step 1: Submit the lookup_secret regenerate to generate backup codes
  const regenerateRes = await fetch(
    `${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flowId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        method: "lookup_secret",
        lookup_secret_regenerate: true,
      }),
    },
  );

  if (!regenerateRes.ok) {
    const text = await regenerateRes.text();
    throw new Error(
      `failed to generate backup codes for flow ${flowId}: ${regenerateRes.status} ${text}`,
    );
  }

  const regenerateData = (await regenerateRes.json()) as {
    id?: string;
    state?: string;
    ui?: {
      nodes?: Array<{
        group?: string;
        type?: string;
        attributes?: {
          id?: string;
          name?: string;
          node_type?: string;
          text?: {
            context?: {
              secrets?: Array<{
                context?: {
                  secret?: string;
                };
              }>;
            };
          };
        };
      }>;
    };
  };

  // Step 2: Extract the backup codes from the response
  const backupCodes: string[] = [];
  for (const node of regenerateData.ui?.nodes ?? []) {
    if (node.group === "lookup_secret" && node.type === "text") {
      const secrets = node.attributes?.text?.context?.secrets;
      if (secrets && Array.isArray(secrets)) {
        for (const secret of secrets) {
          if (secret.context?.secret) {
            backupCodes.push(secret.context.secret);
          }
        }
      }
    }
  }

  // Step 3: Confirm the backup codes
  // Kratos requires a confirmation step to actually save the backup codes
  const confirmRes = await fetch(
    `${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flowId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        method: "lookup_secret",
        lookup_secret_confirm: true,
      }),
    },
  );

  if (!confirmRes.ok) {
    const text = await confirmRes.text();
    throw new Error(
      `failed to confirm backup codes for flow ${flowId}: ${confirmRes.status} ${text}`,
    );
  }

  return backupCodes;
}

/** A Kratos identity as the admin list endpoint returns it. */
export interface KratosIdentity {
  id: string;
  traits?: { email?: string };
}

/** List every Kratos identity, following keyset pagination to the end.
 *
 *  Kratos returns at most one page and advertises the next one in a `Link`
 *  header (`rel="next"` carrying `page_token`); the terminal page simply omits
 *  that link. The previous `?per_page=200` one-shot silently truncated: on a
 *  deployment with more identities than the page size, cleanup saw only the
 *  first page and `findIdentityByEmail` returned null for users that exist,
 *  which makes the seeder try to re-create them. */
export async function listIdentities(pageSize = 250): Promise<KratosIdentity[]> {
  const all: KratosIdentity[] = [];
  let pageToken = "";
  // Bounded: a server echoing the same token back must not spin forever.
  for (let page = 0; page < 500; page++) {
    const url = new URL(`${KRATOS_ADMIN_URL}/admin/identities`);
    url.searchParams.set("page_size", String(pageSize));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to list identities: ${res.status} ${await res.text()}`);
    }
    all.push(...((await res.json()) as KratosIdentity[]));

    const next = /<[^>]*[?&]page_token=([^&>]+)[^>]*>;\s*rel="next"/.exec(
      res.headers.get("link") ?? "",
    );
    const nextToken = next ? decodeURIComponent(next[1]) : "";
    if (!nextToken || nextToken === pageToken) return all;
    pageToken = nextToken;
  }
  return all;
}

/** Find a Kratos identity ID by email trait. Returns null if not found. */
export async function findIdentityByEmail(
  email: string,
): Promise<string | null> {
  let identities: KratosIdentity[];
  try {
    identities = await listIdentities();
  } catch {
    return null;
  }
  return identities.find((i) => i.traits?.email === email)?.id ?? null;
}

/**
 * Create a Kratos identity with OIDC credentials pre-linked.
 *
 * This lets the identifier-first 1FA page show the OIDC provider button
 * without needing a prior OIDC registration flow.
 */
export async function createIdentityWithOIDC(
  opts: CreateIdentityWithOIDCOpts,
): Promise<string> {
  const body = {
    schema_id: IDENTITY_SCHEMA_ID,
    credentials: {
      // Password credentials make the email a searchable credential identifier
      // so the identifier-first flow can find the identity by email.
      password: { config: { password: "oidc-identity-unused-pw" } },
      oidc: {
        config: {
          providers: [
            {
              provider: opts.provider,
              subject: opts.subject,
            },
          ],
        },
      },
    },
    traits: {
      email: opts.email,
      name: opts.name ?? "OIDC",
      surname: opts.surname ?? "User",
    },
  };

  const res = await fetch(`${KRATOS_ADMIN_URL}/admin/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `failed to create OIDC identity ${opts.email}: ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Start a Kratos self-service recovery flow by navigating to the
 * Kratos recovery browser endpoint. Kratos creates a recovery flow
 * and redirects the browser to the login-ui recovery page with a
 * `flow` query parameter.
 *
 * After this call, the browser should be on the reset-email page.
 */
export async function startRecoveryFlow(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/recovery/browser`);
  // Kratos redirects to LOGIN_UI_URL/ui/reset_email?flow=<id>
  // Wait for the redirect to complete
  await page.waitForURL(/\/ui\/reset_email/, { timeout: 10_000 });
}

/**
 * Start a Kratos self-service verification flow and advance it to the code
 * entry step for `email`.
 *
 * A freshly created verification flow opens on the "Check your email" step,
 * which asks for an address — the code input only appears once that is
 * submitted. Scenarios model `verification` as the code step, mirroring how
 * recovery splits `reset-email` from `reset-email-code`, so the bootstrap
 * completes the address step to leave the flow where scenarios expect it.
 *
 * Callers that intend to read the resulting code must snapshot the mailbox
 * (`mailCursor`) before calling this.
 */
export async function startVerificationFlow(
  page: import("@playwright/test").Page,
  email: string,
): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/verification/browser`);
  // Kratos redirects to LOGIN_UI_URL/ui/verification?flow=<id>
  await page.waitForURL(/\/ui\/verification/, { timeout: 10_000 });

  await page.getByLabel(/e-?mail/i).first().fill(email);
  await page.getByRole("button", { name: /continue|submit/i }).click();
}

/**
 * Start a Kratos self-service registration flow by navigating to the
 * Kratos registration browser endpoint. Kratos creates a registration
 * flow and redirects the browser to the login-ui registration page
 * with a `flow` query parameter.
 *
 * After this call, the browser should be on the register-email page.
 */
export async function startRegistrationFlow(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/registration/browser`);
  // Kratos redirects to LOGIN_UI_URL/ui/register?flow=<id>
  await page.waitForURL(/\/ui\/register/, { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Public-flow helpers (no admin API required — uses browser session cookies)
// ---------------------------------------------------------------------------

/**
 * Remove the TOTP authenticator from the currently logged-in user
 * via the Kratos public settings flow.
 *
 * Uses `page.request` (APIRequestContext) which shares the browser's
 * cookie jar, so the session is already authenticated.
 *
 * Flow:
 *   1. Create a settings flow via the browser endpoint (GET)
 *   2. Fetch the flow details to get the CSRF token
 *   3. Submit the settings flow with `totp_unlink: true`
 *
 * This is the equivalent of navigating to the "Manage security" page
 * and clicking "Remove authenticator", but done via XHR so it's fast
 * and doesn't require navigating away from the current page.
 */
export async function removeTotpViaPublicApi(
  page: import("@playwright/test").Page,
  totpSecret?: string | null,
): Promise<void> {
  // Step 1: Create a settings flow by hitting the browser endpoint.
  // The response can be either:
  // - a redirect (3xx with Location), or
  // - a followed final URL (when redirects are auto-followed).
  // Also, on unauthenticated state it can redirect to login. In cleanup,
  // that's a safe no-op.
  const createRes = await page.request.get(
    `${KRATOS_PUBLIC_URL}/self-service/settings/browser`,
    { maxRedirects: 0 },
  );

  const rawLocation = createRes.headers()["location"];
  const redirectUrl = rawLocation
    ? new URL(rawLocation, LOGIN_UI_URL)
    : null;
  const finalUrl = new URL(createRes.url(), LOGIN_UI_URL);
  const flowId = redirectUrl?.searchParams.get("flow")
    ?? finalUrl.searchParams.get("flow");

  if (!flowId) {
    // If no settings flow was created (for example because the user is not
    // authenticated due to an earlier scenario failure), cleanup is best-effort.
    return;
  }

  // Step 2: Fetch the flow details to get the CSRF token.
  const flowRes = await page.request.get(
    `${KRATOS_PUBLIC_URL}/self-service/settings/flows?id=${flowId}`,
  );
  if (!flowRes.ok()) {
    throw new Error(
      `removeTotpViaPublicApi: failed to fetch settings flow ${flowId}: ${flowRes.status()}`,
    );
  }
  const flowData = await flowRes.json();

  // Extract the CSRF token from the flow's UI nodes.
  const csrfNode = flowData.ui?.nodes?.find(
    (n: { attributes?: { name?: string } }) => n.attributes?.name === "csrf_token",
  );
  const csrfToken = csrfNode?.attributes?.value;
  if (!csrfToken) {
    throw new Error("removeTotpViaPublicApi: could not find CSRF token in settings flow");
  }

  // Unlink requires proving possession of the current authenticator.
  if (!totpSecret) {
    throw new Error("removeTotpViaPublicApi: missing TOTP secret for unlink cleanup");
  }
  const totpCode = await generateTotpCode(totpSecret);

  // Step 3: Submit the settings flow with totp_unlink=true.
  const submitRes = await page.request.post(
    `${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flowId}`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        csrf_token: csrfToken,
        method: "totp",
        totp_code: totpCode,
        totp_unlink: true,
      },
    },
  );
  if (!submitRes.ok()) {
    const body = await submitRes.text();
    throw new Error(
      `removeTotpViaPublicApi: failed to unlink TOTP: ${submitRes.status()} ${body}`,
    );
  }
}
