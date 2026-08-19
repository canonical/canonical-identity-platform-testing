# Skill: Run E2E Tests

## Description

Runs end-to-end tests against the current or specified deployment profile. Ensures the platform is up and healthy before executing tests.

## Trigger Phrases

- "run e2e tests"
- "run end-to-end tests"
- "test against profile X"
- "validate the platform"
- "check if tests pass"

## Steps

1. **Determine target profile:**
   If a profile is specified, use it. Otherwise read the current active profile:
   ```bash
   make profile-show
   ```

2. **Ensure the platform is running:**
   ```bash
   docker compose ps --quiet 2>/dev/null
   ```
   If not running, start it:
   ```bash
   make up
   ```

3. **Wait for health:**
   Allow up to 120 seconds for all services to become healthy:
   ```bash
   make test-smoke
   ```
   If smoke tests fail, report infrastructure issue and abort.

4. **Run the tests.** Pick the layer that matches the ask:
   ```bash
   make test-e2e            # Go E2E (smoke + integration) against the stack
   make test-integration    # Go integration tests only
   make test-browser        # the Playwright suite (needs seeded data)
   ```
   `make test-e2e` covers only the Go layer. The browser suite needs
   `make seed-test-data` first.

   For the **blocking contract** — typecheck, up, smoke, the browser suite
   twice with a re-seed before each run, then Go E2E — run the gate instead of
   the individual targets:
   ```bash
   make gate PROFILE=<name>      # one profile
   make gate-all-profiles        # every profile + cross-profile coverage check
   ```
   The gate fails on any failure, any flake, any **unjustified** skip, and on
   the executed set differing between the two runs.

5. **Capture and report results:**
   - Total tests run
   - Pass/fail count
   - Specific failure messages (full output for failing tests)

## Isolated Execution (for Reviewer nodes)

When running in review mode with an isolated project name:

```bash
COMPOSE_PROJECT_NAME=review-<profile> make up
COMPOSE_PROJECT_NAME=review-<profile> make test-smoke
COMPOSE_PROJECT_NAME=review-<profile> make test-e2e
COMPOSE_PROJECT_NAME=review-<profile> make down
```

## Tool Access

- Terminal: `make profile-show`, `make up`, `make test-smoke`,
  `make seed-test-data`, `make test-e2e`, `make test-integration`,
  `make test-browser`, `make gate`, `make gate-all-profiles`, `make down`,
  `docker compose ps`
