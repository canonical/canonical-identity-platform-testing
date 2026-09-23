# Skill: Spin Up Platform

## When
"spin up the platform", "bring up the stack", "start services for profile X", "make up".

Brings up infrastructure (Postgres, Traefik, Mailslurper, OpenFGA) plus the auth and app services
of a profile. A profile is a pinned matrix row (`core`, `canonical-internal`, `canonical-portal`);
its compose override and `capabilities.json` in `matrix/rows/<name>/` are generated from
`matrix/config-model.mjs` — never edit a row by hand.

## Commands
```bash
make dev-check                         # toolchain (go, node, npx, docker compose); no service repos to clone
make profile-set PROFILE=<name>        # optional; validates the name, writes .active-profile
make profile-validate PROFILE=<name>   # row present and matching the model? else: make matrix-generate && make matrix-check
make up                                # blocks until healthy; make up-infra-only for postgres/traefik/mailslurper/openfga alone
make test-smoke
docker compose ps && make profile-show
```
Teardown: `make down` (stop) or `make clean` (also drop volumes and generated test artifacts).

## Success
- `make up` prints `✓ Platform running with profile: <name>` and `make test-smoke` passes.
- `docker compose ps` shows every service the profile declares as healthy.

## Other substrates
The same row runs on Juju or against an existing deployment through the matrix lane:
`make test-matrix-row ROW=<name> [BACKEND=compose|juju|urls]` — `docs/testing-spec.md` §4.

## Related
`profile-switch`, `seed-test-data`, `run-e2e`.
