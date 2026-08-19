# Skill: Spin Up Platform

## Description

Spins up the full Identity Platform stack for a given deployment profile.
Includes infrastructure (Postgres, Traefik, Mailslurper, OpenFGA) plus the
auth and app services enabled by the profile's compose override.

A **profile** is a pinned row of the configuration matrix. Its two artifacts —
`matrix/rows/<name>/docker-compose.override.yml` and
`matrix/rows/<name>/capabilities.json` — are **generated** from
`matrix/config-model.mjs` by `make matrix-generate`. There is no hand-written
profile config; never edit a row by hand.

Pinned profiles: `core`, `canonical-internal`, `canonical-portal`.

## Trigger Phrases

- "spin up the platform"
- "start the platform"
- "bring up the stack"
- "start services for profile X"
- "make up"

## Steps

1. **Check the toolchain:**
   ```bash
   make dev-check
   ```
   Verifies the required tools are installed. (There are no service repos to
   clone — every service runs from a published image or this tree.)

2. **Set the profile (if specified):**
   ```bash
   make profile-set PROFILE=<profile_name>
   ```
   This validates the name against the pinned rows and writes
   `.active-profile`. If no profile is specified, the current active profile
   is used.

3. **Confirm the row artifacts exist and match the model:**
   ```bash
   make profile-validate PROFILE=<profile_name>
   ```
   If the row is missing or has drifted, regenerate it:
   ```bash
   make matrix-generate && make matrix-check
   ```

4. **Start the platform:**
   ```bash
   make up
   ```
   Brings up infrastructure and services per the active profile's generated
   compose override, and blocks until healthy.
   (`make up-infra-only` brings up just postgres/traefik/mailslurper/openfga.)

5. **Wait for health / verify connectivity:**
   ```bash
   make test-smoke
   ```

6. **Report status:**
   ```bash
   docker compose ps
   make profile-show      # active profile + its declared capabilities
   ```
   Confirm all expected services are running and healthy.

## Teardown

```bash
make down     # stop everything
make clean    # also drop volumes and generated test artifacts
```

## Non-compose substrates

A profile is also a matrix row, so the same shape can be brought up on Juju or
pointed at an existing deployment. That is the matrix lane's job, not this
skill's — see `docs/testing-spec.md` §4 and
`make test-matrix-row ROW=<name> [BACKEND=compose|juju|urls]`.

## Tool Access

- Terminal: `make dev-check`, `make profile-set`, `make profile-validate`,
  `make profile-show`, `make matrix-generate`, `make matrix-check`, `make up`,
  `make up-infra-only`, `make down`, `make clean`, `make test-smoke`,
  `docker compose ps`
- File reads: `matrix/rows/<name>/capabilities.json`,
  `matrix/rows/<name>/docker-compose.override.yml`, `.active-profile`
