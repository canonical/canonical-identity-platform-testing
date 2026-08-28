# Browser Test Lanes

This directory supports two execution lanes:

- live: run only scenarios compatible with externally exposed login-ui/OIDC surfaces.
- internal: run full suite behavior for internal/lab environments.

## Environment Variables

- BROWSER_TEST_LANE
  - live or internal
  - default: internal
- BROWSER_DISABLE_LANE_ENFORCEMENT
  - true disables lane compatibility gating (rollback toggle)
  - default: false
- WEBAUTHN_ENABLED
  - true/false runtime toggle for WebAuthn-required scenarios
  - default: true
- GOOGLE_TEST_EMAIL
  - Google Workspace email for Google OIDC browser tests
  - required for google-oidc spec
- GOOGLE_TEST_PASSWORD
  - Google Workspace password for Google OIDC browser tests
  - required for google-oidc spec
- GOOGLE_TEST_TOTP_SECRET
  - Base32 TOTP secret for Google 2FA (exported from authenticator app)
  - required for google-oidc spec
- GOOGLE_TEST_SUBJECT_ID
  - Google OIDC `sub` claim (the Google account's unique numeric ID)
  - required for google-oidc spec (used to pre-register the identity in Kratos)
  - discover once by completing a Google login and reading the `sub` from the Kratos identity
- GOOGLE_CLIENT_ID
  - Google OAuth2 client ID (set in Kratos config, not env var; the committed value is a placeholder - substitute a real one locally)
- GOOGLE_CLIENT_SECRET
  - Google OAuth2 client secret (same: committed placeholder, substitute locally, never commit)

## Commands

From repository root:

- make test-browser-live
- make test-browser-internal
- make test-browser-audit-live

From tests/browser:

- npm run test:live
- npm run test:internal
- npm run audit:live

## Lane Expectations

live lane:
- excludes internal-only specs/scenarios marked with lane metadata.
- avoids direct runtime usage of internal flow bootstrap endpoints.
- relies on externally reachable login/ui and OIDC/Hydra public surfaces.

internal lane:
- preserves full existing suite behavior for internal test stacks.
- includes email-dependent and internal endpoint dependent flows.

## Notes

- Use audit:live to catch unsupported patterns in active specs.
- If rollout issues occur, set BROWSER_DISABLE_LANE_ENFORCEMENT=true temporarily while investigating.
- The OIDC consumer (port 4446) is now part of the base stack and is brought up by `make up` for every profile.

## Google OIDC Tests

Google OIDC tests require special browser configuration to bypass Google's bot detection:

### Chrome Requirement

Google blocks automated Chromium with "This browser or app may not be secure."
The `google-oidc` Playwright project uses real Chrome (`channel: 'chrome'`) instead
of the default Chromium. Chrome must be installed on the test machine:

```bash
google-chrome --version
# If not installed: sudo apt install google-chrome-stable
```

### Anti-Detection Configuration

The `google-oidc` Playwright project applies:

- `channel: 'chrome'` — uses the real Chrome binary, not Chromium
- `--disable-blink-features=AutomationControlled` — removes `navigator.webdriver` flag
- Realistic user agent string — replaces default `HeadlessChrome/X.X` UA

These are configured in `playwright.config.ts` under the `google-oidc` project.

### Redirect URI

To register a Google OAuth2 client in Google Cloud Console, use this redirect URI:

```
http://localhost:4433/self-service/methods/oidc/callback/google
```

### Running Google OIDC Tests

```bash
# Set credentials
export GOOGLE_TEST_EMAIL="your-email@canonical.com"
export GOOGLE_TEST_PASSWORD="your-password"
export GOOGLE_TEST_TOTP_SECRET="your-base32-totp-secret"
export GOOGLE_TEST_SUBJECT_ID="your-google-sub-claim"

# Run only Google OIDC tests
npx playwright test --project=google-oidc

# Run against the canonical-internal profile's declared capabilities
BROWSER_TEST_CAPABILITIES=../../matrix/rows/canonical-internal/capabilities.json npx playwright test --project=google-oidc
```

### Identity Registration

Google OIDC tests register a Kratos identity in `beforeAll` via the admin API
(using `createIdentityWithOIDC` with the Google `sub`). This makes the
identifier-first flow show the "Sign in with Google" button. The identity is
cleaned up in `afterAll`. Registration is idempotent — if the identity already
exists (matched by email), it is reused.

## First Live Smoke Baseline

Initial live-lane mandatory scenario IDs:

- login:first-login-mfa
- login:returning-login-mfa
- login:wrong-password
- session:session-reuse-no-max-age
- oidc:oidc-dex-login
- tenant:single-tenant-auto-select
- error:invalid-totp-code

Internal-only (excluded from first live smoke):

- recovery:* (email code dependency)
- verification:* (email code dependency)
- registration:* (internal bootstrap dependency)
- use-backup-codes.spec.ts (runtime admin API dependency)

## Deployment Configuration

One declaration system drives gating (docs/testing-spec.md). In static mode — the gate and matrix lanes — `BROWSER_TEST_CAPABILITIES` points at a materialized row's `capabilities.json` (`matrix/rows/<row>/`, exported by the Makefile targets); the declaration IS the configuration. Without it, the runner falls back to discovery: `globalSetup` queries the login-ui's `/api/v0/app-config` endpoint and caches the result in `active-config.json`.

Tests use this configuration to:
1. Gate every scenario on its `requires:` block via `satisfies()` — unconditionally. This is the ONLY gating predicate: there is no `BROWSER_TEST_ENFORCE_REQUIRES` switch and no legacy `checkRequires` fallback (both removed; the legacy path enforced 5 of 13 keys and warn-only ignored the rest).
2. Resolve capability lookups (`isServiceInProfile`, `isMfaEnforced`, `localUsersEnabled`, ...) in `helpers/config.ts` — there are no static per-profile fallback tables; keys `/api/v0/app-config` omits (PD-5) are covered by the row's declared capabilities file.

## Seeding an Existing Deployment (out of band)

The suite reads identities from a seed manifest; it never calls an admin API
itself. Seeding and testing therefore do not have to happen on the same host,
which is what makes a pre-existing deployment testable.

### What the seeder may delete

`seeder/ownership.ts` is the only thing that authorises a delete. A record is
the test plane's iff:

- **namespace** — the identity's email is in `@test.example` (reserved by
  RFC 2606 §3, so it can never be a real address), or the tenant's name starts
  with `iam-test `; or
