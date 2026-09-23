# Skill: Seed Test Data

## When
"seed test data", "reset test data", "create test fixtures", before any browser run.
Creates Kratos identities (real TOTP enrolment + backup codes), Hydra OAuth2 clients
(`browser-test-rp`, `browser-test-svc`, `browser-test-hooks`) and — on `canonical-portal` only — tenants and memberships.

## Commands
```bash
make seed-test-data-clean     # wipe the test plane's own records and re-seed; strict; what the gate runs
make seed-test-data           # same behaviour today: seed.ts defaults to fresh mode when no flag is passed
make unseed-test-data         # delete the test plane's own records and the manifest, create nothing
cd tests/browser && npx tsx seeder/seed.ts --incremental --profile <name>   # adopt existing, create only what is missing
```
Fresh mode exits non-zero on any cleanup or seeding failure; incremental is lenient and preserves
prior TOTP secrets and backup codes. `MANIFEST=<path>` relocates the manifest (seeding host may
differ from the test host — `tests/browser/LANES.md`, "Seeding an Existing Deployment").

## Success
- `tests/browser/manifest.json` exists, typed by `seeder/manifest-schema.ts`: `profile`, `seededAt`,
  `users[]` (ref, email, identityId, totpSecret), `tenants[]`, `memberships[]`, `oauthClients`.
- Every MFA user has a non-null `totpSecret`; the seeder fails otherwise.

## Invariants
- `tests/browser/seeder/archetypes.ts` is the sole source of users; the seeder never imports scenario files.
  A scenario naming an unknown `user.ref` fails at lookup. New kind of user → new archetype, never a spec.
- The seeder owns all admin-API access; specs are browser-only and read the manifest.
- Deletion is scoped by `seeder/ownership.ts` (`@test.example`, `iam-test ` tenants, manifest ids); foreign
  records are counted, reported and left alone.
