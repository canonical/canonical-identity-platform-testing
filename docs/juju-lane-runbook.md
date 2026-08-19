# Juju Matrix Lane — Runbook

Operational knowledge for the charmed backend (`matrix/backends/juju/`).
Design and contracts live in `docs/testing-spec.md`.

**Controller pinning is enforced, not merely conventional.** Every juju
operation the matrix harness owns (`run-row.mjs`, `verify.mjs`,
`watchdog.mjs`) calls `assertController()` from `matrix/controller-guard.mjs`
before spawning any `juju` or `terraform` process. It:

- refuses an unset `JUJU_CONTROLLER`;
- refuses a set `JUJU_MODEL` (it outranks `JUJU_CONTROLLER` in juju's
  resolution order — `JUJU_MODEL` > `JUJU_CONTROLLER` > `juju switch` state);
- refuses a set `JUJU_CONTROLLER_ADDRESSES` (terraform-provider-juju consumes
  it directly and never falls back to the CLI, so the guard could not observe
  the controller actually reached);
- compares the RESOLVED name from `juju show-controller --format=json` against
  `MATRIX_ALLOWED_CONTROLLER` (default `microk8s-localhost`) and fails closed
  on a malformed or multi-key document.

What remains convention: **bare `terraform` commands run by hand** in
`matrix/backends/juju/root/` are outside the guard. Before any of them, run
`juju show-controller` and confirm it names `microk8s-localhost` (and that
`JUJU_MODEL` is unset) — the provider inherits the controller from exactly
that resolution. Read-only self-test of the guard itself:
`JUJU_CONTROLLER=microk8s-localhost node matrix/controller-guard.mjs --check`.

## Hard constraints

- **Workload version is NOT a row dimension.** DB migrations are one-way:
  after the kratos v25.4→v26.2 float, the schema is v26 and a downgrade would
  strand it. Version bumps are deliberate baseline rebuilds (edit the pins,
  destroy/recreate or migrate forward) — never row transitions. Float
  experiments belong on disposable models, not the shared row root.
- Revision-pinned deploys resolve the **revision-attached** OCI resources;
  unpinned channel deploys float to channel-head resources. Pin both for
  determinism.
- `terraform workspace new` PERSISTENTLY switches the directory's active
  workspace (`.terraform/environment`). The runner switches back to `default`
  immediately and drives attach operations via the `TF_WORKSPACE` env var
  only. Before ANY bare terraform command in
  `matrix/backends/juju/root/`, check `terraform workspace show` says
  `default` — a leaked workspace once destroyed the live deployment.
- `matrix/backends/juju/root/local.auto.tfvars` is the machine's substrate
  identity (ingress hostname, cloud/region) — gitignored, required. Without
  the cloud pin, a clean-mode apply plans model replacement (an imported or
  refreshed model whose config omits its cloud block is REPLACED, cascading
  through every `model_uuid`).
- **`terraform.tfstate` is secret-bearing BY CONSTRUCTION.** The root manages
  `juju_secret` resources, and terraform stores every secret value in state in
  CLEARTEXT — there is no write-only or redacted mode. State (and its
  `.backup`/workspace siblings) must therefore never be shared, pasted into a
  chat, attached to a bug report, or quoted in an upstream issue; excerpt the
  specific non-secret attribute you need instead. `terraform.tfstate*` and
  `attach.tfvars.json` are gitignored in `root/.gitignore` and have never been
  committed — keep it that way.
- `matrix/backends/juju/root/.terraform.lock.hcl` is the opposite case: it is
  TRACKED on purpose, because `providers.tf` floats on `~> 1.0.0` and the lock
  is the only record of the juju provider build a lane ran against. Provider
  upgrades are a reviewed commit (`terraform init -upgrade`, commit the lock),
  never an incidental re-init.

## Version-bump runbook (kratos)

1. Pin `resources = { oci-image = <store rev> }` in the module (store
   revision from
   `api.charmhub.io/v2/charms/info/kratos?channel=…&fields=default-release.resources`).
2. The charm gates on "Waiting for database migration" — run
   `juju run kratos/0 run-migration`. tenant-service/hook-service migrate
   themselves (no action; transient `waiting` states self-heal).
