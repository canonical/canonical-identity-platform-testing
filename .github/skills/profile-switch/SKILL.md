# Skill: Profile Switch

## Description

Switches the active deployment profile for the Identity Platform. A profile is
a **pinned row of the configuration matrix**: it determines which services are
deployed and which capability flags they run with. Its artifacts live in
`matrix/rows/<name>/` (`docker-compose.override.yml` + `capabilities.json`) and
are generated from `matrix/config-model.mjs` — never hand-edited.

## Trigger Phrases

- "switch to profile X"
- "set profile to X"
- "activate the canonical-internal profile"
- "change deployment target"

## Available Profiles

Authoritative source: `matrix/rows/<name>/capabilities.json`. Summary today:

- `core` — Kratos, Hydra, Login UI, Dex, OpenFGA. Password + OIDC 1FA, no
  enforced MFA, no hook-service, no user-verification-service.
- `canonical-internal` — core plus `hook-service` and
  `user-verification-service`; MFA enforced (TOTP + backup codes + WebAuthn)
  and `oidc_webauthn_sequencing_enabled: true`.
- `canonical-portal` — same service set as `canonical-internal`, MFA enforced,
  but **without** OIDC/WebAuthn sequencing.

Multi-tenancy is `false` on all three (`multi_tenancy_enabled`); the
tenant-service shape is parked — see `tests/browser/known-coverage-gaps.json`.

## Steps

1. **Validate profile name:**
   `make profile-set` validates the name itself against the pinned rows and
   exits non-zero on an unknown one. To check first without switching:
   ```bash
   make profile-validate PROFILE=<profile_name>
   ```

2. **Set the active profile:**
   ```bash
   make profile-set PROFILE=<profile_name>
   ```

3. **Restart containers if running:**
   Check if containers are currently up:
   ```bash
   docker compose ps --quiet 2>/dev/null
   ```
   If containers are running, restart with the new profile:
   ```bash
   make down && make up
   ```

4. **Confirm:**
   ```bash
   make profile-show
   ```
   Prints the active profile and its declared capabilities.

## Tool Access

- File reads: `matrix/rows/<name>/capabilities.json`, `.active-profile`
- Terminal: `make profile-set`, `make profile-validate`, `make profile-show`,
  `make down`, `make up`, `docker compose ps`
