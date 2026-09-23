# Browser Test Lanes

Operator guide for `BROWSER_TEST_LANE`, out-of-band seeding, and Google OIDC
credentials. Suite layout, scenario anatomy and debugging: `README.md`.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `BROWSER_TEST_LANE` | `internal` or `live` | `internal` |
| `BROWSER_DISABLE_LANE_ENFORCEMENT` | `true` disables lane gating (rollback toggle) | `false` |
| `BROWSER_TEST_CAPABILITIES` | Path to a row's `capabilities.json`; the declaration that gates every scenario. Unset → `globalSetup` falls back to `/api/v0/app-config` discovery (`active-config.json`) | unset |
| `MANIFEST` | Seed manifest path, read by the seeder and the suite alike. Holds passwords and TOTP secrets: treat as a secret | `tests/browser/manifest.json` |
| `LOGIN_UI_URL`, `KRATOS_PUBLIC_URL`, `HYDRA_PUBLIC_URL` | Public surfaces the browser reaches | compose localhost ports |
| `KRATOS_ADMIN_URL`, `HYDRA_ADMIN_URL` | Admin APIs (seeder only). `KRATOS_ADMIN_URL` unset selects the live lane in the `urls` matrix backend | compose localhost ports |
| `MAIL_API_URL`, `DEX_URL`, `OIDC_CONSUMER_URL`, `TENANT_SERVICE_URL`, `HOOK_SERVICE_URL`, `USER_VERIFICATION_URL` | Other surfaces the suite or seeder reaches; recovery/verification need mail, dex journeys need dex. Compose defaults in `helpers/config.ts` | compose localhost ports |
| `BROWSER_TEST_INSECURE_TLS` | `1` accepts the charmed lane's self-signed ingress CA; set by the matrix runner, not by hand | unset |
| `KRATOS_IDENTITY_SCHEMA_ID` | Schema every seeded identity is created under; charmed deployments do not ship `default` — pick from `GET /schemas` a schema that requires only `email` and does not set `additionalProperties: false` (the seeder writes `email`, `name`, `surname`) | `default` |
| `GOOGLE_TEST_EMAIL`, `GOOGLE_TEST_PASSWORD`, `GOOGLE_TEST_TOTP_SECRET`, `GOOGLE_TEST_SUBJECT_ID` | Workspace account, base32 TOTP secret and Google `sub` for the `google-oidc` project | unset (project skips) |

## Lanes

- **internal** — the full suite: email-dependent flows (recovery, verification), registration bootstrap
  through Kratos's public port, and specs that call the admin API at runtime (`use-backup-codes.spec.ts`).
- **live** — only scenarios reachable through the public login-ui and Hydra surfaces; internal-only
  suites (`recovery:*`, `verification:*`, `registration:*`, admin-API specs) are excluded by lane
  metadata (`defaultLanes` / `lanes`), `framework/transitions.ts:assertInternalLane()` is the
  backstop, and `scripts/audit-live-compat.mjs` audits active specs statically.

```bash
make test-browser-internal          # BROWSER_TEST_LANE=internal npx playwright test
make test-browser-live              # BROWSER_TEST_LANE=live npx playwright test
make test-browser-audit-live        # cd tests/browser && npm run audit:live
# Expected run/skip set for a lane against a row:
cd tests/browser && BROWSER_TEST_LANE=live npx tsx scripts/expected-set.ts ../../matrix/rows/<row>/capabilities.json
```

Gating order is lane, then `satisfies(requires, capabilities)`; both happen before the manifest is
read, so a manifest-less run skips normally and fails only in fixture setup for scenarios that do
run (`Manifest file not found`, or `totpSecret is null` against a stale manifest from another
stack). Point `MANIFEST` at the right file rather than reading those as deployment problems.

## Seeding an existing deployment (out of band)

The suite reads identities from the manifest and never calls an admin API itself, so seeding and
testing may run on different hosts. What the seeder may delete is decided by `seeder/ownership.ts`
alone: identities in `@test.example`, tenants named `iam-test …`, and ids recorded in the manifest
it last wrote (the only route for `google-user`). Everything else is foreign — counted, reported,
left alone. `--purge` deletes seeded identities and the manifest but not the three Hydra clients
(`browser-test-rp`, `browser-test-svc`, `browser-test-hooks`); remove those with
`DELETE /admin/clients/<id>` when wanted.

| Mode (`seeder/seed.ts`) | Effect | Local shorthand |
| --- | --- | --- |
| `--fresh` (default) | Delete the test plane's own records, then re-create them (what the gate and matrix lanes run) | `make seed-test-data-clean` |
| `--incremental` | Adopt what exists (each adopted identity gets a new random password), create what is missing, preserve TOTP secrets | — |
| `--purge` | Delete the test plane's own records and remove the manifest | `make unseed-test-data` |

