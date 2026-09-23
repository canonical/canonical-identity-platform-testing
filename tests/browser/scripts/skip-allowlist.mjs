// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// A skip is justified only when its reason matches a declared capability gate; anything else
// is a quarantine and fails the gate and the row. Consumed by scripts/gate.mjs and matrix/run-row.mjs;
// never hand-copy it (matrix/tests/skip-allowlist.test.mjs asserts both resolve to this array).

export const JUSTIFIED_SKIP = [
  // Service/provider presence, from the declared capabilities.
  /not in (the )?active profile/i,
  /not in profile/i,
  /requires? .* but profile .* (does not|enforces)/i,
  /login-ui reports multi_tenancy_enabled=false/i,
  /provider .* not in active profile/i,
  /requires .* but the active deployment/i,
  // Credentials the environment does not supply (registered in known-coverage-gaps.json).
  /credentials not available/i,
  // Lane gating (framework/scenario-runner.ts + assertInternalLane()).
  /Internal-only spec in live lane/i,
  /not compatible with lane/i,
  // Reason shapes produced by satisfies(); the runner prefixes every one with "Skipped: ".
  /^Skipped: requires /i,
  /^Skipped: .*ActiveConfig/i,
  // Collection-time suite pick (oidc.spec.ts chooses the sequencing variant).
  /OIDC sequencing is (enabled|not enabled)/i,
];
