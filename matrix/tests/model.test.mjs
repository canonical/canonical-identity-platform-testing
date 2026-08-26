// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Invariants over the model's pure derivations (matrix/lib.mjs) — checked
// against every row in the checked-in matrix.json, so a lib change that
// breaks a contract fails here in milliseconds instead of mid-loop on a
// live cluster.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { capabilities, rowName } from "../lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(fs.readFileSync(path.join(HERE, "..", "matrix.json"), "utf-8"));
const namedRows = matrix.rows.filter((r) => r.kind !== "pinned");

test("matrix.json has rows to test against", () => {
  assert.ok(namedRows.length >= 5);
});

test("rowName encoding round-trips every non-pinned row", () => {
  for (const row of namedRows.filter((r) => r.kind === "generated")) {
    assert.equal(rowName(row.dims), row.name, `dims of ${row.name} must re-encode to its name`);
  }
});

// `mail_api` is a DECLARED capability on every row, and dims alone never turn
// it off: only a row's `caps` block can, because a target without mailslurper
// is a property of that target, not of the platform's configuration space.
test("mail is a declared capability on every row, and only a caps block moves it", () => {
  for (const row of namedRows) {
    assert.equal(capabilities(row.dims).mail_api, true, `${row.name} dims-derived`);
    assert.equal(
      capabilities(row.dims, row.caps).mail_api,
      row.caps?.mail_api ?? true,
      `${row.name} materialized`,
    );
  }
});

test("a caps override must name a real key and must actually change it", () => {
  const dims = namedRows[0].dims;
  assert.throws(
    () => capabilities(dims, { mail_apo: false }),
    /names no derived capability key/,
    "a typo'd key must not silently shape the executed set",
  );
  assert.throws(
    () => capabilities(dims, { mail_api: true }),
    /repeats the derived value/,
    "a no-op override is dead weight and hides intent",
  );
  assert.equal(capabilities(dims, { mail_api: false }).mail_api, false);
  // Deep values compare structurally, so re-stating an array is a no-op too.
  assert.throws(
    () => capabilities(dims, { oidc_providers: capabilities(dims).oidc_providers }),
    /repeats the derived value/,
  );
});

test("every row's caps block survives materialization", () => {
  for (const row of namedRows.filter((r) => r.caps)) {
    const caps = capabilities(row.dims, row.caps);
    for (const [key, want] of Object.entries(row.caps)) {
      assert.deepEqual(caps[key], want, `${row.name} override ${key}`);
    }
  }
});

test("backend-divergent providers: juju override exists iff providers=2 and mirrors the base key", () => {
  for (const row of namedRows) {
    const caps = capabilities(row.dims);
    if (row.dims.providers === "2") {
      assert.deepEqual(caps.oidc_providers, ["dex", "google"], `${row.name} base providers`);
      assert.deepEqual(caps.juju, { oidc_providers: ["dex", "dex2"] }, `${row.name} juju override`);
      // The override must ONLY shadow keys that exist on the base object —
      // consumers flatten with a spread, so a stray key would leak.
      for (const key of Object.keys(caps.juju)) {
        assert.ok(key in caps, `${row.name} juju override key '${key}' must mirror a base key`);
      }
    } else {
      assert.equal(caps.juju, undefined, `${row.name} must not carry a juju override`);
    }
  }
});

test("webauthn-passwordless is retired from the generated space (upstream unmaintained)", () => {
  for (const row of namedRows) {
    assert.notEqual(row.dims.webauthn, "passwordless", row.name);
  }
});

test("capability booleans track their dims", () => {
  for (const row of namedRows) {
    const caps = capabilities(row.dims);
    assert.equal(caps.local_users_enabled, row.dims.local_idp === "on", `${row.name} local_users`);
    assert.equal(caps.mfa_enforced, row.dims.mfa === "enforced", `${row.name} mfa`);
    assert.equal(
      caps.oidc_webauthn_sequencing_enabled ?? false,
      row.dims.webauthn === "sequencing",
      `${row.name} sequencing`,
    );
    assert.equal(caps.access_token_format, row.dims.access_token, `${row.name} token shape`);
  }
});
