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

