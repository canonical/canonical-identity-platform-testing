// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Expected-set canaries for the SEED rows.
//
// `scripts/expected-set.ts` and the scenario runner share one `satisfies()` on
// purpose — they cannot drift from each other. The cost of that design is that
// a predicate bug moves gating AND expectation together, and the row still
// prints "executed (matching the declaration exactly)". These canaries are the
// external witness: they pin the EXACT expected-run ID list for two declared
// rows, so a change in gating semantics has to be acknowledged here.
//
// Updating an expected list is a CONSCIOUS act — that is the point. Whenever
// scenarios or `requires:` keys change, re-derive with
//   cd tests/browser && npx tsx scripts/expected-set.ts \
//     ../../matrix/rows/<row>/capabilities.json
// and copy the new list in, having satisfied yourself the delta is intended.
//
// Offline: expected-set.ts reads a checked-in capabilities file and the
// scenario data. No stack, no browser, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BROWSER_DIR = path.join(REPO, "tests", "browser");

function expectedSet(row) {
  const caps = path.join(REPO, "matrix", "rows", row, "capabilities.json");
  const res = spawnSync("npx", ["tsx", "scripts/expected-set.ts", caps], {
    cwd: BROWSER_DIR,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `expected-set.ts failed for ${row}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// The MT sentinel: single oidc provider + multi-tenancy + webauthn sequencing.
// Sequencing swaps oidc.spec.ts's suite for the sequencing variant, which is
// why the two forced-reauth ids differ between these two rows, and why the
// assertion-ceremony scenario appears here and nowhere else.
//
// oidc-webauthn-assertion is the suite's only WebAuthn ASSERTION (R-5 — as
// opposed to enrolment); it exists only in the sequencing suite. The 4
// oidc-error scenarios require only hydra + login-ui (empty `requires:`), so
// they run on EVERY row; the resilience suite (localUsersEnabled+mfaEnabled)
// skips on both seed rows, which keeps the two canaries discriminating about
// local-user gating.
const PD931_RUN = [
  "specs/oidc-error.spec.ts :: unknown-client-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-redirect-uri-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-scope-redirects-error-to-rp",
  "specs/oidc-error.spec.ts :: prompt-none-without-session",
  "specs/oidc.spec.ts :: oidc-dex-login",
  "specs/oidc.spec.ts :: oidc-session-reuse",
  "specs/oidc.spec.ts :: oidc-forced-reauth-demands-security-key",
  "specs/oidc.spec.ts :: oidc-webauthn-assertion",
  "specs/oidc.spec.ts :: oidc-login-mfa-enforcement",
];

// The terraform-default shape: oidc only, no local users, no MT, no sequencing.
const TFDEFAULT_RUN = [
  "specs/oidc-error.spec.ts :: unknown-client-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-redirect-uri-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-scope-redirects-error-to-rp",
  "specs/oidc-error.spec.ts :: prompt-none-without-session",
  "specs/oidc.spec.ts :: oidc-dex-login",
  "specs/oidc.spec.ts :: oidc-session-reuse",
  "specs/oidc.spec.ts :: oidc-forced-reauth",
];

// The deployed-core shape: local users with MFA enforced, no external IdP, no
// add-ons, no mail API. The only canary with local-user journeys and the whole
// resilience suite, and the only one whose oidc.spec.ts contribution is empty —
// which is what makes it discriminating about oidc gating in the other
// direction. mail_api=false is what keeps recovery/verification/registration
// out of the list even though local users exist.
const DEPLOYED_CORE_RUN = [
  "specs/error.spec.ts :: wrong-password-error",
  "specs/error.spec.ts :: invalid-totp-code",
  "specs/oidc-error.spec.ts :: unknown-client-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-redirect-uri-renders-error-page",
  "specs/oidc-error.spec.ts :: invalid-scope-redirects-error-to-rp",
  "specs/oidc-error.spec.ts :: prompt-none-without-session",
  "specs/login.spec.ts :: first-login-mfa",
  "specs/login.spec.ts :: returning-login-mfa",
  "specs/login.spec.ts :: expired-totp-code",
  "specs/resilience.spec.ts :: refresh-survives-login-walk",
  "specs/resilience.spec.ts :: double-click-submit",
  "specs/resilience.spec.ts :: callback-replay-rejected",
  "specs/resilience.spec.ts :: back-after-auth-terminal",
  "specs/session.spec.ts :: session-reuse-no-max-age",
  "specs/session.spec.ts :: forced-reauth-max-age-0",
];

for (const [row, expectedRun] of [
  ["pd931-single-oidc-mt", PD931_RUN],
  ["tfdefault-oidc-only", TFDEFAULT_RUN],
  ["deployed-core-local-mfa", DEPLOYED_CORE_RUN],
]) {
  test(`expected-set for ${row} is exactly the pinned list`, () => {
    const out = expectedSet(row);
    assert.equal(out.lane, "internal");
    assert.deepEqual(
      out.run.map((e) => `${e.file} :: ${e.id}`),
      expectedRun,
      `expected-run set moved for ${row} — re-derive it and update this list deliberately`,
    );
    // Run and skip must partition the collected tier-A set: a scenario that
    // appears in neither (or in both) means the expected-set script lost track.
    const ids = new Set([...out.run, ...out.skip].map((e) => `${e.file} :: ${e.id}`));
    assert.equal(ids.size, out.run.length + out.skip.length, "a scenario appears in both run and skip");
    // Every declared skip must carry a reason the allow-lists accept.
    for (const s of out.skip) {
      assert.match(`Skipped: ${s.reason}`, /^Skipped: requires /i, `skip reason shape for ${s.id}`);
    }
  });
}

test("the seed rows differ — the canaries are discriminating", () => {
  assert.notDeepEqual(PD931_RUN, TFDEFAULT_RUN);
  assert.notDeepEqual(PD931_RUN, DEPLOYED_CORE_RUN);
  assert.notDeepEqual(TFDEFAULT_RUN, DEPLOYED_CORE_RUN);
});
