# Skill: Run E2E Scenario

## When
"run e2e scenario", "test the flow where", "validate that": a one-off natural-language scenario
run against a deployed profile, with a report. Optionally promoted to a permanent test afterwards.

## Steps
1. Parse: profile (from the capabilities the flow needs — read `matrix/rows/<name>/capabilities.json`),
   seeder archetypes (`tests/browser/seeder/archetypes.ts`), ordered steps, assertions.
   `multi_tenancy_enabled` is `true` on `canonical-portal` only and no profile combines it with
   WebAuthn sequencing (`tests/browser/known-coverage-gaps.json`); report that shape as blocked, do not improvise.
2. Deploy and seed:
   ```bash
   make profile-set PROFILE=<name> && make up && make test-smoke
   make seed-test-data-clean
   ```
3. Execute. UI steps: drive the browser from `http://localhost/` (or the RP at `http://127.0.0.1:4446`),
   screenshot at key points. API steps: obtain a token, call the endpoint, assert status and body.
4. Report as a table — `# | Step | Type (Setup/UI/API) | Result | Details` — with a one-line verdict.
   Quote the exact error for any failed step.
5. Promote if it passed: a browser scenario becomes a `defineScenario` entry via `generate-browser-test`;
   an API-heavy scenario becomes a Go test under `tests/e2e/`.

## Success
- Every step has a pass/fail row and the report names the profile it ran on.
- A blocked scenario is reported as blocked with the missing capability, not worked around.

## Related
`generate-browser-test`, `spin-up-platform`, `seed-test-data`.
