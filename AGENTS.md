# AGENTS.md — Identity Platform Test Plane

## Context
You are working in the Canonical Identity Platform control repo.
Its single purpose is **testing the platform**: bring up a deployment profile with
Docker Compose, seed deterministic data, then run the Playwright browser suite and
the Go E2E suite against it.

The platform itself is a polyrepo of Go microservices. This repo builds nothing —
and it contains **no service checkouts**. Every service under test runs from a
published image (`docker/docker-compose.*.yml`) or a store charm
(`matrix/backends/juju/`), so a fresh clone needs nothing beside it. Do not
make a lane depend on a local checkout — see the overlay policy in
`docs/juju-lane-runbook.md` (decision D-2).

## Layout
| Path | Role |
|---|---|
| `tests/browser/` | Playwright suite — the primary asset |
| `tests/e2e/` | Go E2E + smoke + integration tests |
| `docker/` | Compose layers: `infra`, `auth`, `services` |
| `matrix/rows/<name>/` | GENERATED per-row compose override + capabilities manifest; the three pinned rows (`core`, `canonical-internal`, `canonical-portal`) ARE the gate profiles |
| `matrix/` | Config-matrix lane: operator-producible model (`config-model.mjs`), pairwise generator, materialized rows (`rows/`) — docs/testing-spec.md |
| `matrix/backends/juju/` | Charmed backend: row root terraform (`root/`, revision-pinned; rows applied as `-var-file=rows/<row>/juju.tfvars.json`) + k8s manifests for mailslurper/dex. `JUJU_CONTROLLER=microk8s-localhost` is ENFORCED by `matrix/controller-guard.mjs`. Teardown: `terraform destroy` |
| `scripts/audit-compose-ports.sh` | Guards against duplicate host-port publications |
| `docs/testing-spec.md` | **The testing spec** — goal, approach, configuration surface, gate + matrix contracts |
| `docs/testing-proposal.md` | Review-facing RFC/pitch for the same architecture — narrative, not contracts. The spec is authoritative where they disagree |
| `docs/juju-lane-runbook.md` | Charmed-backend operational runbooks |

## Browser suite architecture
Scenarios are **data, not logic**.