3. `juju attach-resource` takes an IMAGE REFERENCE
   (e.g. `ghcr.io/canonical/kratos:26.2.0`), never a store revision number —
   a bare number is treated as an image name and wedges the pod in
   ImagePullBackOff.
4. A resource-swap pod recreate wipes the charm-pushed config file; any
   config change (`juju config kratos log_level=…`) triggers the re-push.

## Substrate identity (`ingress_hostname`, `node_ip`, root/variables.tf)

WebAuthn forbids IP-based RP IDs and kratos derives `rp.id` from the ingress
host, so webauthn rows need a domain-shaped ingress. Substrate identity, not
a row dimension — set per cluster in `local.auto.tfvars`:

- **Local workstations:** `<LB-IP>.nip.io` — public wildcard DNS maps it back
  to the LB, zero resolver state. Requires a resolver without DNS-rebind
  protection (verify: `getent hosts <your ingress_hostname>`).
- **CI (deterministic, no third party):** any self-contained name
  (e.g. `iam-matrix.internal`) plus one `/etc/hosts` line on the runner —
  hosts entries win for both glibc and Chromium; nothing in-cluster ever
  resolves the name (charms speak in-model DNS; the dex issuer stays
  IP:NodePort). Pin the metallb pool to a single IP so the name is known
  before the first apply. *This mode has not yet been exercised end-to-end —
  dry-run it before a pipeline trusts it.*

Substrate identity lives in exactly one file: `root/local.auto.tfvars`
(gitignored; copy `root/local.auto.tfvars.example`, which documents how to
obtain each value). No tracked file may carry a hostname or IP from this
cluster. Two variables and what they mechanise:

- `ingress_hostname` → traefik-public's `external_hostname` (`main.tf`) and
  the dex staticClient `redirectURIs` (`manifests/dex.yaml.tpl`).
- `node_ip` → the idp-dex/idp-dex2 `issuer_url` (`main.tf`) and the dex
  `issuer` (`manifests/dex.yaml.tpl`). The issuer stays node-IP:NodePort
  because it must resolve identically from the kratos pods and the host
  browser; the ingress name would not.

After changing either value: `make render-manifests` (envsubst only, no
cluster contact) regenerates `manifests/.rendered/` from the `.yaml.tpl`
sources, then `kubectl apply -f matrix/backends/juju/manifests/.rendered/`
and `kubectl -n iam-matrix rollout restart deploy/dex`. Terraform picks the
same values up on the next apply. Hand-editing a manifest is never the
procedure — the rendered directory is gitignored and disposable.

One coupling is not variable-driven and needs no edit: the runner's URL
derivation (`run-row.mjs` reads `external_hostname` from juju config, falling
back to the LB IP for bare-IP substrates).

## Overlay policy (unreleased fixes under test)

**Overlay experiments happen on disposable models only. They are never
standing state, they are never committed, and no lane may depend on one**
(decision D-2). A machine-local artifact that keeps a lane green is a lie about
coverage: it cannot be reproduced by CI or a colleague, and the gap it hides
stops being visible. The harness therefore carries no overlay tolerance at all
— no revision/channel auto-pinning, no tolerated apply errors, no
`--skip-deploy` — and both clean mode and attach mode refuse local-origin
charms. Unreleased fixes are tracked as upstream findings
(`matrix/config-model.mjs`) plus, where they cost coverage, an entry in
`tests/browser/known-coverage-gaps.json` naming the release that unblocks them.

For disposable-model experiments only, the mechanics:

- Pack/refresh a patched charm:
  `juju refresh login-ui --path ~/x.charm --resource oci-image=<registry ref>`.
  Gotchas: the juju snap cannot read `/tmp` (silent "file does not exist");
  the resource must be a REGISTRY reference — a pod's
  `containerStatuses[].image` digest is a containerd image ID and does NOT
  pull. juju status reports `charm-rev: 0` for local charms; the real local
  revision is the charm URL suffix.
- Sideload a rock: `docker save <ref> | microk8s ctr images import -` then
  `juju attach-resource <app> oci-image=<ref>`.
- When the experiment ends, refresh back to a store revision. The row root and
  every lane assume store origin.

