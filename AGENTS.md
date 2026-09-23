# AGENTS.md — Identity Platform Test Plane

## Purpose
This repo tests the Canonical Identity Platform; it builds nothing and contains no service
checkouts. A run brings up a deployment profile (Docker Compose from published images, or
store charms on Juju), seeds deterministic data, then runs the Playwright browser suite and
the Go E2E suite against it. Never make a lane depend on a local checkout.

## Layout
| Path | Role |
|---|---|
| `README.md` | Start here: prerequisites, first gate, where to go next |
| `tests/browser/` | Playwright suite — the primary asset; `README.md` there is the how-to, `LANES.md` the operator doc |
| `tests/e2e/` | Go E2E + smoke + integration tests |
| `docker/` | Compose layers: `infra`, `auth`, `services`; `traefik/login-ui-routes.yml` is the ingress |
| `matrix/` | Config-matrix lane: `config-model.mjs` (operator-producible model), pairwise generator, `run-row.mjs`, `verify.mjs` preflight |
| `matrix/rows/<name>/` | GENERATED compose override + `capabilities.json`; pinned rows `core`, `canonical-internal`, `canonical-portal` are the gate profiles |
| `matrix/backends/juju/` | Charmed backend: revision-pinned terraform `root/` (rows applied as `-var-file=rows/<row>/juju.tfvars.json`) + k8s manifests |
| `scripts/audit-compose-ports.sh` | Guards against duplicate host-port publications |
| `docs/testing-spec.md` | The testing spec — goal, configuration surface, gate + matrix contracts |
| `docs/ci-spec.md` | CI lanes: PR gate, nightly matrix, juju drift gate, triage |
| `docs/juju-lane-runbook.md` | Charmed-backend runbooks |

## Browser suite architecture
Scenarios are data, not logic; adding a test means adding a data object. How-to: `tests/browser/README.md`.
- `scenarios/*-scenarios.ts`: declarative `Scenario` objects via `defineScenario()`, which rejects malformed entries at import time.
- `framework/scenario-runner.ts` walks `expectedPath` pairwise; each `"A → B"` pair indexes `framework/transitions.ts`.
- `helpers/page-state.ts` detects state from the DOM — login-ui multiplexes many states onto few URLs.
- `expectError: true` on a repeated state requires a visible, non-empty error message; "did not navigate" is never the assertion.
- `freshSession: true` on a later phase clears cookies but not the virtual authenticator (how WebAuthn sign-in is reachable).
- `interventions` perturb the scenario's own path (`reload`, `replay-current-url`, `history-back`, `history-roundtrip`, `double-submit`); primitives in `framework/interventions.ts`.
- Error terminals (`oidc-error-page`, `oidc-callback-error`) are enterable from `start` only, via malformed-authorize `flowParams`.
- Token assertions live in `framework/claim-assertions.ts`, API post checks in `framework/intervention-checks.ts`; scenarios name them, never implement them.
- `seeder/` owns all admin-API access; `seeder/archetypes.ts` is the sole source of users; `seed.ts` writes `manifest.json`, which specs read.
- `framework/global-setup.ts` produces `active-config.json` (from `BROWSER_TEST_CAPABILITIES` or live `/api/v0/app-config`); the stack must be up before collection.

### Lanes, gating, determinism
- `BROWSER_TEST_LANE=internal` (default; Mailslurper + admin access) or `live` (UI-only, safe against a real deployment). Suites set `defaultLanes`; `transitions.ts:assertInternalLane()` is the backstop.
- Capability gating is unconditional: `runScenario` lane-gates, then `satisfies(scenario.requires, readActiveConfig())`. That is the only skip predicate.
- In the matrix lane the row's declared `capabilities.json` drives gating, never runtime discovery; `matrix/verify.mjs` must pass first so a bad reconfiguration aborts instead of shrinking the executed set.
- `workers: 1`, `fullyParallel: false` — Kratos sessions and identities are global mutable state.
- `retries: 0` everywhere; a test that passes only on retry is flaky and must fail the gate. No flaky/quarantine tag exists: a test passes deterministically or is removed.

