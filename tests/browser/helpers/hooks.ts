// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Manage hook-service groups via its `/api/v0/authz` gRPC-gateway API.
 *
 * hook-service is what makes the `groups` profile observably different from
 * `core`: Hydra calls its token hook on every token issuance, and hook-service
 * enriches the token with a `groups` claim built from its own store. Hydra
 * surfaces access-token session extras under the `ext` claim.
 *
 * Group membership is keyed on the user's *email* (see
 * `StorageHookGroupsClient.FetchUserGroups` — it uses `user.Email`, or
 * `user.ClientId` for service accounts), so members are recorded by email,
 * not by Kratos identity ID.
 *
 * The `/api/v0/authz` router is behind JWT auth: hook-service verifies the
 * issuer (`http://localhost:4444`) against Hydra's JWKS and requires the
 * `hook-service:admin` scope. Tokens therefore come from Hydra's *public*
 * port (4444), not the admin port.
 */

import { HOOK_SERVICE_URL, HYDRA_PUBLIC_URL } from "./config";
import type { Manifest } from "../seeder/manifest-schema";

/** Scope hook-service requires on the JWT for `/api/v0/authz` (AUTHENTICATION_REQUIRED_SCOPE). */
export const HOOK_ADMIN_SCOPE = "hook-service:admin";

/** A group as returned by hook-service. */
export interface HookGroup {
  id: string;
  name: string;
  tenant_id?: string;
  description?: string;
  type?: string;
}

/**
 * Obtain a client-credentials JWT carrying the `hook-service:admin` scope.
 *
 * Mirrors `getServiceToken` in helpers/tenants.ts — same exchange, different
 * scope. Hydra is configured with `strategies.scope: exact`, so the requested
 * scope must match the client's registered scope verbatim.
 */
export async function getHookAdminToken(
  clientId?: string,
  clientSecret?: string,
  manifest?: Manifest,
): Promise<string> {
  let cid = clientId;
  let csecret = clientSecret;

  if (!cid || !csecret) {
    const manifestClient = manifest?.oauthClients?.hooks;
    if (!cid && manifestClient?.clientId) cid = manifestClient.clientId;
    if (!csecret && manifestClient?.clientSecret) csecret = manifestClient.clientSecret;
  }

  if (!cid || !csecret) {
    throw new Error(
      "No hook-service admin credentials available. Provide a manifest with oauthClients.hooks, or pass them explicitly.",
    );
  }

  const res = await fetch(`${HYDRA_PUBLIC_URL}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${cid}:${csecret}`).toString("base64"),
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(HOOK_ADMIN_SCOPE)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed to get hook-service admin token: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Envelope every `/api/v0/authz` response uses. */
interface AuthzEnvelope<T> {
  data?: T;
  status: number;
  message?: string;
}

async function authzRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ httpStatus: number; body: AuthzEnvelope<T> }> {
  const res = await fetch(`${HOOK_SERVICE_URL}/api/v0/authz${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let parsed: AuthzEnvelope<T>;
  try {
    parsed = JSON.parse(text) as AuthzEnvelope<T>;
  } catch {
    throw new Error(`hook-service ${method} ${path}: ${res.status} (unparseable body: ${text})`);
  }

  return { httpStatus: res.status, body: parsed };
}

async function authzOk<T>(token: string, method: string, path: string, body?: unknown): Promise<T | undefined> {
  const { httpStatus, body: envelope } = await authzRequest<T>(token, method, path, body);
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`hook-service ${method} ${path}: ${httpStatus} ${envelope.message ?? ""}`.trim());
  }
  return envelope.data;
}

/** List all groups. */
export async function listGroups(token: string): Promise<HookGroup[]> {
  // proto3 omits empty repeated fields, so `data` is absent when there are none.
  return (await authzOk<HookGroup[]>(token, "GET", "/groups")) ?? [];
}

/**
 * Create the named group, or return the existing one.
 *
 * Idempotent two ways: it looks the group up first, and it still tolerates the
 * 409 hook-service returns on a duplicate name (the unique index is on
 * `(tenant_id, name)`), which closes the race between concurrent seeders.
 */
export async function ensureGroup(token: string, name: string, description: string): Promise<HookGroup> {
  const existing = (await listGroups(token)).find((g) => g.name === name);
  if (existing) return existing;

  const { httpStatus, body } = await authzRequest<HookGroup[]>(token, "POST", "/groups", {
    name,
    description,
    type: "local",
  });

  if (httpStatus === 409) {
    const raced = (await listGroups(token)).find((g) => g.name === name);
    if (raced) return raced;
    throw new Error(`hook-service reported group ${name} already exists but it is not listed`);
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`failed to create group ${name}: ${httpStatus} ${body.message ?? ""}`.trim());
  }

  const created = body.data?.[0];
  if (!created) {
    throw new Error(`hook-service returned no group data when creating ${name}`);
  }
  return created;
}

/** List the member IDs (emails) of a group. */
export async function listUsersInGroup(token: string, groupId: string): Promise<string[]> {
  const users = (await authzOk<Array<{ id: string }>>(token, "GET", `/groups/${groupId}/users`)) ?? [];
  return users.map((u) => u.id);
}

/**
 * Add the given user IDs (emails) to a group, skipping members already present.
 *
 * The insert underneath has no upsert, so re-adding an existing member can come
 * back as 409 "user already in group". Filtering first keeps a re-seed clean.
 * Returns the IDs actually added.
 */
export async function addUsersToGroup(token: string, groupId: string, userIds: string[]): Promise<string[]> {
  const current = new Set(await listUsersInGroup(token, groupId));
  const missing = userIds.filter((id) => !current.has(id));
  if (missing.length === 0) return [];

  await authzOk(token, "POST", `/groups/${groupId}/users`, missing);
  return missing;
}

/** List the groups a user (by email) belongs to. */
export async function listUserGroups(token: string, userId: string): Promise<HookGroup[]> {
  return (await authzOk<HookGroup[]>(token, "GET", `/users/${encodeURIComponent(userId)}/groups`)) ?? [];
}
