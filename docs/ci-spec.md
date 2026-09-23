# CI specification

Workflows in `.github/workflows/`; staged work in §8. Implements item 16 of `docs/testing-spec.md`
§10 (the blocking PR gate) and the spec's "non-blocking; failures file issues" matrix contract. The
testing spec is authoritative for WHAT runs; this document for WHEN, WHERE, and with WHICH credentials.

## 1. Lane model

| Lane | Workflow | Trigger | Backend | Blocking | Verdict |
|---|---|---|---|---|---|
| PR gate | `pr-gate.yml` | `pull_request`, push to `main` | compose (mode 1) | YES | red blocks merge |
| Nightly matrix | `nightly-matrix.yml` | cron `0 1 * * *`, dispatch | compose (mode 1) | no | red files/updates a triaged issue |
| Juju drift gate | `juju-remote.yml` | cron `30 2 * * *`, dispatch | juju attach (mode 3), plan-only | no | red files/updates a triaged issue |
| attach-apply | `juju-remote.yml` | dispatch only, `ALLOW_ATTACH_APPLY` env var | juju attach (mode 3), apply | no | experimental — §8 |
| Juju matrix | `juju-matrix.yml` | dispatch only, `ALLOW_ATTACH_APPLY` env var | juju attach-apply per row + suite through the public ingress (live lane, one seed) | no | red rows named in the summary |
| Nightly live | `nightly-live.yml` | cron `0 3 * * *`, dispatch | urls (mode 5): public ingress only, live lane, one seed | no | red files/updates a triaged issue |

`_triage.yml` is the shared reusable triage step (§6). Runners: GitHub-hosted `ubuntu-24.04`.

**PR gate (`pr-gate.yml`)**

- `hermetic`: `make check` — matrix artifacts, offline harness tests, typecheck, port audit. No stack.
- `gate` (matrix strategy): one runner per PINNED row of `matrix/matrix.json` (enumerated from the
  generated file, so a model change that adds/renames a pinned row changes the gate without
  touching CI). Each runs the full `make gate PROFILE=<row>` contract, all five failure conditions.
- `coverage-union`: downloads every profile's `tests/browser/coverage/<row>.json` and runs
  `tests/browser/scripts/coverage-union.mjs` — the same check `make gate-all-profiles` performs
  locally. Splitting profiles across runners must not lose it.

**Juju matrix (`juju-matrix.yml`)** — multi-configuration testing of an OWNED charmed deployment
through JIMM. Per row: attach-apply transitions the deployment, the preflight verifies it (juju
layer via JIMM, behaviour + self-report via the public ingress), the browser suite runs in the live
lane with `MATRIX_JUJU_PUBLIC=1` — no cluster IPs, no admin API, nothing seeded. One manifest
(`SEED_MANIFEST`, seeded out of band on the maximal shape: local idp + MFA + verification) serves
every row because every scenario that mutates a seeded identity restores it through the public
settings flow (`tests/browser/framework/restore.ts`). Rows must carry a `juju.tfvars.json` and
need no app the deployment lacks; `restore_row` (default `canonical-internal`, the shape the
nightly drift gate plans against) transitions the deployment back afterwards.
Proven 2026-09-19 on microk8s: three transitions, one seed, identity credential shapes identical
before and after.
- The google-oidc tier-B specs use the runner image's system Chrome and skip justified while
  `GOOGLE_TEST_*` credentials are unprovisioned.

**Nightly live (`nightly-live.yml`)** — tests only, against a public deployment: no terraform, no
JIMM, no admin API. The environment named by `CI_LIVE_ENVIRONMENT` supplies `LOGIN_UI_URL`, the
row that declares the deployment (`MATRIX_ROW`, e.g. `deployed-core-local-mfa` for orange) and
the out-of-band `SEED_MANIFEST`; `make test-matrix-row ROW=$MATRIX_ROW BACKEND=urls` runs the
preflight and the live-lane subset. Scenarios restore what they mutate, so one seed serves every
night. The Google journeys run when `GOOGLE_TEST_*` are set and the manifest carries `google-user`
(seed it once: `scripts/seed-in-cluster.sh --env <colour> --incremental` with the Google
variables exported). The deployments serve the leaf certificate only; a step supplies the Let's
Encrypt YR1 chain to node and the consumer and fails loudly if the issuer changes. Only the lane
log is uploaded — traces carry credentials typed into real forms.

