# Skill: Seed Test Data

## Name
seed-test-data

## Description
Seed deterministic test data for the active deployment profile. Creates Kratos
identities with real TOTP enrolment and backup codes, Hydra OAuth2 clients, and
tenants plus memberships when the profile includes `tenant-service` — which no
profile does today (`multi_tenancy_enabled` is `false` on all three), so the
tenant/membership arrays come back empty.

## Trigger Phrases
- "seed test data"
- "create test fixtures"
- "set up test data for profile X"
- "reset test data"

## Workflow

1. Determine the active profile (from `.active-profile` or `--profile <name>`).
2. Run the TypeScript seeder:
   ```bash
   make seed-test-data-clean     # wipe and re-seed (strict; what the gate runs)
   make seed-test-data           # same thing — see the note below
   ```
   They delegate to `cd tests/browser && npx tsx seeder/seed.ts [--fresh] --profile <name>`.

   > **Both make targets seed fresh.** `seed.ts` defaults to `mode = "fresh"`
   > when no mode flag is passed, and `make seed-test-data` passes none — so
   > the two targets are behaviourally identical today. For a genuinely
   > incremental seed, invoke the flag directly:
   > `cd tests/browser && npx tsx seeder/seed.ts --incremental --profile <name>`.

3. The seeder writes `tests/browser/manifest.json` — the only contract between
   provisioning and the specs.

## Which users get created
`tests/browser/seeder/archetypes.ts` is the **sole source of truth**. It is deliberately
independent of scenario definitions: the seeder never imports scenario files. A scenario
that references an unknown `user.ref` fails loudly at lookup time.

Each archetype declares its credentials (password / TOTP / backup codes / OIDC link),
verification state, and tenant count. To make a new kind of user available to scenarios,
add an archetype — do not provision from inside a spec.

## Output
`tests/browser/manifest.json`, typed by `tests/browser/seeder/manifest-schema.ts`:
```json
{
  "profile": "canonical-portal",
  "seededAt": "...",
  "users": [{"ref": "returning-mfa", "email": "...", "identityId": "...", "totpSecret": "..."}],
  "tenants": [{"ref": "alpha", "name": "Alpha Inc", "id": "..."}],
  "memberships": [{"userRef": "multi-tenant-user", "tenantRef": "alpha", "role": "owner"}],
  "oauthClients": {"rp": {...}, "svc": {...}}
}
```

## Invariants
- The seeder owns **all** admin-API access. Specs are browser-only and read the manifest.
- TOTP is enrolled for real through the public settings flow, not injected — so the
  secrets in the manifest are usable by the tests.
- `--incremental` preserves existing TOTP secrets and backup codes from the prior manifest.
- Hydra clients (`browser-test-rp`, `browser-test-svc`) are upserted deterministically so
  the `oidc-consumer` container can boot before seeding runs.

## Make Targets
- `make seed-test-data` — seed the active profile (fresh; no mode flag passed)
- `make seed-test-data-clean` — explicit `--fresh` wipe and re-seed
