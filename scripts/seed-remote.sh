#!/usr/bin/env bash
# Copyright 2026 Canonical Ltd.
# SPDX-License-Identifier: AGPL-3.0
#
# Seed a remote deployment out of band and hand the manifest to a test host
# that has only the public ingress (the seeding half of the `urls` backend,
# docs/testing-spec.md §9). Every prerequisite is probed up front because each
# one, when wrong, fails later and misleadingly.
#
# Usage:
#   KRATOS_ADMIN_URL=…  KRATOS_PUBLIC_URL=…  HYDRA_ADMIN_URL=… \
#   KRATOS_IDENTITY_SCHEMA_ID=social_user_v0 \
#   MANIFEST=/secure/orange-manifest.json \
#     scripts/seed-remote.sh [--check] [--purge|--incremental] [--row <name>]
#
#   KRATOS_PUBLIC_URL   kratos's OWN public API, not the ingress (the login-ui
#                       BFF serves no native /self-service/login/api, and TOTP
#                       enrolment needs it)
#   KRATOS_IDENTITY_SCHEMA_ID   `default` only on compose; charmed deployments
#                       ship their own (e.g. social_user_v0)
#   MANIFEST            required; holds passwords and TOTP secrets
#   --check   run every probe and stop. Creates and deletes exactly one
#             throwaway @test.example identity, mutates nothing else.
#   --row     matrix row declaring the deployment (deployed-core-local-mfa)
#
# Incomplete TLS chain: export NODE_EXTRA_CA_CERTS with the missing
# intermediates rather than disabling verification (docs/testing-spec.md §9).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROW="deployed-core-local-mfa"
MODE="--fresh"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --fresh | --incremental | --purge) MODE="$1" ;;
    --row) ROW="${2:?--row needs a value}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

CAPS="$REPO/matrix/rows/$ROW/capabilities.json"
[[ -f "$CAPS" ]] || { echo "✗ no such materialized row: $ROW (see matrix/matrix.json)" >&2; exit 2; }

fail() { echo "✗ $*" >&2; exit 1; }

for var in KRATOS_ADMIN_URL KRATOS_PUBLIC_URL HYDRA_ADMIN_URL MANIFEST; do
  [[ -n "${!var:-}" ]] || fail "$var is required (see the header of $0)"
done

# Absolutize before `cd tests/browser`: the seeder resolves MANIFEST against its own cwd.
MANIFEST="$(realpath -m "$MANIFEST")"
export MANIFEST

# `json <url> <expr>` prints a field of a JSON response, or the transport error.
# node rather than curl+jq: it honours NODE_EXTRA_CA_CERTS like the seeder does.
# On non-2xx the (truncated) body is part of the answer: it names the fault.
json() {
  node -e '
    const [url, expr] = process.argv.slice(1);
    fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) })
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          console.log(`HTTP ${r.status} ${text.replace(/\s+/g, " ").slice(0, 400)}`.trim());
          process.exit(3);
        }
        const body = await r.json();
        console.log(String(eval(expr)));
      })
      .catch((e) => { console.log(e.cause?.message ?? e.message); process.exit(3); });
  ' "$1" "$2"
}

echo "── prerequisites"

# 1. Admin APIs answer. First, because a half-seeded deployment is the worst outcome.
json "$KRATOS_ADMIN_URL/admin/identities?per_page=1" 'Array.isArray(body) ? "ok" : "unexpected body"' >/dev/null \
  || fail "KRATOS_ADMIN_URL does not serve the kratos admin API:
      GET $KRATOS_ADMIN_URL/admin/identities -> $(json "$KRATOS_ADMIN_URL/admin/identities?per_page=1" '"unexpected body"' || true)"
echo "  ✓ kratos admin  $KRATOS_ADMIN_URL"

json "$HYDRA_ADMIN_URL/admin/clients?page_size=1" 'Array.isArray(body) ? "ok" : "unexpected body"' >/dev/null \
  || fail "HYDRA_ADMIN_URL does not serve the hydra admin API:
      GET $HYDRA_ADMIN_URL/admin/clients -> $(json "$HYDRA_ADMIN_URL/admin/clients?page_size=1" '"unexpected body"' || true)"
echo "  ✓ hydra admin   $HYDRA_ADMIN_URL"

# 2. Kratos's own native API, not the ingress/BFF. A 404/HTML answer means this
#    URL is NOT kratos; a 5xx means it IS kratos and cannot create a login flow.
restart_hint="${KRATOS_RESTART_HINT:-kubectl -n <ns> exec <kratos-pod> -c kratos -- pebble restart kratos}"

