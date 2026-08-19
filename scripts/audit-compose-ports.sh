#!/usr/bin/env bash
# scripts/audit-compose-ports.sh — Detect duplicate host-port publications
# across all profile combinations of docker-compose files.
#
# Usage: ./scripts/audit-compose-ports.sh [--json]
#
# Exit codes:
#   0 — no collisions detected
#   1 — one or more collisions detected
#   2 — usage error or missing tools
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

JSON_OUTPUT=false
if [[ "${1:-}" == "--json" ]]; then
  JSON_OUTPUT=true
fi

COMPOSE_INFRA="$ROOT_DIR/docker/docker-compose.infra.yml"
COMPOSE_SERVICES="$ROOT_DIR/docker/docker-compose.services.yml"

# Check for required tools
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found" >&2
  exit 2
fi
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq not found (install with: apt install jq / brew install jq)" >&2
  exit 2
fi

# Collect the gate profile names: the pinned rows of the config matrix.
PROFILES=()
while IFS= read -r profile_name; do
  [[ -z "$profile_name" ]] && continue
  PROFILES+=("$profile_name")
done < <(node -p "JSON.parse(require('fs').readFileSync('$ROOT_DIR/matrix/matrix.json','utf8')).rows.filter(r=>r.kind==='pinned').map(r=>r.name).join('\n')")

if [[ ${#PROFILES[@]} -eq 0 ]]; then
  echo "ERROR: no pinned rows found in matrix/matrix.json (run: make matrix-generate)" >&2
  exit 2
fi

# For each profile, run docker compose config and extract published host ports
# Then check for duplicates within that profile's compose combination
COLLISIONS=()

for profile in "${PROFILES[@]}"; do
  OVERRIDE="$ROOT_DIR/matrix/rows/$profile/docker-compose.override.yml"

  # Build compose file arguments
  COMPOSE_FILES=(-f "$COMPOSE_INFRA" -f "$COMPOSE_SERVICES")
  if [[ -f "$OVERRIDE" ]]; then
    COMPOSE_FILES+=(-f "$OVERRIDE")
  fi

  # Use docker compose config to render the full compose YAML for this profile
  # and extract port mappings with jq
  PORTS_JSON=$(COMPOSE_PROJECT_NAME="audit-$profile" docker compose \
    "${COMPOSE_FILES[@]}" config --format json 2>/dev/null | \
    jq -r '
      .services // {} | to_entries[] |
      .key as $svc |
      (.value.ports // [])[] |
      if .published then
        "\(.published):\($svc)"
      elif (type == "string" and contains(":")) then
        (split(":")[0] | tostring) + ":\($svc)"
      elif (type == "number") then
        "\(.)" + ":\($svc)"
      else
        empty
      end
    ' 2>/dev/null || echo "")

  # Check for duplicate host ports within this profile
  PORT_LIST=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    PORT_LIST+=("$line")
  done <<< "$PORTS_JSON"

  # Sort and find duplicates within this profile
  DUPES=$(printf '%s\n' "${PORT_LIST[@]}" | \
    awk -F: '{print $1}' | sort | uniq -d)

  for dup_port in $DUPES; do
    [[ -z "$dup_port" ]] && continue
    # Find all services using this port
    SVC_LIST=$(printf '%s\n' "${PORT_LIST[@]}" | \
      awk -F: -v port="$dup_port" '$1 == port {print $2}' | tr '\n' ',' | sed 's/,$//')
    COLLISIONS+=("$dup_port:$SVC_LIST:$profile")
  done
done

# Report results
if [[ "$JSON_OUTPUT" == "true" ]]; then
  if [[ ${#COLLISIONS[@]} -eq 0 ]]; then
    echo '{"status":"pass","collisions":[]}'
  else
    # Build JSON array of collisions
    COLLISION_JSON=$(printf '%s\n' "${COLLISIONS[@]}" | jq -R -s '
      split("\n") | map(select(length > 0)) |
      map(split(":") as $parts |
        {port: $parts[0], services: ($parts[1:] | join(":"))}
      )
    ')
    echo "{\"status\":\"fail\",\"collisions\":$COLLISION_JSON}"
  fi
else
  if [[ ${#COLLISIONS[@]} -eq 0 ]]; then
    echo "✓ No host-port collisions detected across ${#PROFILES[@]} profiles"
  else
    echo "✗ Host-port collisions detected:"
    for collision in "${COLLISIONS[@]}"; do
      port="${collision%%:*}"
      details="${collision#*:}"
      echo "  Port $port: $details"
    done
    exit 1
  fi
fi