```bash
# 0. Target serves an incomplete TLS chain? Complete it; never disable verification (docs/testing-spec.md §9).
curl -s http://yr1.i.lencr.org/ | openssl x509 -inform DER > /tmp/lechain.pem
curl -s http://yr.i.lencr.org/  | openssl x509 -inform DER >> /tmp/lechain.pem
export NODE_EXTRA_CA_CERTS=/tmp/lechain.pem

# 1. Seed from a host that reaches the admin APIs. KRATOS_PUBLIC_URL here is kratos
#    ITSELF (TOTP enrolment is a native flow the BFF does not serve), not the ingress.
export KRATOS_ADMIN_URL=http://127.0.0.1:4434 \
       KRATOS_PUBLIC_URL=http://127.0.0.1:4433 \
       HYDRA_ADMIN_URL=http://127.0.0.1:4445 \
       KRATOS_IDENTITY_SCHEMA_ID=social_user_v0 \
       MANIFEST=/secure/orange-manifest.json
scripts/seed-remote.sh --check     # probes only, zero mutation
scripts/seed-remote.sh             # --fresh

# 2. Test from a host with only the public ingress; KRATOS_ADMIN_URL unset selects the live lane.
LOGIN_UI_URL=https://iam.orange.canonical.com \
KRATOS_PUBLIC_URL=https://iam.orange.canonical.com \
HYDRA_PUBLIC_URL=https://iam.orange.canonical.com \
MANIFEST=/secure/orange-manifest.json \
  make test-matrix-row ROW=deployed-core-local-mfa BACKEND=urls
# or the suite alone:
cd tests/browser && MANIFEST=/secure/orange-manifest.json BROWSER_TEST_LANE=live npx playwright test

# 3. Remove exactly what was seeded, from the seeding host.
scripts/seed-remote.sh --purge
```

When nothing outside the cluster reaches the admin ports (charmed deployments), seed from inside
it; `scripts/seed-in-cluster.sh --help` documents `--mode pod|node`, `--proxy` and
`--install-toolchain`:

```bash
scripts/seed-in-cluster.sh --env teal --check    # probes only
scripts/seed-in-cluster.sh --env teal --fresh    # writes ./manifest.teal.json, 0600
scripts/seed-in-cluster.sh --env teal --purge
```

One seed serves every row of a matrix run: every scenario that mutates a seeded identity restores
it through the public settings flow in the live lane (`framework/restore.ts`), so seed once on the
MAXIMAL shape the deployment can hold (local idp + MFA + verification; identities keep their
credentials across row transitions) and loop rows with the deployment transitioned per row:

```bash
# owned charmed deployment, JIMM or a local controller; nothing seeded per row, nothing discovered
export MATRIX_JUJU_PUBLIC=1 LOGIN_UI_URL=https://<ingress> KRATOS_PUBLIC_URL=https://<ingress> \
       HYDRA_PUBLIC_URL=https://<ingress> MANIFEST=/secure/<deployment>-manifest.json
for row in tfdefault-oidc-only mx-l1m1v1wsp2t0h0u0ao; do
  make test-matrix-row ROW=$row BACKEND=juju ATTACH=1
done
```

CI form: `.github/workflows/juju-matrix.yml` (`SEED_MANIFEST` secret, `docs/ci-spec.md` §1).

## Google OIDC

The `google-oidc` Playwright project runs real Chrome (`channel: 'chrome'`, `--disable-blink-features=AutomationControlled`,
non-headless UA) because Google refuses automated Chromium; `google-chrome --version` must work.
Register the OAuth client with redirect URI `http://localhost/self-service/methods/oidc/callback/google`
and substitute its id/secret into `docker/kratos/kratos.google.yml` locally — never commit them.

Find the `sub` once: complete one Google sign-up through `/ui/register`, read
`GET /admin/identities?credentials_identifier=<email>&include_credential=oidc` →
`credentials.oidc.config.providers[].subject`, then delete that identity (the seeder creates its own
`google-user`, linked to the `sub`, whenever `GOOGLE_TEST_EMAIL` and `GOOGLE_TEST_SUBJECT_ID` are set).

```bash
export GOOGLE_TEST_EMAIL="you@canonical.com" GOOGLE_TEST_PASSWORD="…" \
       GOOGLE_TEST_TOTP_SECRET="<base32>" GOOGLE_TEST_SUBJECT_ID="<sub>"
make seed-test-data-clean
cd tests/browser && BROWSER_TEST_CAPABILITIES=../../matrix/rows/canonical-internal/capabilities.json \
  npx playwright test --project=google-oidc
```

The declared capabilities must be passed explicitly: the live `/api/v0/app-config` carries no
`oidc_providers`, so a bare invocation skips everything. One variant runs per profile:
`google-oidc-sequencing` on a sequencing shape (`canonical-internal`); `google-oidc-first-login` and
`google-oidc-session-reuse` on a non-sequencing providers=2 row (e.g. `make matrix-up ROW=mx-l0m0v0wnp2t1h1u0aj`).
