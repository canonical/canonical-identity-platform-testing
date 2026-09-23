// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// The row verdict's pure logic: per-test outcomes from the Playwright JSON
// report, and the executed-vs-expected classification.

import * as path from "node:path";
import { JUSTIFIED_SKIP } from "../tests/browser/scripts/skip-allowlist.mjs";

// Tier-A (scenario-driven) spec files. MUST match TIER_A in
// tests/browser/scripts/expected-set.ts; matrix/tests/runner.test.mjs pins them.
export const TIER_A_FILES = new Set([
  "account-linking.spec.ts",
  "device.spec.ts",
  "error.spec.ts",
  "oidc-error.spec.ts",
  "login.spec.ts",
  "oidc.spec.ts",
  "recovery.spec.ts",
  "resilience.spec.ts",
  "registration.spec.ts",
  "session.spec.ts",
  "settings.spec.ts",
  "tenant.spec.ts",
  "verification.spec.ts",
  "webauthn.spec.ts",
]);

// One JUSTIFIED_SKIP definition shared with the blocking gate; re-exported for matrix/tests/.
export { JUSTIFIED_SKIP };

// Per-test outcome, keyed by "file › title". Mirrors scripts/gate.mjs.
export function collectTests(report) {
  const results = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const testCase of spec.tests ?? []) {
        const annotations = [
          ...(testCase.annotations ?? []),
          ...(testCase.results ?? []).flatMap((r) => r.annotations ?? []),
        ];
        results.push({
          file: path.basename(spec.file),
          title: spec.title,
          status: testCase.status,
          reason: annotations
            .filter((a) => a.type === "skip")
            .map((a) => a.description ?? "")
            .join(" | "),
          failure: failureOf(testCase.results?.at(-1)),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return results;
}

/** Where and why a test's last attempt failed: the failing `test.step` path and the error's first
 *  line, ANSI-stripped. Unredacted — print it through redact(). null when the attempt did not fail. */
function failureOf(result) {
  const error = result?.error ?? result?.errors?.[0];
  if (!error) return null;
  const step = [];
  for (let steps = result.steps ?? []; ; ) {
    const failing = steps.find((s) => s.error);
    if (!failing) break;
    step.push(failing.title);
    steps = failing.steps ?? [];
  }
  const message = (error.message ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .find((line) => line.trim() !== "") ?? "";
  return { step: step.join(" › "), message: message.trim().slice(0, 400) };
}

/** The lane log is a public CI artifact and LLM input: known credentials and token-shaped strings
 *  never reach it. `secrets` are exact values (manifestSecrets(), Google env). */
export function redact(text, secrets = []) {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join("«redacted»");
  return out
    .replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "«jwt»")
    .replace(/\bory_[a-z]{2}_[\w.-]+/g, "«token»")
    .replace(/([?&#](?:code|access_token|id_token|refresh_token)=)[^&\s)"']+/g, "$1«redacted»");
}

/** Every credential-valued string in a seed manifest: passwords, TOTP secrets, backup codes,
 *  client secrets — any key naming a password, secret or backup code. */
export function manifestSecrets(manifest) {
  const out = new Set();
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (/password|secret|backupcode/i.test(key)) out.add(value);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(manifest, "");
  return [...out];
}

/** The row verdict. Playwright statuses: "expected" = passed, "unexpected" =
 *  FAILED, "flaky" = passed on retry (forbidden), "skipped". Fails on hard
 *  failures/flakes, tier-A drift in either direction, and unjustified tier-B skips. */
export function classifyOutcome(tests, expected) {
  const failures = [];

  for (const t of tests) {
    if (t.status !== "expected" && t.status !== "skipped") {
      failures.push(`${t.status}: ${t.file} › ${t.title}`);
    }
  }

  const executedA = new Set(
    tests.filter((t) => TIER_A_FILES.has(t.file) && t.status !== "skipped").map((t) => `${t.file} › ${t.title}`),
  );
  const expectedA = new Set(expected.run.map((e) => `${path.basename(e.file)} › ${e.id}`));
  for (const id of expectedA) {
    if (!executedA.has(id)) failures.push(`expected to run but did not: ${id}`);
  }
  for (const id of executedA) {
    if (!expectedA.has(id)) failures.push(`executed but not in the expected set: ${id}`);
  }

  for (const t of tests) {
    if (t.status !== "skipped" || TIER_A_FILES.has(t.file)) continue;
    if (!JUSTIFIED_SKIP.some((re) => re.test(t.reason))) {
      failures.push(`unjustified skip: ${t.file} › ${t.title} — ${t.reason || "<no reason>"}`);
    }
  }

  return failures;
}
