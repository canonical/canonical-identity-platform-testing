// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * The justified-skip allow-list — ONE definition, two consumers.
 *
 * A profile deliberately deploys a subset of the platform, so a scenario that
 * needs hook-service cannot run on `core`, and one that needs a credential
 * nobody supplied cannot run anywhere. Those are the `requires:` system
 * working. What must never happen is a test skipping for a reason that is
 * really a quarantine — a disabled assertion, an unimplemented flow, a guard
 * that always fires. So a skip is allowed only when its reason matches a
 * declared capability gate; everything else fails the gate and the row.
 *
 * `scripts/gate.mjs` (blocking per-profile gate) and `matrix/run-row.mjs`
 * (matrix lane, tier-B judgement) both consume this. Never hand-copy it into
 * a consumer: copies drift, and `gate.mjs` executes on import, so a drifted
 * copy there would be invisible to tests. `matrix/tests/skip-allowlist.test.mjs`
 * asserts both consumers resolve to this very array.
 */

export const JUSTIFIED_SKIP = [
  // Service/provider presence, from the declared capabilities.
  /not in (the )?active profile/i,
  /not in profile/i,
  /requires? .* but profile .* (does not|enforces)/i,
  /login-ui reports multi_tenancy_enabled=false/i,
  /provider .* not in active profile/i,
  /requires .* but the active deployment/i,
  // Credentials the environment does not supply (registered in
  // known-coverage-gaps.json, so the union check still accounts for them).
  /credentials not available/i,
  // Lane gating (framework/scenario-runner.ts + assertInternalLane()).
  /Internal-only spec in live lane/i,
  /not compatible with lane/i,
  // Reason shapes produced by satisfies() — the suite's only capability
  // predicate. The runner prefixes every one with "Skipped: ".
  /^Skipped: requires /i,
  /^Skipped: .*ActiveConfig/i,
  // Collection-time suite pick (oidc.spec.ts chooses the sequencing variant).
  /OIDC sequencing is (enabled|not enabled)/i,
];
