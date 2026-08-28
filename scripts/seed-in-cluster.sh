#!/usr/bin/env bash
# Copyright 2026 Canonical Ltd.
# SPDX-License-Identifier: AGPL-3.0
#
# Bootstrap a SEEDING HOST inside a charmed k8s deployment, then hand off to
# scripts/seed-remote.sh (which owns the prerequisite probes and the seeder
# invocation — this script owns only the transport and the toolchain).
#
# It exists because the admin APIs of a charmed deployment are not published:
# kratos's 4434 and hydra's 4445 are reachable only from inside the cluster, so
# the seeding half of the `urls` backend (docs/testing-spec.md §9) has to run
# from a node or a pod. Two modes, same contract:
#
#   --mode node  (default)  run here, on a cluster node: install node+npm, fetch
#                           the repo, `kubectl port-forward` to the kratos and
#                           hydra pods, seed over 127.0.0.1. Touches the node.
#   --mode pod              run in a throwaway pod in the deployment's namespace
#                           (node:22 image), talking to the POD IPs directly.
#                           Touches nothing on the node but the pod; needs the
#                           node to be able to pull node:22.
#
# Pod IPs, not the `kratos` ClusterIP service: juju's generated service exposes
# only the ports the charm declares, and the admin port is not among them on
# every revision. A pod IP always carries every port its container listens on.
#
# Usage (on a node of the deployment's k8s cluster, with kubectl access):
#
#   scripts/seed-in-cluster.sh --env teal [--check | --purge | --incremental]
#
#   --env <name>       deployment colour; namespace defaults to <name>-iam and
#                      the ingress host to iam.<name>.canonical.com   (teal)
#   --namespace <ns>   override the namespace
#   --row <row>        matrix row whose capabilities.json declares the target
#                      (deployed-core-local-mfa — the charmed-core shape)
#   --mode node|pod    where the seeder runs (node)
#   --ref <git-ref>    ref to fetch when cloning (feat/orange-urls-lane)
#   --bundle <tgz>     offline: a tarball of this repo (`tar czf b.tgz
#                      --exclude=.git -C <repo> .`) instead of a git clone. Ship
#                      tests/browser/node_modules in it and npm never has to
#                      reach a registry.
#   --out <path>       where to write the manifest on THIS host
#                      (./manifest.<env>.json, mode 0600)
#   --check            prerequisite probes only, zero mutation
#   --fresh|--incremental|--purge   seeder mode (--fresh)
#
# The manifest it produces is credential material: seeded passwords and TOTP
# secrets. It lands 0600, and on a production node you should move it off and
# `shred -u` the copy.

set -euo pipefail

ENVIRONMENT="teal"
NAMESPACE=""
ROW="deployed-core-local-mfa"
MODE="node"
REF="feat/orange-urls-lane"
REPO_URL="https://github.com/canonical/canonical-identity-platform-testing.git"
BUNDLE=""
OUT=""
SEED_ARGS=()
POD_NAME="iam-seeder"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENVIRONMENT="${2:?--env needs a value}"; shift ;;
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift ;;
    --row) ROW="${2:?--row needs a value}"; shift ;;
    --mode) MODE="${2:?--mode needs a value}"; shift ;;
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    --repo) REPO_URL="${2:?--repo needs a value}"; shift ;;
    --bundle) BUNDLE="${2:?--bundle needs a value}"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift ;;
    --check | --fresh | --incremental | --purge) SEED_ARGS+=("$1") ;;
    -h | --help) sed -n '5,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

