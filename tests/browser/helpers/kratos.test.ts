// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Unit tests for extractSecretFromOtpauthUri in kratos.ts.
 *
 * Run with: npx ts-node tests/browser/helpers/kratos.test.ts
 */

import { extractSecretFromOtpauthUri } from "./kratos";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// ── Valid otpauth URI ──────────────────────────────────────────────────────
{
  const uri =
    "otpauth://totp/Canonical:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Canonical&algorithm=SHA1&digits=6&period=30";
  const secret = extractSecretFromOtpauthUri(uri);
  assert(secret === "JBSWY3DPEHPK3PXP", `expected JBSWY3DPEHPK3PXP, got ${secret}`);
}

// ── URI with different secret ──────────────────────────────────────────────
{
  const uri =
    "otpauth://totp/Test:bob@test.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=Test";
  const secret = extractSecretFromOtpauthUri(uri);
  assert(
    secret === "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ",
    `expected HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ, got ${secret}`,
  );
}

// ── Missing secret parameter ──────────────────────────────────────────────
{
  let threw = false;
  try {
    extractSecretFromOtpauthUri("otpauth://totp/Test:user@test.com?issuer=Test");
  } catch {
    threw = true;
  }
  assert(threw, "expected error for missing secret parameter");
}

// ── Not an otpauth URI ────────────────────────────────────────────────────
{
  let threw = false;
  try {
    extractSecretFromOtpauthUri("https://example.com");
  } catch {
    threw = true;
  }
  assert(threw, "expected error for non-otpauth URI");
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\nextractSecretFromOtpauthUri: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
