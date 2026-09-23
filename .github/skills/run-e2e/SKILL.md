# Skill: Run E2E Tests

## When
"run e2e tests", "test against profile X", "validate the platform", "check if tests pass".

## Commands
```bash
make profile-show                       # which profile is active (or make profile-set PROFILE=<name>)
docker compose ps --quiet 2>/dev/null   # not running? make up
make test-smoke                         # health; a failure here is infrastructure, abort and report

make test-e2e            # Go E2E (smoke + integration)
make test-integration    # Go integration only
make seed-test-data-clean && make test-browser          # Playwright suite, internal lane
make test-browser-live / make test-browser-internal     # one lane only
```
The blocking contract — typecheck, up, smoke, browser suite twice with a re-seed before each run,
then Go E2E — is the gate, not the individual targets:
```bash
make gate PROFILE=<name>      # one profile
make gate-all-profiles        # every pinned row + cross-profile coverage union
```
It fails on any failure, any flake, any skip not justified by `tests/browser/scripts/skip-allowlist.mjs`,
and on the executed set differing between the two runs.

Isolated run (reviewer nodes): prefix every target with `COMPOSE_PROJECT_NAME=review-<profile>`.

## Report
Total tests run, pass/fail count, and the full output of every failing test.

## Success
- `make gate PROFILE=<name>` exits 0 — the only proof that a change works.
- Never add a retry, a flaky tag, or a `test.skip` without a runtime capability reason to get there.

## Related
`spin-up-platform`, `seed-test-data`, `profile-switch`.