## Commands
| Command | Effect |
|---|---|
| `make up` / `make down` | Bring up infra + auth + services for the active profile (blocks until healthy) / tear down |
| `make profile-set PROFILE=<name>` / `profile-show` / `profile-validate` | Switch, print, validate the active profile |
| `make seed-test-data-clean` / `unseed-test-data` | Wipe and re-seed the test plane's own users/tenants / delete them and re-create nothing |
| `make test-browser` / `test-browser-live` / `test-browser-internal` | Playwright suite: internal lane / live lane only / full internal lane |
| `make test-browser-list` / `test-browser-typecheck` / `test-browser-unit` / `test-browser-audit-live` | List collected tests / typecheck / unit-test pure logic / static live-lane audit |
| `make test-browser-gate` | Suite twice; fail on any failure, flake, or skip not justified by `tests/browser/scripts/skip-allowlist.mjs` |
| `make test-e2e` / `test-smoke` / `test-integration` | Go suites |
| `make gate PROFILE=<name>` / `gate-all-profiles` | The gate: typecheck → up → smoke → browser suite twice → Go E2E; all pinned rows + cross-profile coverage union |
| `make check` | Hermetic guard: typecheck, matrix artifacts, offline tests, port audit (no stack) |
| `make matrix-generate` / `matrix-check` / `matrix-test` | Regenerate / verify matrix artifacts from `matrix/config-model.mjs` / offline harness tests |
| `make test-matrix-row ROW=<name> [BACKEND=compose\|juju\|urls]` | One row: deploy → `verify.mjs` preflight → seed → gated suite → expected-set verdict. `urls` needs `LOGIN_UI_URL`; `MATRIX_JUJU_BROWSER=0` skips the juju browser leg |
| `make test-matrix-row ROW=<name> BACKEND=juju ATTACH=1 [PLAN_ONLY=1]` | Attach mode: configure an EXISTING charmed deployment via terraform import; `PLAN_ONLY=1` is a zero-mutation drift gate |
| `make test-matrix` | Nightly matrix lane over every seed+generated row (non-blocking; failures file issues) |
| `make audit-ports` / `make dev-check` | Duplicate host-port check / toolchain check (`JUJU_LANE=1` also requires `terraform` + `juju` on PATH) |

## Port Mapping (Canonical)
| Service | Host Port |
|---|---|
| kratos (public / admin) | 4433 / 4434 |
| hydra (public / admin) | 4444 / 4445 |
| hook-service / tenant-service / user-verification | 8080 / 8081 / 8083 |
| login-ui | 80 (via Traefik) |
| oidc-consumer (test RP) | 4446 |
| openfga HTTP / gRPC / playground | 8180 / 8181 / 3001 |
| dex | 5556 |
| mailslurper (UI / API) | 4436 / 4437 |
| postgres | not published; `intranet` compose network only |

## Rules
- Before calling anything a product defect, prove the harness matches the reference deployment (login-ui `docker-compose.dev.yml`, `docker/traefik/login-ui-routes.yml`, the charms); a finding that only reproduces here is about here.
- The login-ui skip/accept decision spans three systems (login-ui BFF, Hydra login session `authenticated_at`, Kratos flow state via `return_to`); never reason about a loop from one component's source, and confirm which server received the submission (Kratos's request log records the client address).
- Cite upstream sources as commit-pinned permalinks or `<repo>@<sha> path:line`, never local paths.
- Browser coverage is a `Scenario` in `tests/browser/scenarios/`, not a hand-written spec, unless the behaviour cannot fit the state-transition model.
- Never add a flaky tag, a `test.skip` without a runtime capability reason, or a retry.
- All admin-API provisioning belongs in `tests/browser/seeder/`, never in a spec.
- The seeder deletes only what `tests/browser/seeder/ownership.ts` authorises (`@test.example` domain, `iam-test ` tenant prefix, ids in the last manifest); everything else is foreign — counted, reported, left alone. Never widen cleanup to list-and-delete.
- `MANIFEST=<path>` relocates the seed manifest for seeder and suite alike, so the seeding host and test host may differ.
- Run `make gate PROFILE=<name>` before claiming a change works.
- `matrix/rows/` and `matrix/matrix.json` are generated: edit `matrix/config-model.mjs`, run `make matrix-generate`; `make matrix-check` guards drift.
- Every harness-owned juju/terraform call passes `assertController()` (`matrix/controller-guard.mjs`): the resolved `juju show-controller` must equal `MATRIX_ALLOWED_CONTROLLER` (default `microk8s-localhost`); `JUJU_MODEL`/`JUJU_CONTROLLER_ADDRESSES` are refused. Bare `terraform` in `root/` is outside the guard — run `juju show-controller` first.
- `matrix/watchdog.mjs` is an observer: it journals status changes and stuck units and never mutates the model. No `juju resolved`, no config kick, anywhere; a wedged row fails its settle budget and stays red.
- Attach mode never deploys apps, never manages secrets it did not create, and refuses local-origin charms. After attach work, confirm `terraform workspace show` says `default` in `matrix/backends/juju/root/` before bare terraform commands.
- `matrix/backends/juju/root/local.auto.tfvars` is this machine's substrate identity (gitignored, required); without the cloud pin a clean-mode apply plans model replacement.
- `matrix/backends/juju/root/terraform.tfstate*` is secret-bearing: gitignored, never committed, never pasted into a bug report — excerpt the one non-secret attribute you need. `.terraform.lock.hcl` is tracked on purpose; provider bumps are a reviewed lock-file commit.
