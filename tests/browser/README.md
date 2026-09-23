# Browser Test Suite

This directory contains the Playwright-driven browser test suite for the Canonical Identity Platform. Tests execute declarative user journeys against a running compose stack by walking a state graph across identity flows, verifying transitions, and asserting issued tokens, session states, and security controls. Rationale and design details are documented in `../../docs/testing-spec.md` §8.

## Quick Start

Commands executed from the repository root:

```bash
# Set and start the compose deployment profile
make profile-set PROFILE=core # options: core, canonical-internal, canonical-portal
make up

# Re-seed test data before every test run
make seed-test-data-clean

# Execute the browser suite in the internal lane
make test-browser

# Validate imports and list scenarios without starting a browser
make test-browser-list

# Run tests with a visible browser
make test-browser-headed

# Typecheck and run unit tests
make test-browser-typecheck
make test-browser-unit

# Hermetic checks, no stack needed (typecheck, matrix artifacts, unit tests, port audit)
make check

# Execute the two-run gate enforcing zero flakes and allowed skips
make test-browser-gate

# Run the complete blocking gate
make gate PROFILE=core
```

Execute a single scenario from `tests/browser/`:

```bash
npx playwright test specs/login.spec.ts -g "<scenario-id>"
```

Configuration in `playwright.config.ts` enforces `workers: 1`, `fullyParallel: false`, and `retries: 0`. Never change these values. The stack must be running before test collection.

## Layout

| Path | Purpose |
| --- | --- |
| `scenarios/*-scenarios.ts` | Declarative `Scenario` objects grouped via `defineScenarioSuite()`. 15 files, ~64 scenarios (e.g. `login-scenarios.ts`, `session-scenarios.ts`, `device-scenarios.ts`, `oidc-scenarios.ts`, `tenant-scenarios.ts`, `settings-scenarios.ts`, `webauthn-scenarios.ts`). |
| `specs/*.spec.ts` | One test file per suite executing a 4-line loop: `for (const scenario of suite.scenarios) test(scenario.id, async ({ page }) => runScenario(page, scenario))`. Includes three hand-written specs: `navigation.spec.ts`, `recovery-code-abuse.spec.ts`, `google-oidc.spec.ts`. |
| `framework/scenario-types.ts` | Type definitions for `Scenario`, `Phase`, `ScenarioRequires`, `ScenarioUser`, `ScenarioAssertions`, and `ClaimAssertion`. Provides import-time validation via `defineScenario()`. |
| `framework/scenario-runner.ts` | `runScenario(page, scenario)`: lane-gates, applies `satisfies()`, resolves manifest users, walks `expectedPath`, captures RP tokens, executes assertions, runs post checks, and runs cleanup (even if the walk fails). |
| `framework/transitions.ts` | `TRANSITION_TABLE`: maps `"<from> → <to>"` state pairs to `{ description, action }`. Examples: `"start → login-email"`, `"login-email → login-password"`, `"login-email → provider:dex:login"`. |
| `helpers/page-state.ts` | `PageStateType` union of ~36 states (e.g. `login-email`, `login-password`, `login-totp-verify`, `oidc-callback`, `tenant-selection`, `setup-passkey`, `device-code`, `device-complete`) and DOM-driven state detectors. |
| `framework/claim-assertions.ts` | Token assertion factories returning `ClaimAssertion` objects (`reauthenticated`, `amrRecords`, `subjectIsSeededIdentity`). |
| `framework/intervention-checks.ts` | API-side verification routines for `postChecks`. |
| `framework/interventions.ts` | Perturbation primitives (`reload`, `replay-current-url`, `history-back`, `history-roundtrip`, `resend-code`, `double-submit`). |
| `framework/requires.ts` | Evaluates deployment compatibility via `satisfies(requires, activeConfig)`. Maps camelCase `ScenarioRequires` keys to snake_case `ActiveConfig` keys. |
| `framework/active-config.ts` | `ActiveConfig` type definition representing deployment configuration. |
| `framework/global-setup.ts` | Ingests the row's `capabilities.json` (from `BROWSER_TEST_CAPABILITIES`) into `active-config.json`. |
| `seeder/archetypes.ts` | The only source of seeded user definitions and credentials. |
| `seeder/ownership.ts` | Scopes seeder deletions to `@test.example`, `iam-test ` tenants, and manifest IDs. Foreign identities are left untouched. |
| `scripts/expected-set.ts` | CLI reporting run/skip status against capabilities: `npx tsx scripts/expected-set.ts ../../matrix/rows/<row>/capabilities.json`. |
| `scripts/gate.mjs` | Gate script running the suite twice; fails on test failures, flakes, or skips not in `scripts/skip-allowlist.mjs`. Writes to `test-results/run-1/` and `test-results/run-2/`. |
| `expected-tests.json` | Canary file of expected collected tests. |
| `known-coverage-gaps.json` | Documents tests unexecutable on any gate profile with associated reasons. |
| `LANES.md` | Operator guide for `BROWSER_TEST_LANE=internal|live` and third-party IdP credentials. |