NAMESPACE="${NAMESPACE:-${ENVIRONMENT}-iam}"
OUT="${OUT:-$PWD/manifest.${ENVIRONMENT}.json}"
INGRESS_HOST="iam.${ENVIRONMENT}.canonical.com"
[[ "$MODE" == "node" || "$MODE" == "pod" ]] || { echo "--mode must be node or pod" >&2; exit 2; }
[[ ${#SEED_ARGS[@]} -gt 0 ]] || SEED_ARGS=("--fresh")

# Cleanup state is global on purpose: the EXIT trap runs after the mode
# function has returned, so anything it must undo cannot be a local.
WORKDIR=""
PF_PIDS=()

fail() { echo "✗ $*" >&2; exit 1; }

echo "── plan"
echo "  ${MODE} mode, row $ROW, seeder ${SEED_ARGS[*]}, namespace $NAMESPACE"

# ── kubectl ────────────────────────────────────────────────────────────────
# Canonical k8s ships the client as a snap subcommand, and on a control node
# only root has the cluster config. Probe the forms rather than assume one.
KUBECTL=()
for candidate in "kubectl" "k8s kubectl" "sudo k8s kubectl" "sudo microk8s kubectl"; do
  read -r -a words <<<"$candidate"
  command -v "${words[0]}" >/dev/null 2>&1 || continue
  if "${words[@]}" get namespace >/dev/null 2>&1; then KUBECTL=("${words[@]}"); break; fi
done
[[ ${#KUBECTL[@]} -gt 0 ]] || fail "no working kubectl on this host (tried kubectl, k8s kubectl, sudo k8s kubectl, sudo microk8s kubectl)"
kube() { "${KUBECTL[@]}" "$@"; }
echo "── cluster"
echo "  ✓ kubectl        ${KUBECTL[*]}"

kube get namespace "$NAMESPACE" >/dev/null 2>&1 \
  || fail "namespace $NAMESPACE does not exist. Juju names the namespace after the model;
    list them with: ${KUBECTL[*]} get ns"
echo "  ✓ namespace      $NAMESPACE"

# ── pods ───────────────────────────────────────────────────────────────────
# Label first (juju labels every application pod), unit-0 name as the fallback.
resolve_pod() {
  local app="$1" name
  name="$(kube -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=$app" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "$name" ]] || name="${app}-0"
  kube -n "$NAMESPACE" get pod "$name" >/dev/null 2>&1 || fail "no $app pod in $NAMESPACE (looked for label app.kubernetes.io/name=$app and pod $name)"
  printf '%s' "$name"
}
KRATOS_POD="$(resolve_pod kratos)"
HYDRA_POD="$(resolve_pod hydra)"
echo "  ✓ kratos pod     $KRATOS_POD"
echo "  ✓ hydra pod      $HYDRA_POD"

# ── in-pod / on-node bootstrap, shared body ────────────────────────────────
# One text, two hosts: it is the same sequence either way, and duplicating it
# is how the two modes drift apart.
bootstrap_body() {
  cat <<'BOOTSTRAP'
set -euo pipefail
: "${WORK:?}" "${SEED_ARGS:?}" "${ROW:?}"
mkdir -p "$WORK/repo"
if [[ -n "${BUNDLE_PATH:-}" ]]; then
  tar -xzf "$BUNDLE_PATH" -C "$WORK/repo"
  # A complete vendored tree must not be "topped up" from a registry the host
  # cannot reach; an incomplete one must fail loudly rather than hang.
  if [[ -d "$WORK/repo/tests/browser/node_modules" ]]; then export npm_config_offline=true; fi
else
  if [[ ! -d "$WORK/repo/.git" ]]; then
    git clone --depth 1 --branch "$GIT_REF" "$GIT_REPO" "$WORK/repo"
  fi
fi
export npm_config_audit=false npm_config_fund=false

# The identity schema a charmed deployment serves is NOT `default`, and an
# unknown schema id is a 400 per identity. Ask the deployment. Resolved here,
# not on the calling host: this is the first point at which node's fetch (and
# a route to kratos) both exist, so there is one implementation for both modes.
if [[ -z "${KRATOS_IDENTITY_SCHEMA_ID:-}" ]]; then
  KRATOS_IDENTITY_SCHEMA_ID="$(node -e '
    fetch(process.argv[1] + "/schemas", { signal: AbortSignal.timeout(10000) })
      .then((r) => r.json())
      .then((body) => {
        const ids = body.map((s) => s.id);
        // `default` when served; otherwise the one human-user schema. Admin
        // schemas are excluded by name, and ambiguity is refused rather than
        // guessed — seeding under the wrong schema is silent until login.
        const pick = ids.includes("default") ? "default" : ids.filter((i) => !/admin/.test(i));
        if (typeof pick === "string") return console.log(pick);
        if (pick.length === 1) return console.log(pick[0]);
        console.error(`cannot choose an identity schema among [${ids}] — set KRATOS_IDENTITY_SCHEMA_ID`);
        process.exit(1);
      })
      .catch((e) => { console.error(`GET /schemas failed: ${e.cause?.message ?? e.message}`); process.exit(1); });
  ' "$KRATOS_PUBLIC_URL")"
  export KRATOS_IDENTITY_SCHEMA_ID
fi

exec "$WORK/repo/scripts/seed-remote.sh" $SEED_ARGS --row "$ROW"
BOOTSTRAP
}

# ── mode: node ─────────────────────────────────────────────────────────────
run_on_node() {
  local sudo=""; [[ "$(id -u)" == 0 ]] || sudo="sudo"

  echo "── toolchain"
  if ! command -v git >/dev/null 2>&1; then
    $sudo apt-get install -y -q git || fail "git is absent and apt-get install git failed"
  fi
  echo "  ✓ git            $(git --version)"

  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [[ "$major" -lt 20 ]] || ! command -v npm >/dev/null 2>&1; then
    # snap first: it is the only channel on these nodes that carries a current
    # node, and snapd already has the egress proxy configured.
    $sudo snap install node --classic --channel=22 \
      || $sudo apt-get install -y -q nodejs npm \
      || fail "could not install node >= 20 (tried: snap install node --classic --channel=22, apt-get install nodejs npm)"
    hash -r
  fi
  echo "  ✓ node           $(node -v) / npm $(npm -v)"

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/iam-seed.XXXXXX")"
  chmod 700 "$WORKDIR"

  echo "── port-forward"
  cleanup() {
    [[ ${#PF_PIDS[@]} -gt 0 ]] && kill "${PF_PIDS[@]}" 2>/dev/null
    rm -rf "$WORKDIR"
  }
  trap cleanup EXIT

  kube -n "$NAMESPACE" port-forward "pod/$KRATOS_POD" 4433:4433 4434:4434 >"$WORKDIR/pf-kratos.log" 2>&1 &
  PF_PIDS+=($!)
  kube -n "$NAMESPACE" port-forward "pod/$HYDRA_POD" 4445:4445 >"$WORKDIR/pf-hydra.log" 2>&1 &
  PF_PIDS+=($!)

  local port waited
  for port in 4433 4434 4445; do
    waited=0
    until timeout 1 bash -c ":>/dev/tcp/127.0.0.1/$port" 2>/dev/null; do
      waited=$((waited + 1))
      [[ $waited -gt 30 ]] && { cat "$WORKDIR"/pf-*.log >&2; fail "port-forward to 127.0.0.1:$port never came up"; }
      sleep 1
    done
    echo "  ✓ 127.0.0.1:$port"
  done

  local manifest="$WORKDIR/manifest.json"
  WORK="$WORKDIR" SEED_ARGS="${SEED_ARGS[*]}" ROW="$ROW" \
  GIT_REPO="$REPO_URL" GIT_REF="$REF" BUNDLE_PATH="$BUNDLE" \
  KRATOS_ADMIN_URL="http://127.0.0.1:4434" \
  KRATOS_PUBLIC_URL="http://127.0.0.1:4433" \
  HYDRA_ADMIN_URL="http://127.0.0.1:4445" \
  KRATOS_IDENTITY_SCHEMA_ID="${KRATOS_IDENTITY_SCHEMA_ID:-}" \
  MANIFEST="$manifest" \
    bash -c "$(bootstrap_body)"

  collect "$manifest" "cp"
}

# ── mode: pod ──────────────────────────────────────────────────────────────
run_in_pod() {
  local kratos_ip hydra_ip
  kratos_ip="$(kube -n "$NAMESPACE" get pod "$KRATOS_POD" -o jsonpath='{.status.podIP}')"
  hydra_ip="$(kube -n "$NAMESPACE" get pod "$HYDRA_POD" -o jsonpath='{.status.podIP}')"
  [[ -n "$kratos_ip" && -n "$hydra_ip" ]] || fail "could not read pod IPs for $KRATOS_POD / $HYDRA_POD"
  echo "  ✓ pod IPs        kratos=$kratos_ip hydra=$hydra_ip"

  cleanup() { kube -n "$NAMESPACE" delete pod "$POD_NAME" --now --ignore-not-found >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  echo "── seeder pod"
  kube -n "$NAMESPACE" delete pod "$POD_NAME" --now --ignore-not-found >/dev/null
  # runAsNonRoot + dropped capabilities + RuntimeDefault seccomp: passes the
  # `restricted` pod-security profile, so the pod is admitted whatever the
  # namespace enforces. fsGroup makes the emptyDir writable by uid 1000, which
  # npm needs for both HOME and the checkout.
  kube -n "$NAMESPACE" apply -f - >/dev/null <<POD
apiVersion: v1
kind: Pod
metadata:
  name: $POD_NAME
  labels: { app.kubernetes.io/name: $POD_NAME, app.kubernetes.io/managed-by: iam-test-plane }
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: seeder
      image: node:22-bookworm
      command: ["sleep", "infinity"]
      env:
        - { name: HOME, value: /work }
      volumeMounts:
        - { name: work, mountPath: /work }
      resources:
        requests: { cpu: 200m, memory: 512Mi }
        limits: { cpu: "2", memory: 2Gi }
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
  volumes:
    - name: work
      emptyDir: {}
POD
  kube -n "$NAMESPACE" wait --for=condition=Ready "pod/$POD_NAME" --timeout=300s >/dev/null \
    || { kube -n "$NAMESPACE" describe pod "$POD_NAME" >&2; fail "the seeder pod never became Ready (image pull needs the node's egress proxy)"; }
  echo "  ✓ pod            $POD_NAME ready"

  local bundle_in_pod=""
  if [[ -n "$BUNDLE" ]]; then
    kube -n "$NAMESPACE" cp "$BUNDLE" "$POD_NAME:/work/bundle.tgz" || fail "could not copy $BUNDLE into the pod"
    bundle_in_pod="/work/bundle.tgz"
  fi

  kube -n "$NAMESPACE" exec -i "$POD_NAME" -- env \
    WORK=/work \
    SEED_ARGS="${SEED_ARGS[*]}" \
    ROW="$ROW" \
    GIT_REPO="$REPO_URL" \
    GIT_REF="$REF" \
    BUNDLE_PATH="$bundle_in_pod" \
    KRATOS_ADMIN_URL="http://$kratos_ip:4434" \
    KRATOS_PUBLIC_URL="http://$kratos_ip:4433" \
    HYDRA_ADMIN_URL="http://$hydra_ip:4445" \
    KRATOS_IDENTITY_SCHEMA_ID="${KRATOS_IDENTITY_SCHEMA_ID:-}" \
    MANIFEST=/work/manifest.json \
    bash -s <<<"$(bootstrap_body)"

  collect "/work/manifest.json" "kubecp"
}

# ── manifest collection ────────────────────────────────────────────────────
collect() {
  local src="$1" how="$2"
  # --check mutates nothing and --purge removes the manifest: neither produces
  # one to collect.
  case " ${SEED_ARGS[*]} " in
    *" --check "* | *" --purge "*) return 0 ;;
  esac
  install -m 600 /dev/null "$OUT"
  if [[ "$how" == "kubecp" ]]; then
    kube -n "$NAMESPACE" cp "$POD_NAME:$src" "$OUT" || fail "could not copy the manifest out of the pod"
    chmod 600 "$OUT"
  else
    cat "$src" >"$OUT"
  fi
  cat <<EOF
── hand off
  Manifest (0600, holds passwords and TOTP secrets): $OUT
  Move it to the test host and shred the copy here:

    scp $OUT <test-host>:/secure/${ENVIRONMENT}-manifest.json && shred -u $OUT

  Then, from a checkout of this repo on the test host:

    MANIFEST=/secure/${ENVIRONMENT}-manifest.json \\
    LOGIN_UI_URL=https://$INGRESS_HOST \\
    KRATOS_PUBLIC_URL=https://$INGRESS_HOST \\
    HYDRA_PUBLIC_URL=https://$INGRESS_HOST \\
      make test-matrix-row ROW=$ROW BACKEND=urls

  Leave KRATOS_ADMIN_URL UNSET there: that is what selects the live lane and
  keeps the test run incapable of mutating the deployment.

  When you are done with the deployment, re-run this script with --purge to
  delete exactly what was seeded.
EOF
}


case "$MODE" in
  node) run_on_node ;;
  pod) run_in_pod ;;
esac