- **provenance** — its id appears in the manifest this test plane last wrote.
  This is the only route for `google-user`, whose email is the operator's real
  Workspace account and is never inferred from the address alone.

Everything else is foreign: it is counted, reported, and left alone. Both
`--fresh` and `--purge` print `left N pre-existing identit(ies) untouched`.

### Modes

|Mode|Effect|
|---|---|
|`--fresh`|Delete the test plane's own records, then re-create them. What the gate and matrix lanes run.|
|`--incremental`|Adopt whatever already exists, create only what is missing, preserve TOTP secrets.|
|`--purge`|Delete the test plane's own records and remove the manifest. Nothing is re-created.|

### Admin workflow

```bash
# On a host that can reach the admin APIs:
cd tests/browser
export KRATOS_ADMIN_URL=https://kratos-admin.internal \
       HYDRA_ADMIN_URL=https://hydra-admin.internal \
       BROWSER_TEST_CAPABILITIES=../../matrix/rows/<row>/capabilities.json
MANIFEST=/secure/iam-test-manifest.json npx tsx seeder/seed.ts --fresh --profile <row>

# Hand the manifest to the test host, which needs only the public login-ui:
MANIFEST=/secure/iam-test-manifest.json BROWSER_TEST_LANE=live npm run test:live

# When finished, remove exactly what was seeded:
MANIFEST=/secure/iam-test-manifest.json npx tsx seeder/seed.ts --purge --profile <row>
```

#### The identity schema is NOT `default` on a real deployment

`KRATOS_IDENTITY_SCHEMA_ID` (default `default`) names the schema every seeded
identity is created under, and a charmed deployment ships its own set — ask it,
never assume:

```bash
curl -s https://<host>/schemas | jq -r '.[].id'
# iam.orange.canonical.com -> social_user_v0, admin_v0   (no "default")
```

Pass the human-user schema (`KRATOS_IDENTITY_SCHEMA_ID=social_user_v0` there).
The seeder writes traits `email`, `name`, `surname`; a schema that requires only
`email` and does not set `additionalProperties: false` — both of the above —
accepts them unchanged.

`MANIFEST=<path>` overrides the manifest location for the seeder and the suite
alike; unset, both use `tests/browser/manifest.json`. `make unseed-test-data`
is the local shorthand for the purge step.

The manifest carries seeded passwords and TOTP secrets. Treat it as a secret:
it is gitignored, and on a real deployment it is credential material.

### Running without any admin access

With no manifest at all, scenarios that a lane or capability already excludes
skip normally — gating happens before the manifest is read. Scenarios that do
run still need a seeded user, so supply a manifest via `MANIFEST=<path>`; the
`urls` matrix backend without `KRATOS_ADMIN_URL` is exactly this case.

A manifest-less run does not touch the deployment at all: the scenario runner
needs the seeded user before it opens a page, so it fails in fixture setup
("Manifest file not found", or "totpSecret is null" against a stale manifest
from another stack). Point `MANIFEST` at the right file — or delete the stale
one — rather than reading those failures as deployment problems.

### Worked example: iam.orange.canonical.com

The whole contract for one live deployment, no substrate access, using the row
that matches its shape (`matrix/rows/deployed-core-local-mfa`):

```bash
# 0. This target serves an incomplete TLS chain (leaf only). Complete it —
#    do not disable verification (docs/testing-spec.md §9).
curl -s http://yr1.i.lencr.org/ | openssl x509 -inform DER > /tmp/lechain.pem
curl -s http://yr.i.lencr.org/  | openssl x509 -inform DER >> /tmp/lechain.pem
export NODE_EXTRA_CA_CERTS=/tmp/lechain.pem

# 1. Seed, on a host that can reach the admin APIs (port-forward, bastion, …).
#    KRATOS_PUBLIC_URL here must be kratos ITSELF, not the ingress: TOTP
#    enrolment is a native flow and the BFF serves no native API. The script
#    proves that (and the schema id) before it writes anything; --check stops
#    after the probes.
export KRATOS_ADMIN_URL=http://127.0.0.1:4434 \
       KRATOS_PUBLIC_URL=http://127.0.0.1:4433 \
       HYDRA_ADMIN_URL=http://127.0.0.1:4445 \
       KRATOS_IDENTITY_SCHEMA_ID=social_user_v0 \
       MANIFEST=/secure/orange-manifest.json
scripts/seed-remote.sh --check     # prerequisites only, zero mutation
scripts/seed-remote.sh             # --fresh

# 2. Run the row's full contract from a host with only the public ingress.
LOGIN_UI_URL=https://iam.orange.canonical.com \
KRATOS_PUBLIC_URL=https://iam.orange.canonical.com \
HYDRA_PUBLIC_URL=https://iam.orange.canonical.com \
MANIFEST=/secure/orange-manifest.json \
  make test-matrix-row ROW=deployed-core-local-mfa BACKEND=urls

# 3. Remove exactly what was seeded, from the seeding host.
scripts/seed-remote.sh --purge
```

Note that `KRATOS_PUBLIC_URL` means two different things in the two steps, and
both are correct: kratos's own API for seeding (native flows), the public ingress
for testing (what a browser gets). Leaving `KRATOS_ADMIN_URL` unset in step 2 is
deliberate — it is what selects the live lane (11 tier-A executions on this row)
and keeps the run incapable of mutating the deployment.


### Seeding from inside the cluster (`scripts/seed-in-cluster.sh`)

Step 1 above assumes something already reaches the admin APIs. On a charmed
deployment nothing outside the cluster does: the ingress publishes only the
public surfaces, so kratos's 4434 and hydra's 4445 exist on the pod network
alone. `scripts/seed-in-cluster.sh` is that transport — it bootstraps a seeding
host inside the deployment and then delegates to `scripts/seed-remote.sh`,
which still owns every prerequisite probe.