## Anatomy of a Scenario

Scenarios declare an expected user journey through identity flow states.

| Field | Description |
| --- | --- |
| `id` | Kebab-case unique scenario identifier. |
| `description` | Plain-text explanation of scenario behavior. |
| `requires` | `ScenarioRequires` flags declaring only features exercised by the walk. |
| `user` | Identity reference (`ref`, `credentials`, `totpConfigured`, optional `selectTenant`). `ref` must match an archetype in `seeder/archetypes.ts`. |
| `expectedPath` | Ordered array of `PageStateType` entries for single-phase walks. |
| `phases` | Ordered array of phase definitions for multi-phase walks (`name`, `expectedPath`, optional `flowParams`, `expectError`, `freshSession`, `interventions`, `finalUrlContains`). Context is preserved; `freshSession: true` clears cookies while retaining virtual WebAuthn authenticators. |
| `flowParams` | Optional URL parameters appended to the initial authorization URL (e.g. `{ max_age: "0" }`). |
| `expectError` | Set to `true` when the path contains a self-transition (e.g. `["login-password", "login-password"]`). The runner requires a visible, non-empty error message. |
| `interventions` | Array of perturbation rules anchored to a state (`at`) or transition (`on`). `defineScenario()` rejects anchors not on the scenario path. |
| `finalUrlContains` | String substring expected in the terminal URL. |
| `assertions` | Token assertions (`noTenantId`, `tenantIdFromSeed`, `groups`, `noGroups`, `claims`). Only valid when the final state is `oidc-callback` (or `device-complete` with `requires.deviceFlow`); an empty `claims: []` is rejected at import. |
| `postChecks` | Array of named post-walk API verification checks (`PostCheckName[]`). |
| `cleanup` | Cleanup action (`"remove-totp" \| "remove-2fa" \| "restore-password" \| "remove-oidc" \| "remove-backup-codes"` or list). Required whenever mutating shared identity state; runs even on walk failure. Internal lane: admin API. Live lane: `framework/restore.ts` signs the identity in and undoes it through the public settings flow, which is what lets one seed serve a whole matrix run. |
| `lanes` | Execution lanes (`ExecutionLane[]`). Defaults to suite `defaultLanes`. |

Example scenario from `scenarios/session-scenarios.ts`:

```typescript
defineScenario({
  id: "forced-reauth-max-age-0",
  description: "max_age=0 forces full re-authentication including MFA",
  requires: { mfaEnabled: true, localUsersEnabled: true },
  user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
  phases: [
    {
      name: "establish-session",
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
    },
    {
      name: "forced-reauth",
      flowParams: { max_age: "0" },
      expectedPath: ["login-email", "login-password", "login-totp-verify", "oidc-callback"],
    },
  ],
  assertions: {
    noTenantId: true,
    claims: [reauthenticated(0, 1), amrRecords({ mustInclude: ["totp"] })],
  },
}),
```

The path proves the pages appeared; `reauthenticated(0, 1)` proves via `auth_time` that phase 2 was a real re-challenge and not a replayed session; `amrRecords` proves TOTP satisfied the gate.

## Adding a Scenario

1. Select a user archetype from `seeder/archetypes.ts` (`first-mfa`, `returning-mfa`, `no-mfa`, `dex-user`, `backup-code-user`, `totp-unlink-user`, `single-tenant-user`, `multi-tenant-user`, `webauthn-new-user`, `link-user`, `new-user-mfa`, `unverified-user`). Never touch the admin API in specs.
2. Locate or create the scenario suite in `scenarios/*-scenarios.ts`.
3. Declare the scenario with `defineScenario()`, referencing the structure shown in example 1. Declare only features the walk exercises in `requires`.
4. If the walk mutates credentials or settings, specify `cleanup`.
5. Run `make test-browser-list` to catch import-time validation errors.
6. Run the scenario: `npx playwright test specs/<suite>.spec.ts -g "<scenario-id>"`.

## Adding a Transition or Page State

