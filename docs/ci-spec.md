# CI specification

Status: implemented (workflows in `.github/workflows/`); staged work in §8.
This document is the design contract for the test plane's CI. It implements
item 16 of `docs/testing-spec.md` §10 ("a blocking PR gate") and extends the
spec's non-blocking matrix contract ("failures file issues") with a concrete
mechanism. Where this document and `docs/testing-spec.md` describe the same
lane, the testing spec is authoritative for WHAT runs; this document is
authoritative for WHEN, WHERE, and with WHICH credentials.

## 1. Lane model

Two families, mirroring the spec's blocking/non-blocking split:

| Lane | Workflow | Trigger | Backend | Blocking | Verdict |
|---|---|---|---|---|---|
| PR gate | `pr-gate.yml` | `pull_request`, push to `main` | compose (mode 1) | YES | red blocks merge |
| Nightly matrix | `nightly-matrix.yml` | cron `0 1 * * *`, dispatch | compose (mode 1) | no | red files/updates a triaged issue |
| Juju drift gate (yellow) | `juju-remote.yml` | cron `30 2 * * *`, dispatch | juju attach (mode 3), plan-only | no | red files/updates a triaged issue |
| attach-apply | `juju-remote.yml` | dispatch only, `ALLOW_ATTACH_APPLY` env var | juju attach (mode 3), apply | no | experimental — §8 |

`_triage.yml` is the shared reusable triage step (§6).

### PR gate (`pr-gate.yml`)

- `hermetic`: `make check` — matrix artifacts, offline harness tests,
  typecheck, `satisfies()` unit tests, port audit. No stack.
- `gate` (matrix strategy): one runner per PINNED row of `matrix/matrix.json`
  (the job enumerates them from the generated file, so a model change that
  adds/renames a pinned row changes the gate without touching CI). Each runs
  the full `make gate PROFILE=<row>` contract: typecheck → up → smoke →
  browser suite twice → Go E2E. All of the gate's five hard failure
  conditions (failure, flake, unjustified skip, run-to-run executed-set
  mismatch, collected-set mismatch) apply unchanged.
- `coverage-union`: downloads every profile's `coverage/<row>.json` and runs
  `scripts/coverage-union.mjs` — the same cross-profile aliveness check
  `make gate-all-profiles` performs locally. Splitting profiles across
  runners must not lose it.

GitHub-hosted `ubuntu-24.04` runners. The google-oidc tier-B specs use the
runner image's system Chrome and skip justified while `GOOGLE_TEST_*`
credentials are unprovisioned (the skip allow-list already covers this).

### Nightly matrix (`nightly-matrix.yml`)

`make test-matrix`: every seed + generated row, one run per row, expected-set
verdict per row, `matrix-baseline` volume reset at the top — exactly the
lane `docs/testing-spec.md` defines. Failures do not block anything; they
become issues (§6). A `workflow_dispatch` with `row=<name>` runs one row for
debugging and deliberately never touches the issue tracker.

### Juju drift gate (`juju-remote.yml`)

Runs `make test-matrix-row ROW=<row> BACKEND=juju ATTACH=1 PLAN_ONLY=1`
against an EXISTING charmed deployment through JIMM:

yellow = `yellow-iam` + `yellow-core`, the test-designated color, owned by
`cd-identity-core-infrastructure`
(`environments/juju/prodstack/6/production/yellow-{iam,core}`). Additional
colors slot in by creating a GitHub environment with the same secret/variable
names (§5); no workflow change.

The scheduled mode is ALWAYS plan-only. What it proves nightly:

1. the JIMM service account, model access, and the whole auth chain work;
2. attach discovery sees both models, their apps, offers, and charm
   revisions (recorded in the run summary — §5);
3. terraform can produce the adopt-shaped plan, and its summary IS the drift
   report: how far the live deployment sits from the row's declared
   configuration (default row: `core`).

A plan-only run mutates nothing — `run-row.mjs` returns before any apply and
before URL discovery. Full adopt→transition (`attach-apply`) is dispatch-only
and disabled behind the target environment's `ALLOW_ATTACH_APPLY` variable
until the §8 harness gaps close, because it transitions config that the
operator repos' CD and `cd-identity-core-infrastructure` own.

## 2. JIMM authentication

Pattern source: `identity-team/.github/workflows/charm-deploy.yaml` (used by
`hydra-operator/.github/workflows/deploy.yaml` for the same JIMM-managed models).

Two consumers, one service account:

- **juju CLI** (attach discovery: `juju models/status/offers/config/secrets/
  resources`, and the controller guard's `juju show-controller`):
  `JUJU_CLIENT_ID` + `JUJU_CLIENT_SECRET` env vars — non-interactive
  service-account login, added in [juju/juju#20716] (juju 3.6, merged
  2025-11). Credentials are read from the environment on every command and
  never persisted. The workflow registers the controller once with
  `juju login <jimm-host> -c jimm`.
- **terraform** (`matrix/backends/juju/root/`): provider ATTRIBUTES via
  `TF_VAR_jimm_url` / `TF_VAR_jimm_client_id` / `TF_VAR_jimm_client_secret`
  (`root/providers.tf`). All three default to empty, which renders the
  attributes `null` — the provider then falls back to the juju CLI exactly as
  before, so the local lane is unchanged.

### Controller-guard interplay (load-bearing)

`matrix/controller-guard.mjs` requires `JUJU_CONTROLLER` set, refuses
`JUJU_MODEL` and `JUJU_CONTROLLER_ADDRESSES`, and asserts the RESOLVED
controller equals `MATRIX_ALLOWED_CONTROLLER`. The CI wiring is chosen so the
guard keeps observing the truth:

- `JUJU_CONTROLLER=jimm`, `MATRIX_ALLOWED_CONTROLLER=jimm` — the freshly
  registered controller is the only one on the runner, and
  `juju show-controller` resolves to it.
- `JUJU_CONTROLLER_ADDRESSES` is NEVER set. Terraform reaches JIMM through
  provider attributes instead, which bind it to the same controller the guard
  just verified by name. The refused-env list stays intact.

## 3. Version and charm policy

One principle across both substrates: **the plane tests what is shipped and
RECORDS what it tested** — it never freezes the product to make its own life
deterministic. The juju attach lane already works this way (revisions are
discovered, never chosen); the compose lane matches it.

### Compose lane (PR gate + nightly matrix)

`docker/docker-compose.*.yml` is the version surface.

- **Canonical services track their shipped channel.** `hook-service`,
  `login-ui` and `user-verification-service` float on `:stable` DELIBERATELY:
  the artifact Canonical ships is the `stable` tag, and a plane pinned behind
  it would drift into testing history. A bad publish reddens the next
  nightly (triage names it, with digests in the log) and possibly an
  in-flight PR's gate — an accepted, diagnosable cost of testing reality.
- **Findings stay build-named by RECORDING, not pinning.** Every gate and
  nightly run logs the `RepoDigests` of the images that actually ran (step
  summary + lane log), satisfying the testing-spec §12 evidence rule at run
  time. "Which bytes did this red run test" is always answerable from the
  run itself.
- **Exact-version tags are the suite's baseline, not stable-tracking.**
  kratos/hydra `25.4.0`, `postgres:16`, `openfga:v1.12.0`, `traefik:v2.11`,
  `dexidp/dex:v2.42.0`: the scenarios and the config model are written
  against these workload majors (the model even cites source at those tags).
  Bumping one is a deliberate baseline rebuild via reviewed PR, per the
  runbook invariant (workload version is never a row dimension).
- **Floor pins for named defects stay.** The tenant-service `v0.3.1@sha256:…`
  pin exists because of PD-1 ("never pin below it") — that is a defect floor,
  not a determinism device, and it is the only digest pin in the tree.

### Charmed lane

- **Clean deploys** (local mode 2): revisions are pinned in
  `matrix/backends/juju/root/main.tf` (module refs + `charm_revisions`), and
  `.terraform.lock.hcl` pins the provider — both change only via reviewed
  commits.
- **Attach against the remote deployment (mode 3): versions are DISCOVERED, not chosen.**
  The deployment under test runs whatever `cd-identity-core-infrastructure`
  and the operator repos' CD deployed; attach records the live charm
  revisions (`charm_revisions` in the emitted tfvars) into the run summary.
  This lane answers "does the platform AS DEPLOYED match the declared
  config", so choosing versions here would be self-deception. The version
  *decision* for the deployment belongs to the infra repo, and this repo
  deliberately does not duplicate it.

## 4. Runner network reality

What a GitHub-hosted runner can and cannot reach decides what each lane may
promise:

| Surface | Reachable | Consequence |
|---|---|---|
| JIMM API | yes (proven by the operator repos' deploy workflows) | juju CLI + terraform work |
| Juju model facades via JIMM | yes | attach discovery works |
| deployment public ingress (`iam.yellow.canonical.com` — yellow-core.tfvars `external_hostname`) | assumed reachable; verify on first provisioned run | future urls-backend suite leg (§8) |
| kratos/hydra ADMIN APIs | NO — the core models expose no admin ingress by design | no seeding from CI ⇒ no internal-lane suite against the deployment |
| cluster/pod IPs (`jujuEnv()` discovery addresses) | NO | full juju suite legs cannot run from a hosted runner today |
| mailslurper / dex NodePorts | absent on the charmed deployments entirely (test-only apps) | mail/dex-dependent scenarios can never run against them |

This table is why the scheduled remote lane is a drift gate and not a suite
run — §8 stages the rest honestly instead of shipping a lane that silently
shrinks (the anti-pattern `docs/testing-spec.md` exists to prevent).

## 5. Secrets and variables surface (names only)

Per GitHub **environment** (`yellow`; more colors = more environments),
consumed by `juju-remote.yml`:

| Kind | Name | Meaning |
|---|---|---|
| secret | `JIMM_CLIENT_ID` | service-account OAuth client id |
| secret | `JIMM_CLIENT_SECRET` | service-account OAuth client secret |
| secret | `JIMM_URL` | JIMM controller address, `host:port` |
| variable | `MATRIX_IAM_MODEL` | IAM model name (`yellow-iam`) |
| variable | `MATRIX_CORE_MODEL` | core model name (`yellow-core`) |
| variable | `ALLOW_ATTACH_APPLY` | `true` unlocks attach-apply (keep unset — §8) |

Repository-level:

| Kind | Name | Meaning |
|---|---|---|
| variable | `CI_JUJU_ENVIRONMENT` | GitHub environment the SCHEDULED drift gate targets (`yellow`); resolve fails loudly when unset |
| secret | `OPENROUTER_API_KEY` | enables LLM triage (optional; verbatim log tail without it) |
| variable | `CI_TRIAGE_MODEL` | overrides the triage model (default `google/gemini-3.7-flash`, an OpenRouter slug) |

Optional, for the google-oidc tier-B specs in the PR gate: `GOOGLE_TEST_*`
(absent ⇒ justified skip; that is the skip allow-list working as designed).

Environment protection rules are provisioning-time configuration, not CI
code. Do NOT put a required reviewer on an environment with scheduled runs —
the approval gate pauses cron-triggered jobs too, and the nightly would sit
waiting for a human every night.

## 6. Failure triage flow (`_triage.yml`)

The spec's "non-blocking; failures file issues" contract, made real:

1. Scheduled lane fails → the lane's log artifact is downloaded and tailed
   (100 KiB bound).
2. If `OPENROUTER_API_KEY` is provisioned, one LLM call (OpenRouter
   chat-completions, model per `CI_TRIAGE_MODEL`) produces a bounded
   markdown triage: per-failure verdict, classification (product-defect
   candidate | harness/config defect | infrastructure flake | upstream charm
   wedge), quoted evidence lines, one next diagnostic step. The prompt forbids
   speculation beyond the log. Without the key, the issue carries the verbatim
   log tail instead — triage is an enhancement, never a dependency.
3. One OPEN issue per lane label (`ci-nightly-matrix`, `ci-juju-yellow`,
   …per environment): first failure creates it, repeats comment on it, and the
   next green run comments and closes it. No issue-per-run spam, no silent
   red.
4. Issue bodies state that the triage may be LLM-generated and must be
   verified against the run artifacts. A watchdog wedge classified by the LLM
   is still upstream-bug evidence per D-3 — the triage NAMES it, never
   silences it.
5. Manual dispatches never file or close issues; only scheduled runs do.

## 7. Safety invariants

- **Nothing in CI ever mutates the deployment on a schedule.** Scheduled runs
  are hardwired plan-only in `resolve`; mutation exists only behind dispatch
  plus the environment's `ALLOW_ATTACH_APPLY` variable.
- **State never leaves the runner.** `terraform.tfstate.d/` is secret-bearing
  by construction (cleartext `juju_secret` values). The only artifact the
  remote lane uploads is the runner's stdout log, and `run-row.mjs` already
  filters plan output down to summary lines. A scrub step removes state and
  emitted attach files regardless of outcome.
- **The controller guard runs in CI exactly as locally** — same allowlist
  mechanism, same refused envs, plus an explicit `--check` step before the
  lane runs.
- **Attach invariants carry over unchanged**: store-origin charms only, never
  deploys apps, never manages foreign secrets, refuses rows the deployment
  cannot express (D-2/D-3, `docs/juju-lane-runbook.md`).
- **Determinism rules carry over unchanged**: `retries: 0`, no flake tags, a
  gate flake is a failure (`docs/testing-spec.md`).

## 8. Phase 2 — staged work (deliberately not shipped broken)

1. **Suite legs against the charmed deployment (urls backend, mode 5).** Blocked on:
   (a) a pinned row whose declaration matches the deployed shape
   (google external IdP via `kratos-external-idp-integrator`, no
   mailslurper/dex/tenant-service) — `matrix/verify.mjs` correctly refuses to
   run the suite against a declaration the deployment does not match, and
   the deployment matches no current row; (b) an out-of-band-seeded manifest
   (`MANIFEST=<path>`, `tests/browser/LANES.md`) provisioned as an environment
   secret, since no admin ingress exists. Deliverable: live-lane subset
   against `LOGIN_UI_URL=https://iam.yellow.canonical.com`.
2. **`jujuEnv()` discovery guards.** `matrix/run-row.mjs` hard-parses
   `juju config idp-dex` (and friends) during URL discovery, so any juju-
   backend run past plan-only crashes on a model without the test-only apps —
   even with every URL overridden and `MATRIX_JUJU_BROWSER=0`. Guard the
   discovery reads (missing app ⇒ `undefined`, env override wins), then
   attach-apply stops being crash-after-mutate and `ALLOW_ATTACH_APPLY` can be
   reconsidered.
3. **First-provisioned-run verifications**: `juju login <host> -c jimm`
   against the real JIMM (the syntax is exercised in [juju/juju#20716]'s QA
   steps but not yet against this JIMM), public-ingress reachability from
   hosted runners, and gate wall-clock (adjust `timeout-minutes` from
   evidence, not guesses).

[juju/juju#20716]: https://github.com/juju/juju/pull/20716
