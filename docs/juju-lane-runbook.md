# Juju Matrix Lane — Runbook

Operational knowledge for the charmed backend (`matrix/backends/juju/`); design in `docs/testing-spec.md` §9.

## Decisions

- **D-1 Controller pinning is enforced.** Every juju operation the harness owns (`run-row.mjs`,
  `verify.mjs`, `watchdog.mjs`) calls `assertController()` before spawning `juju` or `terraform`.
- **D-2 No overlays.** Unreleased fixes run on disposable models only; never standing state, never
  committed, no lane depends on one. The harness carries no overlay tolerance (no auto-pinning, no
  tolerated apply errors, no `--skip-deploy`) and both clean and attach mode refuse local-origin
  charms. Unreleased fixes are tracked in `upstreamFindings` (`matrix/config-model.mjs`) plus, where
  they cost coverage, `tests/browser/known-coverage-gaps.json`.
- **D-3 No automatic remediation.** No `juju resolved` nudge, no config-kick: app-agnostic
  remediation is a retry at the deployment layer and would push a novel charm bug through settle
  into a green row. A row hitting the filed kratos-operator wedge fails its settle budget and stays
  red until the upstream fixes land.

## Controller guard

`assertController()` refuses an unset `JUJU_CONTROLLER`; refuses a set `JUJU_MODEL` (it outranks
`JUJU_CONTROLLER` in juju's resolution order); refuses a set `JUJU_CONTROLLER_ADDRESSES`
(terraform-provider-juju consumes it directly, so the guard could not observe the controller
reached); and compares the RESOLVED name from `juju show-controller --format=json` against
`MATRIX_ALLOWED_CONTROLLER` (default `microk8s-localhost`), failing closed on a malformed document.

Bare `terraform` commands run by hand in `matrix/backends/juju/root/` are outside the guard: run
`juju show-controller` first and confirm it names `microk8s-localhost` with `JUJU_MODEL` unset.
Self-test: `JUJU_CONTROLLER=microk8s-localhost node matrix/controller-guard.mjs --check`.

## Hard constraints

- **Workload version is NOT a row dimension.** DB migrations are one-way; a downgrade strands the
  schema. Version bumps are deliberate baseline rebuilds (edit the pins, destroy/recreate or migrate
  forward), never row transitions. Float experiments belong on disposable models.
- Revision-pinned deploys resolve the **revision-attached** OCI resources; unpinned channel deploys
  float to channel-head resources. Pin both.
- `terraform workspace new` PERSISTENTLY switches the directory's active workspace. The runner
  switches back to `default` immediately and drives attach via `TF_WORKSPACE` only. Before ANY bare
  terraform command in `matrix/backends/juju/root/`, check `terraform workspace show` says `default`.
- `matrix/backends/juju/root/local.auto.tfvars` is the machine's substrate identity (ingress
  hostname, cloud/region) — gitignored, required. Without the cloud pin, a clean-mode apply plans
  model REPLACEMENT, cascading through every `model_uuid`.
- **`terraform.tfstate` is secret-bearing BY CONSTRUCTION.** The root manages `juju_secret`
  resources and terraform stores every value in state in CLEARTEXT. State (and its `.backup` /
  workspace siblings) must never be shared, pasted, attached to a bug report, or quoted upstream —
  excerpt the specific non-secret attribute instead. `terraform.tfstate*` and `attach.tfvars.json`
  are gitignored and have never been committed.
- `matrix/backends/juju/root/.terraform.lock.hcl` is TRACKED on purpose: `providers.tf` floats on
  `~> 1.0.0` and the lock is the only record of the provider build a lane ran against. Upgrade via a
  reviewed commit (`terraform init -upgrade`, commit the lock), never an incidental re-init.

## Version-bump runbook (kratos)

1. Pin `resources = { oci-image = <store rev> }` in the module (store revision from
   `api.charmhub.io/v2/charms/info/kratos?channel=…&fields=default-release.resources`).
2. The charm gates on "Waiting for database migration" — run `juju run kratos/0 run-migration`.
   tenant-service/hook-service migrate themselves (transient `waiting` states self-heal).
3. `juju attach-resource` takes an IMAGE REFERENCE (e.g. `ghcr.io/canonical/kratos:26.2.0`), never a
   store revision number — a bare number wedges the pod in ImagePullBackOff.
4. A resource-swap pod recreate wipes the charm-pushed config file; any config change
   (`juju config kratos log_level=…`) triggers the re-push.

## Substrate identity (`ingress_hostname`, `node_ip`)

WebAuthn forbids IP-based RP IDs and kratos derives `rp.id` from the ingress host, so webauthn rows
need a domain-shaped ingress. Set per cluster in `matrix/backends/juju/root/local.auto.tfvars`
(gitignored; copy `local.auto.tfvars.example`, which documents each value). No tracked file may
carry a hostname or IP from this cluster.

- **Local workstations:** `<LB-IP>.nip.io` — public wildcard DNS, zero resolver state. Needs a
  resolver without DNS-rebind protection (verify: `getent hosts <ingress_hostname>`).
- **CI (deterministic):** any self-contained name (e.g. `iam-matrix.internal`) plus one `/etc/hosts`
  line on the runner — hosts entries win for glibc and Chromium; nothing in-cluster resolves the
  name. Pin the metallb pool to a single IP so the name is known before the first apply. *Not yet
  exercised end-to-end — dry-run it before a pipeline trusts it* (spec §10 item 6).