Run it from a checkout on a node of the deployment's k8s cluster (anything with
kubectl access to the namespace):

```bash
# Probes only. No identity, no client, no host package touched.
scripts/seed-in-cluster.sh --env teal --check

# Seed. Writes ./manifest.teal.json, 0600.
scripts/seed-in-cluster.sh --env teal --fresh

# Afterwards, from the same host.
scripts/seed-in-cluster.sh --env teal --purge
```

`--env <colour>` is the only required knowledge: the namespace defaults to
`<colour>-iam` (juju names the namespace after the model) and the handoff text
to `iam.<colour>.canonical.com`. `--row` defaults to `deployed-core-local-mfa`,
the charmed-core shape.

Two modes, and the default is the one that leaves nothing behind:

|Mode|What it needs|What it touches|
|---|---|---|
|`--mode pod` (default)|the cluster can pull `node:22-bookworm`|one throwaway pod in the namespace, deleted on exit — nothing on the node|
|`--mode node`|node ≥ 20 **already on the host**, `kubectl port-forward`|nothing, unless you pass `--install-toolchain`|

A snap on a production k8s node outlives the run, so node mode never installs
one implicitly: without `--install-toolchain` it aborts naming both remedies.
That is also what makes `--check` traceless on the *host* and not merely on the
deployment — pod mode's own pod is the single object either mode creates.

Pod mode talks to the kratos and hydra **pod IPs**, not the `kratos` ClusterIP
service: juju's generated service publishes only the ports the charm declares
and the admin port is not always among them, while a pod IP always carries
every port its container listens on.

**The pod runs your checkout, not a clone of it.** The working tree is streamed
in over `kubectl exec … tar -xzf -`, so the pod needs no git, no pushed ref and
no egress: `tests/browser/node_modules` rides along when it exists here, and
`npm install` inside the pod is then a proven no-op — it makes no registry call
at all on a complete tree. Two paths are excluded because they are secrets, not
because they are large: `*.tfstate*` (the juju root manages `juju_secret`, and
terraform stores secret values in cleartext) and `tests/browser/manifest.json`
(a previous seed's passwords and TOTP secrets).

**A pod is not covered by the node's transparent proxy.** On prodstack the
nftables DNAT that gives a node its egress excludes the pod CIDR, so a pod
reaching `registry.npmjs.org` simply times out (measured on teal). Two ways out,
and the script takes both:

- it discovers the node's own egress proxy — `$HTTPS_PROXY`, else the
  `snapd`/`snap.k8s.containerd` drop-ins cloud-init wrote, else
  `/etc/apt/apt.conf.d/99proxy` — and bakes it into the pod's environment.
  `--proxy <url>` overrides;
- and when the checkout carries no `node_modules`, it **proves** the pod can
  reach the registry (`npm ping`) before seeding. That check exists because the
  alternative was observed: a green `--check`, then `ETIMEDOUT` from `npm
  install` *after* `--fresh` had already deleted the previous identities.

A node with no egress at all needs nothing special — run `npm install` in
`tests/browser` where there *is* egress, `scp` the whole checkout over, and the
pod makes no network call beyond the cluster.

Neither mode guesses the identity schema — it reads `/schemas` off kratos and
picks `default` when served, else the single non-admin schema, else refuses and
names what it saw (`KRATOS_IDENTITY_SCHEMA_ID` overrides).

### What seeding a real deployment leaves behind

Both halves are scoped by `seeder/ownership.ts`, but "scoped" is not "nothing":

- **~15 identities** in `@test.example`, each with a password and most with a
  TOTP secret (`seeder/archetypes.ts` is the exact list). `--purge` deletes them.
- **3 Hydra OAuth2 clients** — `browser-test-rp`, `browser-test-svc`,
  `browser-test-hooks` (`seeder/clients.ts`). `--purge` does **not** delete
  these: they are upserted by fixed id, carry no user data, and a deployment may
  still be serving them. Remove them by hand when you want them gone:
  `DELETE /admin/clients/browser-test-rp` and the other two.
- The **manifest** on the seeding host: seeded passwords and TOTP secrets, 0600.
  Move it off and `shred -u` the copy.

