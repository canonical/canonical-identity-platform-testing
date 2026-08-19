# Docker Compose Configuration

This directory contains the Docker Compose files for the Canonical Identity Platform.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.infra.yml` | Infrastructure services (Postgres, OpenFGA, Traefik, Mailslurper) |
| `docker-compose.auth.yml` | Product auth core (Kratos, Hydra) |
| `docker-compose.services.yml` | Product services (hook-service, login-ui, tenant-service, etc.) |

## Port Mapping

Product service host ports are documented in `AGENTS.md`. Internal infrastructure services use offset ports to avoid collisions:

- **OpenFGA** is published on host ports `8180` (HTTP), `8181` (gRPC), and `3001` (playground). These were moved from `8080`/`8081`/`3000` to avoid collisions with `hook-service` (8080) and `tenant-service` (8081). Container-internal ports remain at `8080`/`8081`/`3000` — services on the `intranet` network continue to reference `openfga:8080`.
