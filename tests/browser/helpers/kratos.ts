// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Kratos admin/public API helpers (fetch-based). */

import type { Page } from "@playwright/test";
import { KRATOS_ADMIN_URL, KRATOS_PUBLIC_URL, LOGIN_UI_URL, envOr } from "./config";

const IDENTITY_SCHEMA_ID = envOr("KRATOS_IDENTITY_SCHEMA_ID", "default");
import { generateTotpCode } from "./totp";
import { generateTestPassword } from "./test-credentials";

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

/** Patch verifiable_addresses/0 to verified=true, status="completed". */
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

/** Reset an identity's password with a full PUT. A JSON-Patch on
 *  /credentials/password/config/password returns 200 but never reaches the hasher, so the
 *  old password stays; PUT re-runs the credential pipeline and keeps totp/webauthn. */
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

/** First unused lookup secret from the live credential; the manifest's seed-time code is one-shot. */
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

/** Burn backup codes via native AAL2 login flows; login-ui offers regeneration at <=3 unused. */
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

/** Idempotent (204 even when absent); `webauthn` keeps the credential record and user handle.
 *  `oidc` rejects a bare DELETE (400 "You must provide an identifier"), so each linked
 *  identifier is deleted individually. Needs no browser session, so it runs after failures. */
export async function deleteIdentityCredentialType(
  id: string,
  type: "totp" | "webauthn" | "lookup_secret" | "oidc",
): Promise<void> {
  if (type === "oidc") {
    const read = await fetch(`${KRATOS_ADMIN_URL}/admin/identities/${id}?include_credential=oidc`);
    if (!read.ok) {
      throw new Error(`failed to read oidc identifiers for ${id}: ${read.status} ${await read.text()}`);
    }
    const identity = (await read.json()) as {
      credentials?: { oidc?: { identifiers?: string[] } };
    };
    for (const identifier of identity.credentials?.oidc?.identifiers ?? []) {
      const res = await fetch(
        `${KRATOS_ADMIN_URL}/admin/identities/${id}/credentials/oidc?identifier=${encodeURIComponent(identifier)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `failed to delete oidc credential "${identifier}" for ${id}: ${res.status} ${await res.text()}`,
        );
      }
    }
    return;
  }
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

// --- Session token helpers (programmatic settings flow) ---

/** Native login (GET /self-service/login/api, POST /self-service/login) -> session token. */
export async function createSessionToken(
  email: string,
  password: string,
): Promise<string> {
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

  // TOTP-enrolled users get `continue_with: [{action: "ask_aal2"}]` instead of a session_token.
  if (!loginData.session_token) {
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

/** GET /self-service/settings/api; the base32 secret is the totp_secret_key node's text.context.secret. */
export async function initTotpSettingsFlow(
  sessionToken: string,
): Promise<{ flowId: string; totpSecret: string }> {
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

/** Must run in the SAME settings flow as TOTP confirmation: once TOTP is configured, a new
 *  settings flow requires AAL2. */
export async function generateBackupCodes(
  flowId: string,
  sessionToken: string,
): Promise<string[]> {
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

/** Follows `Link: <...page_token=...>; rel="next"` keyset pagination; the last page omits the link. */
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

/** Identity with an oidc credential pre-linked, so identifier-first shows the provider button. */
export async function createIdentityWithOIDC(
  opts: CreateIdentityWithOIDCOpts,
): Promise<string> {
  const body = {
    schema_id: IDENTITY_SCHEMA_ID,
    credentials: {
      // Password credential makes the email a searchable identifier for identifier-first. Random
      // and unrecorded: nothing signs in with it, and a known value would open the identity.
      password: { config: { password: generateTestPassword() } },
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

/** Navigate to Kratos' recovery browser endpoint; lands on /ui/reset_email?flow=. */
export async function startRecoveryFlow(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/recovery/browser`);
  await page.waitForURL(/\/ui\/reset_email/, { timeout: 10_000 });
}

/** Start a verification flow and submit `email` to reach the code step, which is what
 *  scenarios model as `verification`. Snapshot the mailbox (`mailCursor`) before calling. */
export async function startVerificationFlow(
  page: import("@playwright/test").Page,
  email: string,
): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/verification/browser`);
  await page.waitForURL(/\/ui\/verification/, { timeout: 10_000 });

  await page.getByLabel(/e-?mail/i).first().fill(email);
  await page.getByRole("button", { name: /continue|submit/i }).click();
}

/** Navigate to Kratos' registration browser endpoint; lands on /ui/register?flow=. */
export async function startRegistrationFlow(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${KRATOS_PUBLIC_URL}/self-service/registration/browser`);
  await page.waitForURL(/\/ui\/register/, { timeout: 10_000 });
}

// --- Public-flow helpers (browser session cookies, no admin API) ---

/** Unlink TOTP through the public settings flow via page.request (shares the
 *  browser cookie jar). Returns false when the page holds no session — the
 *  caller must then unlink another way; a silent no-op leaves the seed dirty. */
export async function removeTotpViaPublicApi(
  page: Page,
  totpSecret?: string | null,
): Promise<boolean> {
  const createRes = await page.request.get(
    `${KRATOS_PUBLIC_URL}/self-service/settings/browser`,
    { maxRedirects: 0 },
  );

  const rawLocation = createRes.headers()["location"];
  const redirectUrl = rawLocation
    ? new URL(rawLocation, LOGIN_UI_URL)
    : null;
  const finalUrl = new URL(createRes.url(), LOGIN_UI_URL);
  let flowId = redirectUrl?.searchParams.get("flow")
    ?? finalUrl.searchParams.get("flow");

  // Kratos answers with a 303 whose Location carries ?flow=; the login-ui BFF (the only
  // kratos surface a charmed ingress exposes) answers 200 with the flow as a JSON body.
  if (!flowId && createRes.ok()) {
    try {
      const body: unknown = await createRes.json();
      if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
        flowId = body.id;
      }
    } catch {
      /* not JSON — fall through to the no-op */
    }
  }

  if (!flowId) {
    return false;
  }

  const flowRes = await page.request.get(
    `${KRATOS_PUBLIC_URL}/self-service/settings/flows?id=${flowId}`,
  );
  if (!flowRes.ok()) {
    throw new Error(
      `removeTotpViaPublicApi: failed to fetch settings flow ${flowId}: ${flowRes.status()}`,
    );
  }
  const flowData = await flowRes.json();

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
  return true;
}