When a new `expectedPath` names a pair `"A → B"` that `TRANSITION_TABLE` lacks, the runner fails with an unknown-transition error at that step.

Add an entry to `framework/transitions.ts`:

```typescript
"login-email → login-password": {
  description: "Enter email and continue",
  action: enterEmailAction,
},
```

Actions call helpers in `helpers/` (e.g. `helpers/login.ts`), never inline Playwright selectors in the table. If `B` is a page state that does not exist yet, add it to `PageState` in `helpers/page-state.ts` with a DOM-driven detector (not a URL check). Both are checked-in data: `../../docs/testing-spec.md` §10 item 12 describes how to measure unused edges.

## Adding a Capability Key

To introduce a new deployment fact for scenario gating, edit four files in this order:

1. `../../matrix/lib.mjs` (`capabilities()`): Emit the key in `snake_case` per row from the model. Then run `make matrix-generate`.
2. `framework/active-config.ts`: Add the key to `ActiveConfig`.
3. `framework/requires.ts` (`satisfies()`): Add the `camelCase` key to `ScenarioRequires` in `framework/scenario-types.ts` and add its comparison in `satisfies()`.
4. `../../matrix/verify/probes.mjs`: Add a live probe so preflight refuses a deployment whose real behaviour disagrees with the declaration (the anti-silent-shrink contract: declaration gates, preflight verifies, discovery never gates).

Run `make check`, and run `npx tsx scripts/expected-set.ts ../../matrix/rows/<row>/capabilities.json` on each pinned row to verify the executed test set shifts as expected.

## Assertions and Post Checks

Token assertions run against RP tokens captured at `oidc-callback` or `device-complete`. Scenarios only name assertions created from these factories:

| Factory | Behavior |
| --- | --- |
| `reauthenticated(fromPhase, toPhase)` | Asserts `auth_time` advanced between phase index `fromPhase` and `toPhase`. |
| `amrRecords({ mustInclude, mustExclude? }, phase?)` | Asserts `amr` claim contains `mustInclude` (array must not be empty) and excludes `mustExclude`. Missing `amr` fails. |
| `subjectIsSeededIdentity()` | Asserts `id_token` `sub` equals the seeded Kratos identity ID. |

An inline `{ name, run }` object in a scenario file is a review rejection.

Post checks run API-side verification after walk completion via `framework/intervention-checks.ts`:

| Post Check | Verification |
| --- | --- |
| `code-replay-revokes-family` | Replaying the authorization code revokes the tokens already issued for it (RFC 6749 §10.5). |
| `backup-codes-deactivated` | The `lookup_secret` credential is gone from the identity (admin API), not merely hidden by the UI. |
| `device-code-replay-rejected` | A second redemption of the spent `device_code` answers `invalid_grant`. |
| `registered-address-unverified` | With verification off, the freshly registered address is unverified server-side (admin API). |
| `linked-identity-tokens` | The sign-in through the linked provider yields the SEEDED identity: id_token `sub` equals the manifest `identityId`. |

## Debugging

- **Skipped: requires X=…, ActiveConfig=…**: The row's `capabilities.json` does not satisfy scenario requirements. This is expected gating. Verify settings in `active-config.json`.
- **Unknown transition error**: The state pair is missing from `TRANSITION_TABLE`. Add `"<from> → <to>"` in `framework/transitions.ts`.
- **Page-state detection timeout**: The runner outputs the expected state and detected state. Open `test-results/run-N/<test>/trace.zip` using `npx playwright show-trace`.
- **Flakes**: A scenario that passes only on the second run is a flake and fails the gate. Retries and quarantine tags are prohibited.
- **Foreign identities during re-seed**: The seeder deletes only identities in `@test.example`, tenants prefixed `iam-test `, and IDs recorded in the last manifest. Retaining foreign identities is by design.

## Review Rules

Review criteria from `../../docs/testing-spec.md` §11:

- Every new test must fail if the behaviour breaks.
- Assert the strongest available condition: tokens and claims over page arrivals, visible error text over navigation absence.
- Declare only features the walk exercises in `requires`.
- Retries, flake annotations, and quarantine tags are prohibited.
- New coverage must be a declarative `Scenario` in `scenarios/`; hand-written specs are reserved for non-state-walk edge cases.
- New machinery must fail at import time via `defineScenario()` when misused.

## Pointers

- Architecture rationale: `../../docs/testing-spec.md` §8
- Review checklist: `../../docs/testing-spec.md` §11
- Operator lanes and Google credentials: `LANES.md`