- `tests/browser/scenarios/*-scenarios.ts` — declarative `Scenario` objects:
  `{id, requires, user.ref, expectedPath[], expectError, freshSession, interventions,
  postChecks, finalUrlContains, assertions, cleanup, defaultLanes}`.
  `freshSession: true` on a later phase clears cookies but NOT the virtual authenticator —
  that is how the one WebAuthn assertion (sign-in with an existing key) is reachable.
  `interventions` declare weird-user-behavior perturbations anchored to the scenario's own
  path (`{at: <state>, do: "reload" | "replay-current-url" | "history-back" |
  "history-roundtrip"}` after a state's assertion — roundtrip = real Back to `via`, real
  Forward back to `at`, walk continues; `{on: "<A → B>", do: "double-submit"}` modifies that
  transition's submit) —
  primitives live in `framework/interventions.ts`, and `defineScenario()` rejects anchors
  that don't name the path. Error terminals (`oidc-error-page`, `oidc-callback-error`) are
  enterable from `start` ONLY, via malformed-authorize `flowParams` (the oidc-error suite);
  a mid-journey step into one is still an illegal transition.
  Claim assertions live in `framework/claim-assertions.ts` (`reauthenticated`, `amrRecords`)
  and API-side post checks in `framework/intervention-checks.ts`
  (`code-replay-revokes-family`): scenarios name an assertion, they never implement one.
- `tests/browser/framework/scenario-runner.ts` — walks `expectedPath` pairwise; each
  `"stateA → stateB"` pair indexes the action map in `framework/transitions.ts`.
  A repeated state is an error path: `expectError: true` makes the runner require a
  visible, non-empty error message there, so "did not navigate" is never the whole
  assertion.
- `tests/browser/helpers/page-state.ts` — detects the current page state from the DOM.
  The login-ui multiplexes many states onto few URLs, so detection is DOM-driven, not URL-driven.
- `tests/browser/seeder/` — owns **all** admin-API access. `seeder/archetypes.ts` is the
  sole source of truth for which users exist; `seed.ts` writes `manifest.json`.
  Specs are browser-only and read the manifest.
- `tests/browser/framework/global-setup.ts` — fetches `/api/v0/app-config` from the live
  login-ui into `active-config.json`. The stack must be up before collection.

Adding a test means adding a data object, not writing Playwright code.

### Lanes
`BROWSER_TEST_LANE` selects `internal` (default, full access incl. Mailslurper and admin
bootstrapping) or `live` (UI-only, safe against a real deployment). Lane gating happens at
suite level via `defaultLanes`; `framework/transitions.ts:assertInternalLane()` is the hard
backstop. `tests/browser/LANES.md` is the operator doc.

Capability gating is separate and unconditional: `runScenario` lane-gates, then applies
`satisfies(scenario.requires, readActiveConfig())`. That is the ONLY predicate — there is no
`BROWSER_TEST_ENFORCE_REQUIRES` switch and no legacy `checkRequires` path.

### Determinism rules
- `workers: 1`, `fullyParallel: false` — Kratos sessions and identities are global mutable state.
- `retries: 0` in every environment. A test that only passes on retry is flaky, and
  flakiness must fail the gate rather than be absorbed.
- No flaky/quarantine tag exists. A test either passes deterministically or it is removed.

## Commands
| Command | Effect |
|---|---|
| `make up` | Bring up infra + auth + services for the active profile, block until healthy |
| `make down` | Tear down |
| `make profile-set PROFILE=<name>` | Switch active profile |
| `make seed-test-data-clean` | Delete the test plane's own users/tenants and re-seed them |
| `make unseed-test-data` | Delete the test plane's own users/tenants, re-create nothing |
| `make test-browser` | Playwright suite, internal lane |
| `make test-browser-profile PROFILE=<name>` | Playwright suite for one profile |
| `make test-browser-list` | List collected tests without running |
| `make test-browser-audit-live` | Static live-lane compatibility audit |
| `make matrix-generate` / `matrix-check` | Regenerate / verify the config matrix from `matrix/config-model.mjs` |
| `make test-matrix-row ROW=<name> [BACKEND=compose\|juju\|urls]` | One matrix row under the full contract: deploy → `matrix/verify.mjs` preflight → seed → enforce-gated suite → expected-set verdict. Browser leg runs by default on juju (`MATRIX_JUJU_BROWSER=0` skips); `urls` needs `LOGIN_UI_URL` (+ optional admin/hydra/mail URLs) and no substrate access |
| `make test-matrix-row ROW=<name> BACKEND=juju ATTACH=1 [PLAN_ONLY=1]` | Attach mode: configure an EXISTING charmed deployment via ephemeral-state terraform import (adopt → transition), then the full contract. `PLAN_ONLY=1` = zero-mutation drift gate. Store-origin charms only; never deploys apps (docs/testing-spec.md) |
| `make test-matrix` | Nightly matrix lane across every seed+generated row (non-blocking; failures file issues) |
| `make test-e2e` / `test-smoke` / `test-integration` | Go suites |
| `make gate PROFILE=<name>` | **The gate**: up → seed → browser suite twice → Go E2E |
| `make gate-all-profiles` | The gate across every pinned matrix row |
| `make audit-ports` | Detect duplicate host-port publications |
| `make test-browser-typecheck` | Typecheck the suite — catches helper/locator drift before a run |
| `make test-browser-gate` | Run the suite twice; fail on any failure, flake, or **unjustified** skip (a skip is justified only when its reason matches the capability allow-list in `tests/browser/scripts/skip-allowlist.mjs`) |

## Port Mapping (Canonical)
| Service | Host Port |
|---|---|
| kratos (public / admin) | 4433 / 4434 |
| hydra (public / admin) | 4444 / 4445 |
| hook-service | 8080 |
| tenant-service | 8081 |
| login-ui | 80 (via Traefik) |
| user-verification | 8083 |
| oidc-consumer (test RP) | 4446 |
| openfga HTTP / gRPC / playground | 8180 / 8181 / 3001 |
| dex | 5556 |
| mailslurper | 4436 / 4437 |

Postgres is **not** published to the host — it is reachable only on the `intranet`
compose network. Publishing 5432 collided with unrelated local stacks.

## Rules
- **Before calling anything a PRODUCT defect, prove the harness is wired like the
  reference deployment.** A finding that only reproduces here is a finding about
  here. C-16 is the standing example: `kratos.yml` had `serve.public.base_url`
  on Kratos's published port instead of the ingress, so every browser-submitted
  self-service form bypassed Traefik and login-ui's BFF — which is the component
  that redeems the Hydra login challenge. That produced two "product defects"
  (retired PD-7, resolved S-7), a truncated scenario and a drafted upstream bug
  report, all describing our own config. Diff against login-ui's
  `docker-compose.dev.yml` + `docker/traefik/login-ui-routes.yml` and the charms.
- The login-ui **skip/accept decision spans three systems** — login-ui's BFF,
  Hydra's login session (`authenticated_at`, refreshed only on accept) and
  Kratos's flow state (`oauth2_login_challenge`, never set under sequencing; it
  rides inside `return_to`). Never reason about a loop or a lost challenge from
  one component's source alone, and always confirm which server actually
  received the submission — Kratos's request log records the client address.