- `ingress_hostname` → traefik-public's `external_hostname` (`root/main.tf`) and the dex
  staticClient `redirectURIs` (`manifests/dex.yaml.tpl`). `node_ip` → the idp-dex/idp-dex2
  `issuer_url` and the dex `issuer`; the issuer stays node-IP:NodePort because it must resolve
  identically from the kratos pods and the host browser.

After changing either value or a `.yaml.tpl`: `make render-manifests` (envsubst only) regenerates
`matrix/backends/juju/manifests/.rendered/`, then `kubectl apply -f matrix/backends/juju/manifests/.rendered/`
and `kubectl -n iam-matrix rollout restart deploy/dex`. Never hand-edit a rendered manifest. The
runner's URL derivation (`discoverJujuUrls()` in `matrix/juju-backend.mjs`) reads `external_hostname`
from juju config, falling back to the LB IP.

## Disposable-model experiments (D-2 mechanics)

- Pack/refresh a patched charm: `juju refresh login-ui --path ~/x.charm --resource oci-image=<registry ref>`.
  The juju snap cannot read `/tmp` (silent "file does not exist"); the resource must be a REGISTRY
  reference — a pod's `containerStatuses[].image` digest does NOT pull. juju status reports
  `charm-rev: 0` for local charms; the real revision is the charm URL suffix.
- Sideload a rock: `docker save <ref> | microk8s ctr images import -` then
  `juju attach-resource <app> oci-image=<ref>`.
- When the experiment ends, refresh back to a store revision; the row root and every lane assume store origin.

## Attach mode caveats (mode 3)

- terraform-provider-juju cannot manage LOCAL charms; attach pre-checks origins and refuses —
  refresh back to a store revision first.
- Plan-only (`PLAN_ONLY=1`) is a classified drift gate: the provider always reports a baseline on
  an adopted deployment (`constraints` normalized to "" — `arch=amd64` observed — config/storage
  keys the provider cannot read back declared at the value the deployment already runs, computed
  attributes) and write-only secrets it cannot compare; both are listed, never red. Create/delete, a
  deployed value differing from the row — including a charm default the row overrides (the runner
  reads effective values with `juju config`) — or a pending relation transition is real drift and
  fails the gate. Before pointing attach at a real dev/stg
  cluster, capture-and-pass constraints like cloud/region.
- The provider hard-errors refreshing externally-destroyed resources (offers, models); recovery is
  `terraform state rm` of the dead entries, then apply.
- Same-topology assumption: model names via `MATRIX_JUJU_MODEL` / `MATRIX_JUJU_CORE_MODEL`, app
  names as in the root. A single-model dev/stg (JIMM `blue-iam`-style) needs a topology audit first.
- The two `relate_uvs` integration import IDs are derived, not state-verified — the first attach
  against a uvs-related cluster exercises the swapped-order retry.

## Watchdog (observer only)

`matrix/watchdog.mjs` (auto-spawned by `run-row.mjs` for juju backends) polls `juju status` every
20 s and journals every workload-status change plus a periodic line per unit stuck in
`error`/`waiting-not-connected` — the frequency evidence for the upstream report; never silence it.
Settle loops require two consecutive clean polls inside a 20-minute budget and print the last
non-clean status lines on timeout. Known wedge class (`upstreamFindings`): null
`verification.ui_url` render → kratos crash-loop; fragile `pebble-check-failed` hook; no self-recovery.

Manual recovery (human, on a disposable or owned model, never in-run): repeat
`juju resolved -m iam-matrix kratos/0` while in error; if stuck `waiting`/not-connected with a
Running pod, fire any config change (e.g. `log_level`) to force the re-render, then revert.

## Runner environment (discovered; overridable)

| Variable | Source |
|---|---|
| `KRATOS_*_URL` / `HYDRA_*_URL` | app cluster IPs from `juju status` (host-routable on microk8s) |
| `HOOK_SERVICE_URL` / `USER_VERIFICATION_URL` | app cluster IPs (tier-B specs default to compose's localhost ports otherwise) |
| `LOGIN_UI_URL` | `https://<external_hostname>` when set, else traefik-public's LB address |
| `MAIL_API_URL` / `DEX_URL` | node IP parsed from the dex issuer config, NodePorts 30437/30556 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`, `BROWSER_TEST_INSECURE_TLS=1` | `insecureTlsEnv(true)`, UNCONDITIONAL here: the ingress terminates TLS with a self-signed CA this harness created. The `urls` backend is the opposite (verification on, `MATRIX_INSECURE_TLS=1` opts out); the compose gate sets neither |

## Full rebuild and seeding

Terraform-recreatable from scratch (~10 minutes): ensure `local.auto.tfvars` exists (an unset
`node_ip` fails the plan), then `make test-matrix-row ROW=<row> BACKEND=juju` (or `terraform apply`
the root with the row's var-file). The runner applies with `-parallelism=1` — creating ~25
cross-model relations at once restarts juju's remote-relations worker and freshly created relations
die or arrive without data (juju 3.6.28) — resumes once on the provider's offer-before-ready
transient, and fails the row if a post-apply plan shows anything juju dropped. The first run on a
new cluster stops at the preflight until the k8s manifests exist: `make render-manifests` and
`kubectl apply -f matrix/backends/juju/manifests/.rendered/` (dex + mailslurper), then run the row
again. No overlays to re-apply — store origin only (D-2). Teardown: `juju show-controller` (guard),
then `terraform destroy` in `root/` with the same var-file; if a charm's `relation-broken` hook
errors mid-teardown the provider times out — `juju destroy-model <model> --force --no-wait
--destroy-storage` for both models and delete `terraform.tfstate*`. Seeding a deployment whose
admin APIs are reachable only on the pod network: `scripts/seed-in-cluster.sh --help`.
