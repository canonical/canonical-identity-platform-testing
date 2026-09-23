#!/usr/bin/env node
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// One throwaway kratos identity in the reserved @test.example namespace, same
// payload shape as the seeder (tests/browser/helpers/kratos.ts createIdentity).
// The AAL probe uses it for a session; scripts/seed-remote.sh runs the CLI to
// prove the identity WRITE path before --fresh deletes the previous seed.
//
//   node matrix/verify/probe-identity.mjs <kratos-admin-url> <schema-id>
//
// stdout: "ok" | "LEFTOVER <id> (DELETE returned <status>)"; exit 3 with
// "HTTP <status> <body>" or the transport error when the create is refused.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchJson } from "./record.mjs";

/** Register a password identity. Random hex password sharing no prefix with
 *  the identifier (kratos rejects short or identifier-similar passwords). */
export async function createProbeIdentity(kratosAdmin, schemaId, prefix) {
  const email = `${prefix}-${randomUUID()}@test.example`;
  const password = `${randomUUID().replaceAll("-", "")}Aa1!`;
  const res = await fetchJson(`${kratosAdmin}/admin/identities`, {
    method: "POST",
    timeout: 20000,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_id: schemaId,
      credentials: { password: { config: { password } } },
      traits: { email, name: "Matrix", surname: "Probe" },
    }),
  });
  return { status: res.status, error: res.error, body: res.body, text: res.text, id: res.status === 201 ? res.body?.id ?? null : null, email, password };
}

/** 204 and 404 both mean the identity is gone. */
export async function deleteProbeIdentity(kratosAdmin, id) {
  const res = await fetchJson(`${kratosAdmin}/admin/identities/${id}`, { method: "DELETE", timeout: 20000 });
  return { status: res.status, error: res.error, gone: res.status === 204 || res.status === 404 };
}

// argv[1] is only resolved, so a symlinked checkout must be realpath'd.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kratosAdmin, schemaId] = process.argv.slice(2);
  if (!kratosAdmin || !schemaId) {
    console.error("usage: node matrix/verify/probe-identity.mjs <kratos-admin-url> <schema-id>");
    process.exit(2);
  }
  const created = await createProbeIdentity(kratosAdmin, schemaId, "preflight");
  if (!created.id) {
    // The raw body is part of the answer: a column error names a version skew the caller matches on.
    console.log(created.status === 0 ? created.error : `HTTP ${created.status} ${(created.text ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
    process.exit(3);
  }
  const deleted = await deleteProbeIdentity(kratosAdmin, created.id);
  console.log(deleted.gone ? "ok" : `LEFTOVER ${created.id} (DELETE returned ${deleted.status})`);
}
