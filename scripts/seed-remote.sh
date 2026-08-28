#!/usr/bin/env bash
# Copyright 2026 Canonical Ltd.
# SPDX-License-Identifier: AGPL-3.0
#
# Seed a REMOTE deployment out of band, then hand the manifest to a test host
# that has nothing but the public ingress (tests/browser/LANES.md).
#
# This is the seeding half of the `urls` matrix backend (docs/testing-spec.md
# §9). It exists because the prerequisites are not guessable and every one of
# them, when wrong, fails LATER and misleadingly:
#
#   * KRATOS_PUBLIC_URL must be kratos's OWN public API, not the deployment's
#     ingress. A charmed ingress routes /self-service/* to the login-ui BFF,
#     which serves no native /self-service/login/api — and TOTP enrolment is a
#     native login + settings flow. Aimed at the ingress, the seeder writes
#     `totpSecret: null` and every MFA scenario then dies on "re-seed".
#   * KRATOS_IDENTITY_SCHEMA_ID is `default` only on the compose stack. A
#     charmed deployment ships its own schemas (iam.orange.canonical.com:
#     social_user_v0, admin_v0), and an unknown schema id is a 400 per identity.
#   * MANIFEST must be set: the manifest carries passwords and TOTP secrets, so
#     for a real deployment it is credential material and does not belong at the
#     in-repo default path.
#   * the deployment must be ABLE to store an identity. A served schema id is
#     not that proof: teal answered /schemas correctly and then 500'd every
#     create out of kratos's own INSERT (a workload/database version skew), one
#     step after --fresh had begun deleting. The probe below writes one.
#
# Usage:
#   KRATOS_ADMIN_URL=…  KRATOS_PUBLIC_URL=…  HYDRA_ADMIN_URL=… \
#   KRATOS_IDENTITY_SCHEMA_ID=social_user_v0 \
#   MANIFEST=/secure/orange-manifest.json \
#     scripts/seed-remote.sh [--check] [--purge|--incremental] [--row <name>]
#
#   --check   run every prerequisite probe and stop. Creates and deletes exactly
#             one throwaway @test.example identity — the only way to prove the
#             deployment accepts one — and mutates nothing else.
#   --row     matrix row whose capabilities.json declares the deployment
#             (default: deployed-core-local-mfa)
#
# TLS: if the deployment's chain is incomplete (orange serves the leaf alone),
# export NODE_EXTRA_CA_CERTS with the missing intermediates rather than
# disabling verification — see docs/testing-spec.md §9.

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

# Absolutize BEFORE the `cd tests/browser` below: resolveManifestPath() does
# path.resolve(MANIFEST), which is relative to the SEEDER's cwd, so a relative
# MANIFEST silently lands in tests/browser/ instead of where you ran this from.
# -m: the parent may not exist yet — the seeder mkdirs it.
MANIFEST="$(realpath -m "$MANIFEST")"
export MANIFEST

# `json <url> <expr>` prints a field of a JSON response, or the transport error.
# node, not curl+jq: node is already required (make dev-check) and it honours
# NODE_EXTRA_CA_CERTS, so a TLS problem here reads the same as in the seeder.
json() {
  node -e '
    const [url, expr] = process.argv.slice(1);
    fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) })
      .then(async (r) => {
        if (!r.ok) { console.log(`HTTP ${r.status}`); process.exit(3); }
        const body = await r.json();
        console.log(String(eval(expr)));
      })
      .catch((e) => { console.log(e.cause?.message ?? e.message); process.exit(3); });
  ' "$1" "$2"
}

echo "── prerequisites"

# 1. Admin APIs answer. Checked first: a half-seeded deployment is the worst
#    outcome, and both of these fail instantly when they fail at all.
json "$KRATOS_ADMIN_URL/admin/identities?per_page=1" 'Array.isArray(body) ? "ok" : "unexpected body"' >/dev/null \
  || fail "KRATOS_ADMIN_URL does not serve the kratos admin API: $(json "$KRATOS_ADMIN_URL/admin/identities?per_page=1" '"see above"' || true)"
echo "  ✓ kratos admin  $KRATOS_ADMIN_URL"

