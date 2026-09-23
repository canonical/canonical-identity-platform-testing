# Skill: Profile Switch

## When
"switch to profile X", "set profile to X", "change deployment target".

A profile is a pinned row of the configuration matrix: `matrix/rows/<name>/` holds its generated
`docker-compose.override.yml` and `capabilities.json` (from `matrix/config-model.mjs`; never hand-edit).

## Profiles
Authoritative source: `matrix/rows/<name>/capabilities.json`.
- `core` — Kratos, Hydra, Login UI, Dex, OpenFGA; password + OIDC 1FA, no enforced MFA.
- `canonical-internal` — core + `hook-service` + `user-verification-service`; MFA enforced
  (TOTP, backup codes, WebAuthn); `oidc_webauthn_sequencing_enabled: true`.
- `canonical-portal` — `canonical-internal`'s services + `tenant-service` (`multi_tenancy_enabled: true`);
  MFA enforced; no sequencing.
Multi-tenancy + sequencing exists on none of them (`tests/browser/known-coverage-gaps.json`).

## Commands
```bash
make profile-validate PROFILE=<name>   # optional: check the row exists and matches the model
make profile-set PROFILE=<name>        # validates against the pinned rows, writes .active-profile
docker compose ps --quiet 2>/dev/null  # containers up? then:
make down && make up
make profile-show                      # active profile + declared capabilities
```

## Success
- `make profile-show` prints the requested profile and its `capabilities.json`.
- `make profile-set` exits non-zero on an unknown name; nothing was written.
