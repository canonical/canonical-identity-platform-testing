# Skill: Generate Browser Test

## When
"generate a browser test for", "create a playwright test that", "write an e2e test for the flow where".

The suite is scenario-as-data: a browser test is a `defineScenario({...})` entry in
`tests/browser/scenarios/<suite>-scenarios.ts`, never a hand-written Playwright spec.
Structure, templates and debugging live in `tests/browser/README.md` (Anatomy of a
Scenario, Adding a Scenario, Adding a Transition or Page State); this skill is the checklist.

## Checklist
1. Pick the profile from the capabilities the flow needs (`matrix/rows/<name>/capabilities.json`):
   hook-service claims / user-verification / enforced MFA → `canonical-internal` or `canonical-portal`;
   OIDC + WebAuthn sequencing → `canonical-internal`; multi-tenancy → `canonical-portal`; else `core`.
   Multi-tenancy + sequencing exists on no profile — see `tests/browser/known-coverage-gaps.json`; report it as blocked.
2. Stack up and seeded: `make profile-set PROFILE=<name> && make up && make test-smoke && make seed-test-data-clean`.
3. Walk the flow once in a browser (start at `http://localhost/`) and note the sequence of page states.
4. Add the scenario to the matching suite. Every entry of `expectedPath` must be a `PageStateType`
   from `tests/browser/helpers/page-state.ts`; every `"A → B"` pair must exist in `framework/transitions.ts`.
5. Declare `requires:` — `satisfies(scenario.requires, activeConfig)` is the suite's only skip predicate;
   a scenario with no `requires` claims it runs everywhere and the gate holds you to that.
6. `user.ref` must name an archetype in `tests/browser/seeder/archetypes.ts`. Never call the admin API from a spec;
   add an archetype instead. Add `cleanup` if the walk mutates the identity.
7. A new suite also needs a spec loop in `tests/browser/specs/<suite>.spec.ts` and an import in
   `tests/browser/scripts/expected-set.ts` so the matrix lane can predict the executed set.
8. Validate:
   ```bash
   make test-browser-typecheck
   make test-browser-list                                      # new id collected?
   cd tests/browser && npx playwright test specs/<suite>.spec.ts -g "<scenario-id>"
   ```

## Success
- The scenario id appears in `make test-browser-list` and passes against a running stack.
- It runs on at least one pinned profile — `make gate-all-profiles` fails a test that skips everywhere.
- No `retries`, no flaky tag, no `test.skip` outside capability gating.

## Related
`spin-up-platform`, `seed-test-data`, `run-e2e`.
