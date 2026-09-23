#!/usr/bin/env bash
# Copyright 2026 Canonical Ltd.
# SPDX-License-Identifier: AGPL-3.0
#
# Seed a charmed deployment from inside its cluster. This script is transport
# only; scripts/seed-remote.sh owns every prerequisite probe and the seeder.
#
# Usage (from a checkout on a node of the deployment's k8s cluster):
#
#   scripts/seed-in-cluster.sh --env <colour> [--check | --purge | --incremental]
#
#   --env <name>       REQUIRED deployment colour; namespace defaults to <name>-iam,
#                      ingress host to iam.<name>.canonical.com. No default on
#                      purpose: this script deletes and re-creates identities.
#   --namespace <ns>   override the namespace
#   --host <fqdn>      override the ingress host in the printed handoff
#   --row <row>        matrix row declaring the target (deployed-core-local-mfa)
#   --mode pod|node    pod (default): throwaway node:22 pod in the namespace, this
#                      checkout streamed in, deleted on exit. node: kubectl
#                      port-forward and seed from this host (needs node >= 20;
#                      --install-toolchain permits a snap install, which persists)
#   --proxy <url>      egress proxy for the pod's npm (discovered from the node's
#                      snapd/containerd/apt drop-ins when unset)
#   --out <path>       manifest destination on THIS host (./manifest.<env>.json, 0600)
#   --check            prerequisite probes only; creates and deletes one throwaway
#                      @test.example identity, nothing else
#   --fresh|--incremental|--purge   seeder mode (--fresh)
#
# Admin ports (kratos 4434, hydra 4445) are reachable on the pod network only,
# and via POD IPs, not the ClusterIP service: juju's service exposes only the
# ports the charm declares, and the admin port is not among them on every revision.
#
# The manifest holds seeded passwords and TOTP secrets: move it off a
# production node and `shred -u` the copy.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENVIRONMENT=""
INGRESS_HOST=""
NAMESPACE=""
ROW="deployed-core-local-mfa"
MODE="pod"
OUT=""
SEED_ARGS=()
POD_NAME="iam-seeder"
INSTALL_TOOLCHAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENVIRONMENT="${2:?--env needs a value}"; shift ;;
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift ;;
    --host) INGRESS_HOST="${2:?--host needs a value}"; shift ;;
    --row) ROW="${2:?--row needs a value}"; shift ;;
    --mode) MODE="${2:?--mode needs a value}"; shift ;;
    --proxy) PROXY="${2:?--proxy needs a value}"; PROXY_FROM="--proxy"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift ;;
    --install-toolchain) INSTALL_TOOLCHAIN=1 ;;
    --check | --fresh | --incremental | --purge) SEED_ARGS+=("$1") ;;
    -h | --help) sed -n '5,34p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$ENVIRONMENT" ]] || {
  echo "✗ --env is required (deployment colour, e.g. --env orange): this script mutates the target deployment, so it is never implied" >&2
  echo "  usage: scripts/seed-in-cluster.sh --env <colour> [--namespace <ns>] [--check | --purge | --incremental]" >&2
  exit 2
}
NAMESPACE="${NAMESPACE:-${ENVIRONMENT}-iam}"
OUT="${OUT:-$PWD/manifest.${ENVIRONMENT}.json}"
INGRESS_HOST="${INGRESS_HOST:-iam.${ENVIRONMENT}.canonical.com}"
[[ "$MODE" == "node" || "$MODE" == "pod" ]] || { echo "--mode must be node or pod" >&2; exit 2; }
[[ ${#SEED_ARGS[@]} -gt 0 ]] || SEED_ARGS=("--fresh")

# Cleanup state is global: the EXIT trap runs after the mode function returned.
WORKDIR=""
PF_PIDS=()

fail() { echo "✗ $*" >&2; exit 1; }

[[ -x "$REPO/scripts/seed-remote.sh" ]] \
  || fail "$REPO does not look like a checkout of this repo (no executable scripts/seed-remote.sh)"
[[ -f "$REPO/matrix/rows/$ROW/capabilities.json" ]] \
  || fail "no such materialized row: $ROW (see matrix/matrix.json)"

echo "── plan"
echo "  ${MODE} mode, row $ROW, seeder ${SEED_ARGS[*]}, namespace $NAMESPACE, ingress $INGRESS_HOST"
echo "  checkout $REPO"

# ── kubectl ────────────────────────────────────────────────────────────────
# Canonical k8s ships kubectl as a snap subcommand; on a control node only root has the config.
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

# ── the seeding step, identical on both hosts ──────────────────────────────
seed_body() {
  cat <<'SEED'
set -euo pipefail
: "${REPO_DIR:?}" "${SEED_ARGS:?}" "${ROW:?}"

# A complete node_modules makes seed-remote's `npm install` a no-op; audit/fund would still call out.
export npm_config_audit=false npm_config_fund=false

# A charmed deployment's schema is not `default`; ask kratos when the caller did not say.
if [[ -z "${KRATOS_IDENTITY_SCHEMA_ID:-}" ]]; then
  KRATOS_IDENTITY_SCHEMA_ID="$(node -e '
    fetch(process.argv[1] + "/schemas", { signal: AbortSignal.timeout(10000) })
      .then((r) => r.json())
      .then((body) => {
        const ids = body.map((s) => s.id);
        // `default` when served, else the one non-admin schema; ambiguity is refused.
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

exec "$REPO_DIR/scripts/seed-remote.sh" $SEED_ARGS --row "$ROW"
SEED
}

# ── what kratos itself says, when the seed step fails ──────────────────────
# The rock ships neither curl nor wget and the log is drowned in /health/ready
# noise, so the script that has kubectl does the reading.
diagnose_kratos() {
  echo >&2
  echo "── kratos, at the moment it refused" >&2
  local ver
  # The image is pinned by digest; only the binary knows its version.
  ver="$(kube -n "$NAMESPACE" exec "$KRATOS_POD" -c kratos -- kratos version 2>/dev/null | tr '\n' ' ' || true)"
  echo "  version: ${ver:-unavailable (kratos binary not on PATH in the container)}" >&2
  echo "  last error/warn lines (health-check noise filtered):" >&2
  kube -n "$NAMESPACE" logs "$KRATOS_POD" -c kratos --tail=1000 2>/dev/null \
    | grep -v '/health/' \
    | grep -Ei '"level":"(error|warn)"|panic|SQLSTATE|migrat' \
    | tail -12 \
    | sed 's/^/    /' >&2 \
    || echo "    (none in the last 1000 lines — the failure may not be logged as an error)" >&2
}

# ── mode: node ─────────────────────────────────────────────────────────────
run_on_node() {
  local sudo=""; [[ "$(id -u)" == 0 ]] || sudo="sudo"

  # A snap on a production node outlives the run: installing is opt-in.
  echo "── toolchain"
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [[ "$major" -lt 20 ]] || ! command -v npm >/dev/null 2>&1; then
    [[ "$INSTALL_TOOLCHAIN" == 1 ]] || fail "node >= 20 with npm is not on this host, and node mode runs the seeder here.
    Pick one, in this order of preference:
      --mode pod                 seed from a throwaway pod instead; installs nothing here
      --install-toolchain        permit snap/apt to install it on THIS node (persists)
    (found: $( [[ "$major" == 0 ]] && echo "no node" || echo "node v$major" ) — the seeder and every probe run on node's fetch)"
    # snap first: the only channel carrying a current node, with the egress proxy already configured.
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
  if ! REPO_DIR="$REPO" SEED_ARGS="${SEED_ARGS[*]}" ROW="$ROW" \
    KRATOS_ADMIN_URL="http://127.0.0.1:4434" \
    KRATOS_PUBLIC_URL="http://127.0.0.1:4433" \
    HYDRA_ADMIN_URL="http://127.0.0.1:4445" \
    KRATOS_IDENTITY_SCHEMA_ID="${KRATOS_IDENTITY_SCHEMA_ID:-}" \
    KRATOS_RESTART_HINT="${KUBECTL[*]} -n $NAMESPACE exec $KRATOS_POD -c kratos -- pebble restart kratos" \
    MANIFEST="$manifest" \
      bash -c "$(seed_body)"; then
    diagnose_kratos
    exit 1
  fi

  collect "$manifest" "local"
}

# ── egress proxy ───────────────────────────────────────────────────────────
# The node's transparent proxy excludes the pod CIDR, so npm in the pod needs
# the proxy explicitly. Read from the node's own drop-ins rather than hardcoded.
discover_proxy() {
  local v f
  [[ -n "${PROXY:-}" ]] && return 0
  for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
    [[ -n "${!v:-}" ]] && { PROXY="${!v}"; PROXY_FROM="\$$v"; return 0; }
  done
  for f in /etc/systemd/system/snapd.service.d/http-proxy.conf \
           /etc/systemd/system/snap.k8s.containerd.service.d/http-proxy.conf; do
    [[ -r "$f" ]] || continue
    PROXY="$(sed -n 's/^Environment="\?HTTPS\?_PROXY=\([^"]*\)"\?.*/\1/p' "$f" | head -1)"
    [[ -n "$PROXY" ]] && { PROXY_FROM="$f"; return 0; }
  done
  if [[ -r /etc/apt/apt.conf.d/99proxy ]]; then
    PROXY="$(sed -n 's/.*Proxy *"\([^"]*\)".*/\1/p' /etc/apt/apt.conf.d/99proxy | head -1)"
    [[ -n "$PROXY" ]] && { PROXY_FROM="/etc/apt/apt.conf.d/99proxy"; return 0; }
  fi
  return 0
}

# ── mode: pod ──────────────────────────────────────────────────────────────
run_in_pod() {
  local kratos_ip hydra_ip
  kratos_ip="$(kube -n "$NAMESPACE" get pod "$KRATOS_POD" -o jsonpath='{.status.podIP}')"
  hydra_ip="$(kube -n "$NAMESPACE" get pod "$HYDRA_POD" -o jsonpath='{.status.podIP}')"
  [[ -n "$kratos_ip" && -n "$hydra_ip" ]] || fail "could not read pod IPs for $KRATOS_POD / $HYDRA_POD"
  echo "  ✓ pod IPs        kratos=$kratos_ip hydra=$hydra_ip"

  # Resolve the proxy before the pod exists so it is baked into the spec.
  local vendored=0
  [[ -d "$REPO/tests/browser/node_modules" ]] && vendored=1
  discover_proxy
  local pod_env=""
  if [[ -n "${PROXY:-}" ]]; then
    # NO_PROXY keeps in-cluster targets off the proxy (npm honours it; node's fetch ignores it).
    local no_proxy="localhost,127.0.0.1,.svc,.svc.cluster.local,$kratos_ip,$hydra_ip"
    pod_env="$(printf '        - { name: %s, value: "%s" }\n' \
      HTTP_PROXY "$PROXY" HTTPS_PROXY "$PROXY" http_proxy "$PROXY" https_proxy "$PROXY" \
      NO_PROXY "$no_proxy" no_proxy "$no_proxy")"
    echo "  ✓ egress proxy   $PROXY (from ${PROXY_FROM:-?})"
  elif [[ "$vendored" == 0 ]]; then
    echo "  ⚠ no egress proxy discovered, and this checkout has no" >&2
    echo "    tests/browser/node_modules — the pod will have to reach the npm" >&2
    echo "    registry directly. Pass --proxy <url> if that times out." >&2
  fi

  cleanup() { kube -n "$NAMESPACE" delete pod "$POD_NAME" --now --ignore-not-found >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  echo "── seeder pod"
  kube -n "$NAMESPACE" delete pod "$POD_NAME" --now --ignore-not-found >/dev/null
  # Passes the `restricted` pod-security profile; fsGroup makes the emptyDir writable by uid 1000.
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
$pod_env
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

  # Stream THIS checkout in (no git, egress or pushed ref needed; node_modules
  # rides along). tfstate and manifest.json are secret-bearing: never in the pod.
  echo "── transfer"
  kube -n "$NAMESPACE" exec "$POD_NAME" -- mkdir -p /work/repo
  tar -C "$REPO" -czf - \
    --exclude=./.git \
    --exclude='*.tfstate*' \
    --exclude=./matrix/backends/juju/root/local.auto.tfvars \
    --exclude=./tests/browser/manifest.json \
    --exclude='./tests/browser/test-results*' \
    . | kube -n "$NAMESPACE" exec -i "$POD_NAME" -- tar -xzf - -C /work/repo \
    || fail "could not stream the checkout into the pod"
  kube -n "$NAMESPACE" exec "$POD_NAME" -- test -x /work/repo/scripts/seed-remote.sh \
    || fail "the transfer landed but /work/repo/scripts/seed-remote.sh is not executable in the pod"
  if [[ "$vendored" == 1 ]]; then
    echo "  ✓ checkout       /work/repo (with node_modules — no npm registry needed)"
  else
    # No node_modules: prove the registry is reachable now, so `--check` covers
    # the `npm install` seed-remote.sh will run.
    echo "  ✓ checkout       /work/repo (no node_modules — npm will install in the pod)"
    kube -n "$NAMESPACE" exec "$POD_NAME" -- npm ping >/dev/null 2>&1 \
      || fail "the pod cannot reach the npm registry$( [[ -n "${PROXY:-}" ]] && echo " through $PROXY" ).
    A pod is not covered by the node's transparent proxy, so one of these has to hold:
      --proxy <url>              pass the egress proxy explicitly
      ship node_modules          run \`npm install\` in tests/browser on a host with
                                 egress and scp the checkout here; it rides along
                                 in the transfer and npm then makes no call at all"
    echo "  ✓ npm registry   reachable from the pod"
  fi

  # Only the listed env reaches the pod; the seeder needs the Google address and
  # subject to create google-user (the password/TOTP never leave this host).
  if ! kube -n "$NAMESPACE" exec -i "$POD_NAME" -- env \
    REPO_DIR=/work/repo \
    SEED_ARGS="${SEED_ARGS[*]}" \
    ROW="$ROW" \
    ${GOOGLE_TEST_EMAIL:+GOOGLE_TEST_EMAIL="$GOOGLE_TEST_EMAIL"} \
    ${GOOGLE_TEST_SUBJECT_ID:+GOOGLE_TEST_SUBJECT_ID="$GOOGLE_TEST_SUBJECT_ID"} \
    KRATOS_ADMIN_URL="http://$kratos_ip:4434" \
    KRATOS_PUBLIC_URL="http://$kratos_ip:4433" \
    HYDRA_ADMIN_URL="http://$hydra_ip:4445" \
    KRATOS_IDENTITY_SCHEMA_ID="${KRATOS_IDENTITY_SCHEMA_ID:-}" \
    KRATOS_RESTART_HINT="${KUBECTL[*]} -n $NAMESPACE exec $KRATOS_POD -c kratos -- pebble restart kratos" \
    MANIFEST=/work/manifest.json \
    bash -s <<<"$(seed_body)"; then
    diagnose_kratos
    exit 1
  fi

  collect "/work/manifest.json" "pod"
}

# ── manifest collection ────────────────────────────────────────────────────
collect() {
  local src="$1" how="$2"
  # --check mutates nothing and --purge removes the manifest.
  case " ${SEED_ARGS[*]} " in
    *" --check "* | *" --purge "*) return 0 ;;
  esac
  install -m 600 /dev/null "$OUT"
  if [[ "$how" == "pod" ]]; then
    kube -n "$NAMESPACE" exec "$POD_NAME" -- cat "$src" >"$OUT" || fail "could not read the manifest out of the pod"
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