json "$HYDRA_ADMIN_URL/admin/clients?page_size=1" 'Array.isArray(body) ? "ok" : "unexpected body"' >/dev/null \
  || fail "HYDRA_ADMIN_URL does not serve the hydra admin API"
echo "  ✓ hydra admin   $HYDRA_ADMIN_URL"

# 2. THE load-bearing check: kratos's own native API, not the ingress/BFF.
if ! flow_type="$(json "$KRATOS_PUBLIC_URL/self-service/login/api" 'body.type')" || [[ "$flow_type" != "api" ]]; then
  fail "KRATOS_PUBLIC_URL=$KRATOS_PUBLIC_URL does not serve kratos's native API
      GET /self-service/login/api -> ${flow_type:-unreachable}
    An ingress that fronts the login-ui BFF answers exactly this (bare 404). TOTP
    enrolment needs the native flow, so seeding through it would write
    totpSecret: null. Point this at kratos itself — port-forward :4433, or the
    in-cluster service address."
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

# 4. The deployment can actually ACCEPT an identity of that schema, credentials
#    and all. Reading /schemas proves the id exists; it does not prove the write
#    path works, and on teal it did not: every create returned a 500 from
#    kratos's own INSERT. Without this probe that surfaces one step too late —
#    after --fresh has already deleted the previous seed. One throwaway identity
#    in the reserved @test.example namespace, created and deleted here.
write_probe="$(node -e '
  const [admin, schema] = process.argv.slice(1);
  const email = `preflight-${Date.now().toString(36)}@test.example`;
  // The payload the seeder itself uses (helpers/kratos.ts createIdentity): a
  // traits-only probe would miss exactly the credential-identifier write that
  // fails on a schema/workload version skew.
  const body = {
    schema_id: schema,
    credentials: { password: { config: { password: "Preflight-Probe-9!" } } },
    traits: { email, name: "Preflight", surname: "Probe" },
  };
  (async () => {
    const res = await fetch(`${admin}/admin/identities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`HTTP ${res.status} ${text.replace(/\s+/g, " ").slice(0, 500)}`);
      process.exit(3);
    }
    const id = JSON.parse(text).id;
    const del = await fetch(`${admin}/admin/identities/${id}`, { method: "DELETE", signal: AbortSignal.timeout(20000) });
    console.log(del.ok || del.status === 404 ? "ok" : `LEFTOVER ${id} (DELETE returned ${del.status})`);
  })().catch((e) => { console.log(e.cause?.message ?? e.message); process.exit(3); });
' "$KRATOS_ADMIN_URL" "$schema")" || {
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
  LEFTOVER*) echo "  ⚠ write probe    $write_probe — delete it by hand" >&2 ;;
  *) echo "  ✓ write probe   one identity created and deleted (schema $schema)" ;;
esac

echo "  ✓ row $ROW -> $CAPS"
echo "  ✓ manifest       $MANIFEST"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "── --check: prerequisites pass, nothing mutated"
  exit 0
fi

echo "── seed ($MODE)"
cd "$REPO/tests/browser"

# NOT --silent: it hid its own failure, and this step is the one that needs the
# network. A seeding host inside the cluster reaches the admin APIs and often
# nothing else, so an unreachable npm registry looked like the script dying
# after "── seed" with no output at all.
npm install || fail "npm install failed in tests/browser — the seeding host needs the npm registry
    (proxy: npm config set proxy/https-proxy, or vendor node_modules from a host that has it:
     tar czf nm.tgz -C tests/browser node_modules && untar here)"

# --no-install: resolve tsx from node_modules, never from the registry at run
# time. Unpinned, `npx tsx` fetched it on every invocation and failed opaquely
# where egress is blocked.
ACTIVE_PROFILE="$ROW" BROWSER_TEST_CAPABILITIES="$CAPS" \
  npx --no-install tsx seeder/seed.ts "$MODE" --profile "$ROW" \
  || fail "the seeder exited non-zero — see its output above. The manifest may still have been
    written ($MANIFEST): it is written BEFORE the strict-mode failure report."

[[ "$MODE" == "--purge" ]] && exit 0

# The manifest is credential material; 0600 it before it can be read by anyone
# else on the seeding host.
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