## Attach mode caveats (mode 3)

- terraform-provider-juju cannot manage LOCAL charms (`unknown schema for
  charm URL "local:…"` on any update). Attach pre-checks charm origins and
  refuses — refresh the app back to a store revision first.
- App `constraints` are normalized to module defaults on adopt
  (`arch=amd64 → ""` observed). Before pointing attach at a real dev/stg
  cluster, capture-and-pass constraints like cloud/region.
- The provider hard-errors refreshing externally-destroyed resources
  (offers, models) instead of planning recreation; recovery is
  `terraform state rm` of the dead entries, then apply.
- Same-topology assumption: model names via `MATRIX_JUJU_MODEL` /
  `MATRIX_JUJU_CORE_MODEL`, app names as in the root. A single-model dev/stg
  (JIMM `blue-iam`-style) needs a topology audit first.
- The two `relate_uvs` integration import IDs are derived, not yet
  state-verified — the first attach against a uvs-related cluster exercises
  the swapped-order retry if the guess is wrong.

## Charm-fragility journaling (watchdog) — no automatic remediation

kratos-operator can wedge mid-transition (null `verification.ui_url` render →
kratos v26 crash-loop; fragile `pebble-check-failed` hook; no self-recovery
after crash-loop windows — all filed in `upstreamFindings`,
`matrix/config-model.mjs`).

**The harness does not remediate.** `matrix/watchdog.mjs` (auto-spawned by
`run-row.mjs` for juju backends) is an observer: it polls `juju status` every
20s and journals every workload-status change plus a periodic line per unit
stuck in `error`/`waiting-not-connected`. Those lines are the frequency
evidence attached to the upstream report — never silence them. The settle
loops (deploy and attach) still require two consecutive clean polls inside a
20-minute budget, and print the last non-clean status lines on timeout.

No remediation, by decision D-3 (no `juju resolved` nudge, no `log_level`
config-kick): app-agnostic remediation is a retry at the deployment layer,
and it would accelerate a NOVEL charm bug through settle into a green row.
**Accepted consequence: a row hitting the filed kratos-operator wedge fails
its settle budget and stays red until the upstream fixes land.** That is the
honest state for a non-blocking lane.

Manual recovery (human, on a disposable or owned model, never in-run): repeat
`juju resolved -m iam-matrix kratos/0` while in error; if stuck
`waiting`/not-connected with a Running pod, fire any config change (e.g.
`log_level`) to force the re-render, then revert.

## Runner environment (discovered; overridable)

| Variable | Source |
|---|---|
| `KRATOS_*_URL` / `HYDRA_*_URL` | app cluster IPs from `juju status` (host-routable on microk8s) |
| `HOOK_SERVICE_URL` / `USER_VERIFICATION_URL` | app cluster IPs (tier-B specs default to compose's localhost ports otherwise) |
| `LOGIN_UI_URL` | `https://<external_hostname>` when set, else traefik-public's LB address |
| `MAIL_API_URL` / `DEX_URL` | node IP parsed from the dex issuer config, NodePorts 30437/30556 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`, `BROWSER_TEST_INSECURE_TLS=1` | `insecureTlsEnv(true)` — UNCONDITIONAL on this backend: the ingress terminates TLS with a self-signed CA this harness created, so verification could only ever fail against a cert we already know. (The latter is what `playwright.config.ts` reads for `ignoreHTTPSErrors` and chromium's `--ignore-certificate-errors`, which WebAuthn needs to treat a bad-cert origin as a secure context.) The `urls` backend is the opposite: verification ON, opt out per run with `MATRIX_INSECURE_TLS=1`. The compose gate sets neither. |

## Full rebuild

The deployment is terraform-recreatable from scratch (incident-tested,
~10 minutes): ensure `root/local.auto.tfvars` exists (copy the `.example` on a
fresh checkout — an unset `node_ip` fails the plan), `terraform apply` the
root with a row's var-file, then `make render-manifests` and
`kubectl apply -f matrix/backends/juju/manifests/.rendered/` (dex +
mailslurper), re-seed. No overlays to re-apply — store origin only (see
"Overlay policy").
