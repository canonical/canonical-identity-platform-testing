# Skill: Generate Browser Test

## Name
generate-browser-test

## Description
Generate a Playwright browser test from a natural language description.
Deploys the platform (if needed), uses browser MCP to discover UI flows,
and produces a working test file using the unified helpers.

## Trigger Phrases
- "generate a browser test for"
- "create a playwright test that"
- "write an e2e test for the flow where"
- "record a test for"
- "make a browser test for"

## Input Format

The user provides a natural language description of the test flow:

```
Generate a browser test for the flow where a new user registers,
verifies their email, and then logs in for the first time.
```

Or more structured:

```
Create a Playwright test that:
1. Opens the login page
2. Clicks "Register"
3. Fills in email and password
4. Submits the form
5. Verifies the email via mailslurper
6. Logs in with the new credentials
7. Asserts the user is on the dashboard
```

## Workflow

### Step 1: Parse the Description

Extract from the user's input:
- **Target flow**: What the test should accomplish
- **Target profile**: infer from the capabilities the flow needs, then check
  `matrix/rows/<name>/capabilities.json`
  - hook-service group claims / user-verification webhook / enforced MFA →
    `canonical-internal` or `canonical-portal`
  - OIDC + WebAuthn sequencing → `canonical-internal`
  - Default → `core`
  - Multi-tenancy is `false` on every profile today; a tenant flow cannot be
    exercised anywhere (see `tests/browser/known-coverage-gaps.json`)
- **Key assertions**: What should happen at each step
- **Services involved**: Infer from flow description

### Step 2: Deploy the Platform

```bash
# If not already running:
make profile-set PROFILE=<profile>
make up
make test-smoke  # Wait for health
```

If the platform is already running, verify health:
```bash
make test-smoke
```

### Step 3: Seed Test Data

Use the seed-test-data skill/script:
```bash
make seed-test-data
```

This creates test identities, OAuth2 clients, and tenants as needed.

### Step 4: Navigate the Flow with Browser MCP

Using the browser MCP tools, walk through the flow:

1. **Open the starting URL** — typically `http://localhost:8082/login`
2. **Discover the page structure** — use `read_page` to get the accessibility tree
3. **Identify interactive elements** — form fields, buttons, links
4. **Walk through the flow** — fill forms, click buttons, wait for navigation
5. **Capture at each step**:
   - Selectors (prefer `data-testid`, then `aria-label`, then `name`, then `role`, then text)
   - Network requests (API calls made)
   - Page state changes (URL, visible elements)
   - Error states (if any)
6. **Record the complete flow** — sequence of actions + expected outcomes

### Step 5: Write the scenario, not the test

The suite is **scenario-as-data**. A spec file is a loop; the test lives in a
scenario definition. Do not hand-write a bespoke Playwright test — add a
`defineScenario({...})` entry to the matching suite in
`tests/browser/scenarios/` and let the existing spec file pick it up. Only
create a new spec file when you are adding a whole new suite.

Every scenario MUST declare `requires:`. `satisfies(scenario.requires,
activeConfig)` in `framework/scenario-runner.ts` is the suite's **only**
capability-gating predicate — a scenario with no `requires` claims it runs
everywhere, and the gate will hold you to that.

### Step 6: Validate the Generated Test

```bash
cd tests/browser && npx tsc --noEmit          # types + page-state names
cd tests/browser && npx playwright test --list  # is the new id collected?
cd tests/browser && npx playwright test specs/<name>.spec.ts  # needs a stack
```

If the test fails, iterate:
- Fix selectors (may have changed since discovery)
- Fix `expectedPath` — every entry must be a `PageStateType` from
  `helpers/page-state.ts`
- Adjust assertions

### Step 7: Report

- Write the scenario to `tests/browser/scenarios/<suite>-scenarios.ts`
  (and only if needed, the spec loop to `tests/browser/specs/<name>.spec.ts`)
- Report: flow discovered, scenario added, `--list` count before/after,
  validation result
- Confirm the scenario runs on at least one profile — `make gate-all-profiles`
  fails a test that skips everywhere
- Suggest: elements that need `data-testid` attributes

## Selector Discovery Heuristics

Priority order for selector discovery:
1. `data-testid` attributes (most stable, purpose-built for testing)
2. `aria-label` attributes (accessible, semantically meaningful)
3. `name` attributes on form inputs (stable for forms)
4. `role` attributes (accessible)
5. Text content (last resort, fragile)

## Scenario Template

Add to the relevant `tests/browser/scenarios/<suite>-scenarios.ts`:

```typescript
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { defineScenario } from "../framework/scenario-types";

defineScenario({
  id: "<kebab-case-id>",              // becomes the Playwright test title
  description: "<one line: what this proves>",
  // Capability gate — the ONLY thing that may skip this scenario.
  requires: { mfaEnabled: true, multiTenancy: false, localUsersEnabled: true },
  // Users come from the seeder. `ref` MUST name an archetype in
  // seeder/archetypes.ts — specs never provision identities themselves.
  user: { ref: "returning-mfa", credentials: ["password", "totp"], totpConfigured: true },
  flow: "authorization_code",
  // Each entry is a PageStateType from helpers/page-state.ts.
  expectedPath: [
    "login-email",
    "login-password",
    "login-totp-verify",
    "oidc-callback",
  ],
  assertions: { noTenantId: true, noGroups: true },
  // cleanup: "remove-totp",   // if the scenario mutates the identity
});
```

A new **suite** also needs its spec loop — that is the whole spec file:

```typescript
// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { test } from "@playwright/test";
import { <name>Scenarios } from "../scenarios/<name>-scenarios";
import { runScenario } from "../framework/scenario-runner";
import { readManifest } from "../framework/manifest";

for (const scenario of <name>Scenarios.scenarios) {
  test(scenario.id, async ({ page }) => {
    const manifest = readManifest();
    await runScenario(page, scenario, manifest);
  });
}
```

…and an import in `tests/browser/scripts/expected-set.ts`, so the matrix lane
can predict the executed set for the new suite.

**Invariants you must not break:**
- The seeder owns all admin-API access; specs are browser-only and read
  `manifest.json`. Never call `createIdentity`/`deleteIdentity` from a spec —
  add an archetype to `seeder/archetypes.ts` instead.
- A user `ref` that no archetype declares fails loudly at lookup time.
- `retries` is pinned to `0`. There is no flaky or quarantine tag.

## Common Flow Patterns

### Login Flow
1. Navigate to `/login`
2. Fill email field
3. Fill password field
4. Click submit button
5. Assert redirect to dashboard or tenant selection

### Registration Flow
1. Navigate to `/login`
2. Click "Register" link
3. Fill registration form (email, password, name)
4. Submit
5. Verify email via mailslurper
6. Login with new credentials

### OIDC Login Flow
1. Navigate to OIDC consumer app
2. Click "Login with SSO"
3. Complete login at identity platform
4. Consent to scopes
5. Assert redirect back to consumer app
6. Assert user info in consumer app

### Tenant Management Flow
**Not exercisable today** — `multi_tenancy_enabled` is `false` on every
profile, so tenant scenarios are parked in
`tests/browser/known-coverage-gaps.json` with an unblock condition. Do not
generate a tenant test against a profile that cannot deploy tenant-service.

## Related Skills
- `spin-up-platform` — Deploy the platform
- `seed-test-data` — Create test data
- `run-e2e` — Run E2E tests