if ! flow_type="$(json "$KRATOS_PUBLIC_URL/self-service/login/api" 'body.type')" || [[ "$flow_type" != "api" ]]; then
  case "$flow_type" in
    *nid_fk*)
      # SQLSTATE names a flow table, the cause is process state, the fix is a restart.
      fail "kratos is running with a network id its database no longer contains:
      GET /self-service/login/api -> $flow_type
    kratos resolves its nid ONCE, at startup: networkx.Determine() takes the
    oldest row of the \`networks\` table and caches it on the persister
    (ory/kratos@64e04ac oryx/networkx/manager.go:41-55, called from
    driver/registry_default.go:698-704 — the exact build this deployment runs).
    If that row disappears while the process keeps running — a restored,
    re-created or re-migrated database — every insert into a table carrying the
    nid foreign key fails, so every login flow AND every browser login on this
    deployment fails with it.
    RESTART THE WORKLOAD; there is nothing to fix on this side:
      $restart_hint
    Then re-run this. If it comes straight back, something is still rewriting
    the database underneath kratos." ;;
    "HTTP 5"*)
      fail "kratos IS at $KRATOS_PUBLIC_URL and cannot create a login flow:
      GET /self-service/login/api -> $flow_type
    This is kratos's own port answering, so the URL is right and the deployment
    is broken: creating a login flow is the most basic thing kratos does, and
    every browser login on this deployment is failing the same way. Read its
    reason from the workload, not from here:
      kubectl -n <ns> logs kratos-0 -c kratos --tail=50
    A schema/workload skew reports as a column error (see the identity-write
    probe below); a config fault reports at flow persistence or validation." ;;
    *)
      fail "KRATOS_PUBLIC_URL=$KRATOS_PUBLIC_URL does not serve kratos's native API
      GET /self-service/login/api -> ${flow_type:-unreachable}
    An ingress that fronts the login-ui BFF answers exactly this (bare 404). TOTP
    enrolment needs the native flow, so seeding through it would write
    totpSecret: null. Point this at kratos itself — port-forward :4433, or the
    in-cluster service address." ;;
  esac
fi
echo "  ✓ kratos public $KRATOS_PUBLIC_URL (native API confirmed)"

# 3. The identity schema the deployment actually serves.
schemas="$(json "$KRATOS_PUBLIC_URL/schemas" 'body.map((s) => s.id).join(",")')" \
  || fail "could not list identity schemas from $KRATOS_PUBLIC_URL/schemas"
schema="${KRATOS_IDENTITY_SCHEMA_ID:-default}"
case ",$schemas," in
  *",$schema,"*) ;;
  *) fail "KRATOS_IDENTITY_SCHEMA_ID=$schema is not served by this deployment
    available: $schemas
    Set KRATOS_IDENTITY_SCHEMA_ID to the human-user schema (on the charmed core
    deployments that is social_user_v0, not default)." ;;
esac
export KRATOS_IDENTITY_SCHEMA_ID="$schema"
echo "  ✓ identity schema $schema (served: $schemas)"

# 4. The deployment can ACCEPT an identity of that schema, credentials and all
#    (a served schema id does not prove the write path, and a write failure would
#    otherwise surface after --fresh has already deleted the previous seed). Same
#    helper as the preflight's AAL probe; a traits-only probe would miss the credential write.
write_probe="$(node "$REPO/matrix/verify/probe-identity.mjs" "$KRATOS_ADMIN_URL" "$schema")" || {
  hint=""
  case "$write_probe" in
    *identity_credential_identifiers*)
      hint="
    That NOT NULL violation is a VERSION SKEW in the deployment, not a payload
    problem: identity_credential_identifiers.identity_id is added and made NOT
    NULL by ory/kratos@6bf18bf87e02a25bd1f87bb40af71f8439a6c0c5 (present in
    v26.2.0, absent in v25.4.0), and kratos only populates it from that version
    on — v25.4.0's CredentialIdentifier struct has no such field. So this
    database was migrated by kratos >= v26 while the kratos WRITING identities
    is <= v25. Fix the deployment (align the workload with the migrated schema);
    no seeder payload can supply a column the writer never mentions." ;;
  esac
  fail "this deployment refuses to create an identity, so the seeder would fail on every user:
      POST $KRATOS_ADMIN_URL/admin/identities (schema $schema) -> $write_probe$hint"
}
case "$write_probe" in
  ok) echo "  ✓ write probe   one identity created and deleted (schema $schema)" ;;
  LEFTOVER*) echo "  ⚠ write probe    $write_probe — delete it by hand" >&2 ;;
  *) fail "write probe produced no verdict (got '$write_probe'); refusing to continue" ;;
esac

echo "  ✓ row $ROW -> $CAPS"
echo "  ✓ manifest       $MANIFEST"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "── --check: prerequisites pass, nothing mutated"
  exit 0
fi

echo "── seed ($MODE)"
cd "$REPO/tests/browser"

# NOT --silent: this is the step that needs the registry, and silent hid its failure.
npm install || fail "npm install failed in tests/browser — the seeding host needs the npm registry
    (proxy: npm config set proxy/https-proxy, or vendor node_modules from a host that has it:
     tar czf nm.tgz -C tests/browser node_modules && untar here)"

# --no-install: resolve tsx from node_modules, never from the registry at run time.
ACTIVE_PROFILE="$ROW" BROWSER_TEST_CAPABILITIES="$CAPS" \
  npx --no-install tsx seeder/seed.ts "$MODE" --profile "$ROW" \
  || fail "the seeder exited non-zero — see its output above. The manifest may still have been
    written ($MANIFEST): it is written BEFORE the strict-mode failure report."

[[ "$MODE" == "--purge" ]] && exit 0

# Credential material: 0600 before anyone else on the host can read it.
chmod 600 "$MANIFEST"

# Summary only — never the secrets themselves.
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const totp = m.users.filter((u) => u.totpSecret).length;
  console.log(`── manifest: ${m.users.length} user(s), ${totp} with TOTP, ` +
    `${m.tenants.length} tenant(s), clients: ${m.oauthClients ? Object.keys(m.oauthClients).join("+") : "none"}`);
' "$MANIFEST"

cat <<EOF
── hand off
  Copy $MANIFEST to the test host (it holds passwords and TOTP secrets), then:

    MANIFEST=<path> \\
    LOGIN_UI_URL=https://<host> KRATOS_PUBLIC_URL=https://<host> HYDRA_PUBLIC_URL=https://<host> \\
      make test-matrix-row ROW=$ROW BACKEND=urls

  Leave KRATOS_ADMIN_URL UNSET there: that is what selects the live lane and
  keeps the run incapable of mutating the deployment.
EOF