**Nightly matrix (`nightly-matrix.yml`)**

- `make test-matrix`: every seed + generated row, expected-set verdict per row, `matrix-baseline`
  volume reset at the top. Failures become issues (§6).
- `workflow_dispatch` with `row=<name>` runs one row for debugging and never touches the issue tracker.

**Juju drift gate (`juju-remote.yml`)**

- Runs `make test-matrix-row ROW=<row> BACKEND=juju ATTACH=1 PLAN_ONLY=1` against an EXISTING
  charmed deployment through JIMM. The target is a GitHub **environment** (§5) naming the two juju
  models (`MATRIX_IAM_MODEL`, `MATRIX_CORE_MODEL`) and holding the JIMM service account; the
  scheduled gate targets the one named by `CI_JUJU_ENVIRONMENT`. More deployments = more
  environments with the same names. No target is provisioned yet (§8).
- Scheduled mode is ALWAYS plan-only and mutates nothing (`run-row.mjs` returns before any apply
  and before URL discovery). It proves nightly that the JIMM auth chain works, that attach discovery
  sees both models (apps, offers, charm revisions — recorded in the run summary), and that terraform
  produces the adopt-shaped plan. The runner classifies it: the baseline the provider always reports
  on an adopted deployment (`constraints` normalized on adopt, a config key the provider cannot read
  back declared at the value the deployment already runs) and write-only secrets (unverifiable) are listed but never fail; create/delete, a
  declared value differing from the deployed one, or a pending relation transition is real drift
  and fails the gate. Default row: `canonical-internal` — the only pinned row with a
  `juju.tfvars.json` (`core` and `canonical-portal` carry an off-model dimension).
- Full adopt→transition (`attach-apply`) is dispatch-only behind the environment's
  `ALLOW_ATTACH_APPLY` variable until the §8 gaps close: it transitions config owned by the
  operator repos' CD and `cd-identity-core-infrastructure`.

## 2. JIMM authentication

Pattern source: `identity-team/.github/workflows/charm-deploy.yaml`. Two consumers, one service account:

- **juju CLI** (attach discovery and the controller guard's `juju show-controller`):
  `JUJU_CLIENT_ID` + `JUJU_CLIENT_SECRET` — non-interactive service-account login
  ([juju/juju#20716], juju 3.6). Read from the environment on every command, never persisted. The
  workflow registers the controller once with `juju login <jimm-host> -c jimm`.
- **terraform** (`matrix/backends/juju/root/providers.tf`): provider attributes via
  `TF_VAR_jimm_url` / `TF_VAR_jimm_client_id` / `TF_VAR_jimm_client_secret`. All three default to
  empty, which renders the attributes `null`, so the provider falls back to the juju CLI and the
  local lane is unchanged.

**Controller-guard interplay (load-bearing).** `matrix/controller-guard.mjs` requires
`JUJU_CONTROLLER` set, refuses `JUJU_MODEL` and `JUJU_CONTROLLER_ADDRESSES`, and asserts the
RESOLVED controller equals `MATRIX_ALLOWED_CONTROLLER`. CI sets `JUJU_CONTROLLER=jimm` and
`MATRIX_ALLOWED_CONTROLLER=jimm` (the freshly registered controller is the only one on the runner)
and NEVER sets `JUJU_CONTROLLER_ADDRESSES`: terraform reaches JIMM through provider attributes,
bound to the same controller the guard verified by name.

## 3. Version and charm policy

The plane tests what is shipped and RECORDS what it tested; it never freezes the product for its own determinism.

- Canonical services (`hook-service`, `login-ui`, `user-verification-service`) float on `:stable`
  in `docker/docker-compose.*.yml`: a bad publish reddens the next nightly (and possibly an
  in-flight PR's gate) — an accepted, diagnosable cost of testing reality.
- Every gate and nightly run logs the `RepoDigests` of the images that actually ran (step summary +
  lane log), satisfying the testing-spec §11 evidence rule at run time.
- Exact-version tags are the suite's baseline: kratos/hydra `25.4.0`, `postgres:16`,
  `openfga:v1.12.0`, `traefik:v2.11`, `dexidp/dex:v2.42.0`. Bumping one is a reviewed baseline
  rebuild (workload version is never a row dimension — runbook).
- Floor pins for named defects stay: tenant-service `v0.3.1@sha256:…` exists because of PD-1 and is
  the only digest pin in the tree.
- Charmed clean deploys (mode 2): revisions pinned in `matrix/backends/juju/root/main.tf`, provider
  pinned by `.terraform.lock.hcl`; both change only via reviewed commits.
- Charmed attach (mode 3): versions are DISCOVERED, not chosen — attach records the live
  `charm_revisions` into the run summary. The version decision belongs to the infra repo.

## 4. Runner network reality

| Surface | Reachable | Consequence |
|---|---|---|
| JIMM API | yes (proven by the operator repos' deploy workflows) | juju CLI + terraform work |
| Juju model facades via JIMM | yes | attach discovery works |
| deployment public ingress (the core model's `external_hostname`) | assumed reachable; verify on first provisioned run | the juju matrix lane's whole test interface |
| kratos/hydra ADMIN APIs | NO — the core models expose no admin ingress by design | no seeding from CI ⇒ live lane with an out-of-band `SEED_MANIFEST` |
| cluster/pod IPs (`discoverJujuUrls()` discovery addresses) | NO | `MATRIX_JUJU_PUBLIC=1` skips discovery |
| mailslurper / dex NodePorts | absent on the charmed deployments entirely (test-only apps) | mail/dex-dependent scenarios gate off (`mail_api=false`, no dex provider) |

This is why the scheduled remote lane is a drift gate and not a suite run; §8 stages the rest.

## 5. Secrets and variables surface (names only)

Per GitHub **environment** (one per target deployment), consumed by `juju-remote.yml`:

| Kind | Name | Meaning |
|---|---|---|
| secret | `JIMM_CLIENT_ID` | service-account OAuth client id |
| secret | `JIMM_CLIENT_SECRET` | service-account OAuth client secret |
| secret | `JIMM_URL` | JIMM controller address, `host:port` |
| variable | `MATRIX_IAM_MODEL` | IAM model name |
| variable | `MATRIX_CORE_MODEL` | core model name |
| variable | `ALLOW_ATTACH_APPLY` | `true` unlocks attach-apply and the juju matrix lane (only on an environment you own) |
| variable | `LOGIN_UI_URL` | the deployment's public ingress (juju matrix, nightly live) |
| variable | `KRATOS_IDENTITY_SCHEMA_ID` | schema the seed used (juju matrix, nightly live; `tests/browser/LANES.md`) |
| secret | `SEED_MANIFEST` | the out-of-band seed manifest, verbatim JSON (passwords + TOTP secrets; juju matrix, nightly live) |
| variable | `MATRIX_ROW` | row declaring the deployment's shape (nightly live) |
| secret | `GOOGLE_TEST_EMAIL`, `GOOGLE_TEST_PASSWORD`, `GOOGLE_TEST_TOTP_SECRET`, `GOOGLE_TEST_SUBJECT_ID` | the Google test account (nightly live; optional — absent ⇒ the Google journeys skip) |

Repository-level:

| Kind | Name | Meaning |
|---|---|---|
| variable | `CI_JUJU_ENVIRONMENT` | GitHub environment the SCHEDULED drift gate targets; resolve fails loudly when unset |
| variable | `CI_LIVE_ENVIRONMENT` | GitHub environment the SCHEDULED nightly live lane targets (e.g. `orange`); resolve fails loudly when unset |
| secret | `OPENROUTER_API_KEY` | enables LLM triage (optional; verbatim log tail without it) |
| variable | `CI_TRIAGE_MODEL` | overrides the triage model (default `google/gemini-3.7-flash`, an OpenRouter slug) |

Optional, for the google-oidc tier-B specs in the PR gate: `GOOGLE_TEST_*` (absent ⇒ justified skip).
Do NOT put a required reviewer on an environment with scheduled runs — it pauses cron-triggered jobs too.

## 6. Failure triage flow (`_triage.yml`)

- Scheduled lane fails → the lane's log artifact is downloaded and tailed (100 KiB bound).
- With `OPENROUTER_API_KEY`, one LLM call (model per `CI_TRIAGE_MODEL`) produces a bounded markdown
  triage: per-failure verdict, classification (product-defect candidate | harness/config defect |
  infrastructure flake | upstream charm wedge), quoted evidence, one next diagnostic step; the
  prompt forbids speculation beyond the log. Without the key the issue carries the verbatim tail.
- One OPEN issue per lane label (`ci-nightly-matrix`, `ci-juju-<environment>`): first failure
  creates it, repeats comment on it, the next green run comments and closes it.
- Issue bodies state the triage may be LLM-generated and must be verified against the run
  artifacts. A watchdog wedge is still upstream-bug evidence per D-3 — the triage NAMES it, never
  silences it.
- Manual dispatches never file or close issues; only scheduled runs do.

## 7. Safety invariants

- **Nothing in CI ever mutates the deployment on a schedule.** Scheduled runs are hardwired
  plan-only in `resolve`; mutation exists only behind dispatch plus `ALLOW_ATTACH_APPLY`.
- **State never leaves the runner.** `terraform.tfstate.d/` is secret-bearing by construction
  (cleartext `juju_secret` values). The only uploaded artifact is the runner's stdout log (already
  filtered to summary lines by `run-row.mjs`); a scrub step removes state and attach files regardless of outcome.
- **The controller guard runs in CI exactly as locally** — same allowlist, same refused envs, plus
  an explicit `--check` step before the lane runs.
- **Attach invariants carry over unchanged**: store-origin charms only, never deploys apps, never
  manages foreign secrets, refuses rows the deployment cannot express (D-2/D-3, runbook).
- **Determinism rules carry over unchanged**: `retries: 0`, no flake tags, a gate flake is a failure.

## 8. Staged work (deliberately not shipped broken)

- **Nightly live lane red on the target, not on the harness (2026-09-19).** Against orange (and
  teal) 5 of 15 pass; the other 10 fail at the email step (`500 POST /self-service/login ->
  invalid password`): both run a login-ui build that posts the identifier step as a password
  login (the `upstreamFindings` version-class entry). Orange's app-config also dropped
  `multi_tenancy_enabled`, which it reported after its 2026-08-26 upgrade — its login-ui went
  back. Clears when the deployment's login-ui is upgraded.
- **`discoverJujuUrls()` discovery guards.** `matrix/juju-backend.mjs` hard-parses
  `juju config idp-dex` (and friends), so any juju-backend run past plan-only crashes on a model
  without the test-only apps even with every URL overridden. Guard the reads (missing app ⇒
  `undefined`, env override wins); then attach-apply stops being crash-after-mutate and
  `ALLOW_ATTACH_APPLY` can be reconsidered.
- **First-provisioned-run verifications**: `juju login <host> -c jimm` against the real JIMM,
  public-ingress reachability from hosted runners, and gate wall-clock (set `timeout-minutes` from evidence).

[juju/juju#20716]: https://github.com/juju/juju/pull/20716
