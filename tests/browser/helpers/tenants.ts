// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { TENANT_SERVICE_URL, HYDRA_PUBLIC_URL, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, requireEnv } from "./config";
import type { Manifest, ManifestOauthClientSvc } from "../seeder/manifest-schema";
import { getSvcClient as getManifestSvcClient } from "../framework/manifest";

export function getSvcClient(manifest: Manifest): ManifestOauthClientSvc | undefined {
  return getManifestSvcClient(manifest);
}

/** Client-credentials JWT for tenant-service; explicit args, then manifest, then env vars. */
export async function getServiceToken(
  clientId?: string,
  clientSecret?: string,
  manifest?: Manifest,
): Promise<string> {
  let cid = clientId;
  let csecret = clientSecret;

  if (!cid || !csecret) {
    const manifestClient = manifest ? getSvcClient(manifest) : undefined;
    if (!cid && manifestClient?.clientId) cid = manifestClient.clientId;
    if (!csecret && manifestClient?.clientSecret) csecret = manifestClient.clientSecret;
  }

  if (!cid) cid = AUTH_CLIENT_ID || (manifest ? undefined : requireEnv("AUTH_CLIENT_ID"));
  if (!csecret) csecret = AUTH_CLIENT_SECRET || (manifest ? undefined : requireEnv("AUTH_CLIENT_SECRET"));

  if (!cid || !csecret) {
    throw new Error(
      "No client credentials available. Set AUTH_CLIENT_ID/AUTH_CLIENT_SECRET env vars or provide a manifest with oauthClients.svc."
    );
  }

  if (manifest) {
    const manifestClient = getSvcClient(manifest);
    if (manifestClient && AUTH_CLIENT_ID && AUTH_CLIENT_SECRET) {
      if (AUTH_CLIENT_ID !== manifestClient.clientId || AUTH_CLIENT_SECRET !== manifestClient.clientSecret) {
        process.stderr.write(
          `⚠ AUTH_CLIENT_ID/AUTH_CLIENT_SECRET disagree with manifest — using env vars\n`
        );
      }
    }
  }

  const res = await fetch(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${cid}:${csecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials&scope=tenant-service",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed to get service token: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface Tenant {
  id: string;
  name: string;
}

export async function createTenant(
  token: string,
  name: string,
): Promise<Tenant> {
  const res = await fetch(`${TENANT_SERVICE_URL}/api/v0/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed to create tenant ${name}: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { tenant: Tenant };
  return data.tenant;
}

/** Idempotent. */
export async function deleteTenant(
  token: string,
  tenantId: string,
): Promise<void> {
  const res = await fetch(`${TENANT_SERVICE_URL}/api/v0/tenants/${tenantId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`failed to delete tenant ${tenantId}: ${res.status}`);
  }
}

// `GET /api/v0/tenants?page_size&page_token` → `{tenants, next_page_token}`
// (tenant-service v0.2.0 openapi/openapi.swagger.json). Backs the seeder's fresh-mode cleanup.
export async function listTenants(
  token: string,
  pageSize = 100,
): Promise<Tenant[]> {
  const all: Tenant[] = [];
  let pageToken = "";
  // Bounded: a server echoing the same page token must not spin forever.
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${TENANT_SERVICE_URL}/api/v0/tenants`);
    url.searchParams.set("page_size", String(pageSize));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`failed to list tenants: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { tenants?: Tenant[]; next_page_token?: string };
    all.push(...(data.tenants ?? []));
    if (!data.next_page_token || data.next_page_token === pageToken) return all;
    pageToken = data.next_page_token;
  }
  return all;
}

export async function provisionUser(
  token: string,
  tenantId: string,
  email: string,
  role: string = "member",
): Promise<void> {
  const res = await fetch(
    `${TENANT_SERVICE_URL}/api/v0/tenants/${tenantId}/users`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email, role }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `failed to provision ${email} to ${tenantId}: ${res.status} ${text}`,
    );
  }
}