- Findings and survey evidence cite upstream sources as COMMIT-PINNED GitHub
  permalinks (or `<repo>@<sha> path:line`), never paths into local clones —
  unpinned checkouts drift and make `file:line` evidence unverifiable.
- Adding browser coverage means adding a `Scenario` to `tests/browser/scenarios/`,
  not a new hand-written spec, unless the behaviour genuinely does not fit the
  state-transition model (browser back/forward is the standing example).
- Never introduce a flaky-test tag, `test.skip` without a runtime capability reason,
  or a retry to paper over a race.
- All admin-API provisioning belongs in `tests/browser/seeder/`, never in a spec.
- The seeder only ever deletes what `tests/browser/seeder/ownership.ts` authorises:
  the reserved `@test.example` domain (RFC 2606) and the `iam-test ` tenant prefix,
  widened by ids the manifest we last wrote recorded. Anything else on the
  deployment is foreign and is counted, reported, and left alone — that is what
  lets an admin seed a real deployment out of band (`tests/browser/LANES.md`).
  Never broaden a cleanup to an unscoped list-and-delete, and never key ownership
  on an email the test plane does not control.
- `MANIFEST=<path>` relocates the seed manifest for the seeder and the suite
  alike, so the seeding host and the test host can differ.
- Run `make gate PROFILE=<name>` before claiming a change works.
- `matrix/rows/` and `matrix/matrix.json` are generated — edit `matrix/config-model.mjs`
  and run `make matrix-generate`; `make matrix-check` guards drift in CI.
- In the matrix lane, gating is driven by the row's declared `capabilities.json`,
  never by runtime discovery; `matrix/verify.mjs` must pass before tests run, so a
  failed reconfiguration aborts loudly instead of silently shrinking the executed set.
- Every juju/terraform operation the matrix harness owns calls `assertController()`
  (`matrix/controller-guard.mjs`): the RESOLVED controller from `juju show-controller`
  must equal `MATRIX_ALLOWED_CONTROLLER` (default `microk8s-localhost`), and
  `JUJU_MODEL`/`JUJU_CONTROLLER_ADDRESSES` are refused because they route around
  that resolution. Bare by-hand `terraform` in `root/` is outside the guard — run
  `juju show-controller` first (docs/juju-lane-runbook.md).
- Juju row runs self-spawn `matrix/watchdog.mjs` — an OBSERVER: it journals workload-status changes and stuck units (wedge frequency is upstream-bug evidence; never silence it) and never mutates the model. No `juju resolved`, no config kick, anywhere: rows hitting the filed kratos-operator wedge fail their settle budget and stay red (D-3).
- Attach mode (`ATTACH=1`) configures existing deployments via pure terraform:
  ephemeral `attach` workspace, discovery-generated imports, adopt → transition.
  It never deploys apps, never manages secrets it didn't create, and refuses
  local-origin charms. After any attach work, verify `terraform workspace show`
  says `default` in `matrix/backends/juju/root/` before bare terraform commands.
- `matrix/backends/juju/root/local.auto.tfvars` is this machine's substrate
  identity (ingress hostname, cloud/region) — gitignored, required; without the
  cloud pin a clean-mode apply plans model replacement.
- `matrix/backends/juju/root/terraform.tfstate*` is SECRET-BEARING by construction
  (the root manages `juju_secret`, and terraform stores secret values in cleartext):
  gitignored, never committed, and never shared/pasted/attached to a bug report or
  upstream issue — excerpt the one non-secret attribute you need instead. The sibling
  `.terraform.lock.hcl` is the inverse: TRACKED on purpose, because `providers.tf`
  floats on `~> 1.0.0`. Provider bumps are a reviewed lock-file commit.
- `make dev-check` verifies the compose-lane toolchain (go/node/npx/docker compose);
  `JUJU_LANE=1 make dev-check` additionally requires `terraform` and `juju` on PATH
  (presence only — it never invokes juju).
