# Skill: Run E2E Scenario

## Name
run-e2e-scenario

## Description
Accept a natural language description of a test scenario, deploy the
appropriate profile, seed test data, run the scenario (browser MCP for UI,
HTTP for API), capture results, and generate a report. Optionally produce
a permanent test from the successful scenario.

## Trigger Phrases
- "run e2e scenario"
- "test the flow where"
- "validate that"
- "run a scenario for"

## Input Format

```
Run an E2E scenario: a returning user logs in with password + TOTP, and the
issued access token carries their hook-service group claim.
```

Or more structured:

```
Test the following scenario:
1. Deploy the canonical-internal profile
2. Seed test data
3. Start the authorization_code flow from the OIDC consumer app
4. Log in as the `returning-mfa` archetype (password, then TOTP)
5. Verify the redirect lands on oidc-callback
6. Verify the access token carries groups: ["platform-testers"]
7. Verify the token carries no tenant_id
```

> **Capability check first.** A scenario can only be run where the profile
> declares the capability it needs — read
> `matrix/rows/<profile>/capabilities.json`. Notably `multi_tenancy_enabled`
> is `false` on **every** profile today, so tenant scenarios cannot be
> executed anywhere; they are parked in
> `tests/browser/known-coverage-gaps.json`. Report that as a blocked scenario
> rather than improvising a workaround.

## Workflow

### Step 1: Parse the Scenario

Extract:
- **Profile**: Which profile to deploy (infer from services mentioned)
- **Test data**: which seeder archetypes (`tests/browser/seeder/archetypes.ts`) are needed
- **Steps**: Ordered sequence of actions
- **Assertions**: Expected outcomes at each step

### Step 2: Deploy the Platform

```bash
make profile-set PROFILE=<profile>
make up
make test-smoke  # Wait for health
```

### Step 3: Seed Test Data

```bash
make seed-test-data
```

### Step 4: Execute the Scenario

#### UI Steps (Browser MCP)
For steps involving the browser:
1. Open the starting URL
2. Navigate through the flow
3. Capture screenshots at key points
4. Record network requests
5. Assert expected outcomes

#### API Steps (HTTP)
For steps involving API calls:
1. Get authentication token (via Kratos or STS)
2. Make the API call
3. Assert response status and body
4. Capture response data for subsequent steps

### Step 5: Capture Results

Record:
- Step-by-step pass/fail
- Screenshots (for UI steps)
- Response data (for API steps)
- Error messages
- Timing information

### Step 6: Generate Report

```markdown
## E2E Scenario Report

**Scenario:** <description>
**Profile:** <profile>
**Date:** <date>
**Result:** ✅ PASS / ❌ FAIL

### Steps

| # | Step | Type | Result | Details |
|---|------|------|--------|---------|
| 1 | Deploy platform | Setup | ✅ | All services healthy |
| 2 | Seed test data | Setup | ✅ | archetypes seeded, manifest.json written |
| 3 | Start authorization_code flow | UI | ✅ | login-email |
| 4 | Password | UI | ✅ | login-password |
| 5 | TOTP | UI | ✅ | login-totp-verify |
| 6 | Redirect | UI | ✅ | oidc-callback |
| 7 | Group claim present | API | ✅ | groups: ["platform-testers"] |
| 8 | No tenant_id | API | ✅ | claim absent (expected) |

### Summary
All steps passed. Scenario validated successfully.
```

### Step 7: Optionally Promote to a Permanent Test

If the scenario passes, offer to promote it. The suite is scenario-as-data:
a permanent browser test is a `defineScenario({...})` entry in
`tests/browser/scenarios/`, **not** a hand-written spec. Use the
`generate-browser-test` skill, which carries the template and the
`requires:`/archetype invariants. For API-heavy scenarios, a Go test under
`tests/e2e/` is the right home.

## Related Skills
- `generate-browser-test` — Generate a permanent Playwright test
- `spin-up-platform` — Deploy the platform
- `seed-test-data` — Create test data
