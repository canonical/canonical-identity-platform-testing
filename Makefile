# Canonical Identity Platform — Test-Plane Makefile
# Brings up the platform for a profile and runs the test suites against it.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- Variables ---
PROFILE := $(shell cat .active-profile 2>/dev/null || echo core)
COMPOSE_PROJECT_NAME ?= identity-platform


COMPOSE_INFRA := docker/docker-compose.infra.yml
COMPOSE_AUTH := docker/docker-compose.auth.yml
COMPOSE_SERVICES := docker/docker-compose.services.yml
COMPOSE_PROFILE_OVERRIDE := matrix/rows/$(PROFILE)/docker-compose.override.yml
# The row's declared capabilities: the single gating source for the browser
# suite and seeder (static mode — BROWSER_TEST_CAPABILITIES).
PROFILE_CAPABILITIES := $(CURDIR)/matrix/rows/$(PROFILE)/capabilities.json

# Juju-lane substrate paths. local.auto.tfvars is gitignored — it is the ONE
# place this cluster's identity (ingress hostname, node IP, cloud) lives; both
# terraform and `make render-manifests` read it.
JUJU_MANIFESTS := matrix/backends/juju/manifests
JUJU_TFVARS := matrix/backends/juju/root/local.auto.tfvars

# Compose file list for the active profile
COMPOSE_FILES := -f $(COMPOSE_INFRA) -f $(COMPOSE_AUTH) -f $(COMPOSE_SERVICES)
ifneq (,$(wildcard $(COMPOSE_PROFILE_OVERRIDE)))
  COMPOSE_FILES += -f $(COMPOSE_PROFILE_OVERRIDE)
endif

COMPOSE := COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) docker compose $(COMPOSE_FILES)

# All gate profiles, in gate order: the pinned rows of the config matrix.
ALL_PROFILES := $(shell node -p "JSON.parse(require('fs').readFileSync('matrix/matrix.json','utf8')).rows.filter(r=>r.kind==='pinned').map(r=>r.name).join(' ')" 2>/dev/null)

# --- Targets ---
.PHONY: help profile-set profile-show profile-validate \
        up up-infra-only down logs \
        seed-test-data seed-test-data-clean unseed-test-data \
        test-e2e test-integration test-smoke \
        test-browser-typecheck test-browser-gate test-browser-unit check \
        test-browser test-browser-setup test-browser-headed test-browser-list \
        test-browser-live test-browser-internal test-browser-audit-live test-browser-profile \
        gate gate-all-profiles \
        matrix-generate matrix-test matrix-check matrix-up matrix-baseline test-matrix-row test-matrix render-manifests \
        audit-ports dev-check clean ensure-intranet

help: ## Show all available targets
	@echo "Canonical Identity Platform — Make Targets"
	@echo ""
	@echo "Usage: make <target> [VAR=value]"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

profile-set: ## Set active profile (PROFILE=<name>, a pinned matrix row)
	@if [ -z "$(PROFILE)" ]; then echo "Usage: make profile-set PROFILE=<name>"; exit 1; fi
	@case " $(ALL_PROFILES) " in \
	  *" $(PROFILE) "*) ;; \
	  *) echo "ERROR: no such profile: $(PROFILE) (pinned rows: $(ALL_PROFILES))"; exit 1;; \
	esac
	@echo "$(PROFILE)" > .active-profile
	@echo "✓ Active profile set to: $(PROFILE)"

profile-show: ## Show current profile and its declared capabilities
	@echo "Active profile: $(PROFILE)"
	@if [ -f "matrix/rows/$(PROFILE)/capabilities.json" ]; then \
	  cat "matrix/rows/$(PROFILE)/capabilities.json"; \
	else \
	  echo "(no materialized row for '$(PROFILE)' — run: make matrix-generate)"; \
	fi

profile-validate: ## Validate a profile's materialized row artifacts (PROFILE=name)
	@echo "Validating profile: $(PROFILE)"
	@ROW_DIR=matrix/rows/$(PROFILE); \
	FAIL=0; \
	[[ -f "$$ROW_DIR/docker-compose.override.yml" ]] || { echo "✗ Missing $$ROW_DIR/docker-compose.override.yml (run: make matrix-generate)"; FAIL=1; }; \
	[[ -f "$$ROW_DIR/capabilities.json" ]] || { echo "✗ Missing $$ROW_DIR/capabilities.json (run: make matrix-generate)"; FAIL=1; }; \
	if [[ -f "$$ROW_DIR/capabilities.json" ]]; then \
	  node -e "JSON.parse(require('fs').readFileSync('$$ROW_DIR/capabilities.json','utf8'))" 2>/dev/null \
	    && echo "✓ capabilities.json is valid JSON" \
	    || { echo "✗ capabilities.json is invalid JSON"; FAIL=1; }; \
	fi; \
	[[ "$$FAIL" -eq 0 ]] && echo "✓ Profile $(PROFILE) validated" || { echo "✗ Profile $(PROFILE) validation failed"; exit 1; }

# auth/services declare `intranet` external (shared with other local stacks);
# compose never creates it, so fresh machines need this once.
ensure-intranet:
	@docker network inspect intranet >/dev/null 2>&1 || docker network create intranet

up: ensure-intranet ## Spin up infra + auth + services for active profile (blocks until healthy)
	$(COMPOSE) up -d --wait
	@echo "✓ Platform running with profile: $(PROFILE)"

up-infra-only: ensure-intranet ## Spin up only infra (postgres, traefik, mailslurper, openfga) — no auth
	COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) docker compose -f $(COMPOSE_INFRA) up -d --wait
	@echo "✓ Infrastructure running (no auth services)"

down: ## Tear down everything
	$(COMPOSE) down --remove-orphans
	@echo "✓ Platform stopped"

logs: ## Tail service logs (SERVICE=<name> for specific service)
	@if [ -n "$(SERVICE)" ]; then \
	  $(COMPOSE) logs -f $(SERVICE); \
	else \
	  $(COMPOSE) logs -f; \
	fi

seed-test-data: ## Seed test data for active profile
	@echo "Seeding test data for profile: $(PROFILE)"
	cd tests/browser && npm install --silent && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx tsx seeder/seed.ts --profile $(PROFILE)

seed-test-data-clean: ## Wipe and re-seed test data for active profile (strict: any cleanup or seeding failure exits non-zero)
	@echo "Cleaning and re-seeding test data for profile: $(PROFILE)"
	cd tests/browser && npm install --silent && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx tsx seeder/seed.ts --fresh --profile $(PROFILE)

unseed-test-data: ## Delete the test plane's own users/tenants and drop the manifest (leaves any other identity on the deployment untouched)
	@echo "Purging test data for profile: $(PROFILE)"
	cd tests/browser && npm install --silent && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx tsx seeder/seed.ts --purge --profile $(PROFILE)

# -count=1 on every Go target is load-bearing, not a style choice: these suites
# drive a LIVE deployment, which is not part of go's test-cache key. Without it a
# passing result is reused across runs and across reconfigurations, so a profile
# that changed shape — or a service that is now down — still reports `ok (cached)`
# having executed nothing. That is the anti-silent-shrink hole on the Go side (C-17).
test-e2e: ## Run Go E2E tests (smoke + integration) against the running stack
	@echo "Running E2E tests for profile: $(PROFILE)"
	cd tests/e2e && COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) ACTIVE_PROFILE=$(PROFILE) \
	  E2E_USE_EXISTING_DEPLOYMENT=true go test ./... -tags=e2e -v -timeout 300s -count=1

test-integration: ## Run Go integration tests against a running stack
	@echo "Running integration tests for profile: $(PROFILE)"
	cd tests/e2e && E2E_USE_EXISTING_DEPLOYMENT=true ACTIVE_PROFILE=$(PROFILE) \
	  go test ./integration/... -tags=e2e -v -timeout 120s -count=1

test-smoke: ## Quick connectivity check
	@echo "Running smoke tests for profile: $(PROFILE)"
	cd tests/e2e && COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) ACTIVE_PROFILE=$(PROFILE) go test ./smoke/... -tags=e2e -v -count=1

test-browser-setup: ## Install browser test dependencies, Chromium and the Chrome channel
	@echo "Setting up browser test environment..."
	cd tests/browser && npm install && npx playwright install chromium chrome

test-browser: ## Run Playwright browser tests (requires running stack + seeded data)
	@echo "Running browser tests for profile: $(PROFILE)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) BROWSER_TEST_LANE=internal npx playwright test

test-browser-profile: ## Run browser tests for a specific profile (PROFILE=name)
	@echo "Running browser tests for profile: $(PROFILE)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx playwright test

test-browser-live: ## Run only live-lane compatible browser tests
	@echo "Running browser tests for profile: $(PROFILE) (lane: live)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npm run test:live

test-browser-internal: ## Run full internal-lane browser test suite
	@echo "Running browser tests for profile: $(PROFILE) (lane: internal)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npm run test:internal

test-browser-audit-live: ## Static live-lane compatibility audit for active specs
	@echo "Running live compatibility audit for browser specs"
	cd tests/browser && node scripts/audit-live-compat.mjs

test-browser-headed: ## Run Playwright browser tests with visible browser
	@echo "Running browser tests (headed) for profile: $(PROFILE)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx playwright test --headed

test-browser-list: ## List all Playwright browser tests without running them
	@echo "Listing browser tests for profile: $(PROFILE)"
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) npx playwright test --list

test-browser-typecheck: ## Typecheck the browser suite (catches helper/locator drift)
	cd tests/browser && npm install --silent && npm run --silent typecheck

test-browser-unit: ## Unit-test the suite's pure logic (satisfies() semantics) — no stack, no browser
	cd tests/browser && npm install --silent && npm run --silent test:unit

test-browser-gate: ## Run the browser suite twice; fail on any failure, flake or unjustified skip
	@echo "Running browser gate for profile: $(PROFILE)"
	@mkdir -p tests/browser/coverage
	cd tests/browser && ACTIVE_PROFILE=$(PROFILE) BROWSER_TEST_CAPABILITIES=$(PROFILE_CAPABILITIES) node scripts/gate.mjs \
	  --coverage-out coverage/$(PROFILE).json

gate: ## Full gate for one profile: typecheck, up, smoke, browser suite twice, Go E2E (PROFILE=name)
	@echo "═══ Gate: $(PROFILE) ═══"
	@$(MAKE) test-browser-typecheck
	@$(MAKE) profile-set PROFILE=$(PROFILE)
	@$(MAKE) up PROFILE=$(PROFILE)
	@$(MAKE) test-smoke PROFILE=$(PROFILE)
	@$(MAKE) test-browser-gate PROFILE=$(PROFILE)
	@$(MAKE) test-e2e PROFILE=$(PROFILE)
	@echo "✓ Gate passed: $(PROFILE)"

gate-all-profiles: ## The full gate across every profile, plus the cross-profile coverage check
	@rm -rf tests/browser/coverage
	@FAILED=""; \
	for profile in $(ALL_PROFILES); do \
	  $(MAKE) gate PROFILE=$$profile || FAILED="$$FAILED $$profile"; \
	done; \
	if [ -n "$$FAILED" ]; then echo "✗ Gate failed for:$$FAILED"; exit 1; fi; \
	echo "✓ Gate passed for all profiles: $(ALL_PROFILES)"
	@# A profile may legitimately skip what it cannot deploy, so no single
	@# profile proves the suite is alive. This does.
	cd tests/browser && node scripts/coverage-union.mjs coverage/*.json

matrix-generate: ## Regenerate the config matrix (matrix/matrix.json + matrix/rows/) from the model
	node matrix/generate.mjs

matrix-test: ## Offline tests for the matrix harness's pure logic (milliseconds, no cluster)
	node --test matrix/tests/*.test.mjs

matrix-check: matrix-test ## Verify matrix artifacts match matrix/config-model.mjs (CI guard; runs matrix-test first)
	node matrix/generate.mjs --check

# typecheck first: its npm install provisions node_modules for matrix-test's
# expected-set subprocess.
check: test-browser-typecheck matrix-check test-browser-unit audit-ports ## The whole hermetic guard: typecheck + matrix artifacts + offline tests + suite unit tests + port audit (no stack, no cluster)
	@echo "✓ hermetic checks passed (typecheck, matrix artifacts, offline harness tests, satisfies() unit tests, port audit)"

render-manifests: ## Render the juju lane's k8s manifests from root/local.auto.tfvars (envsubst; no cluster contact)
	@if [ ! -f "$(JUJU_TFVARS)" ]; then \
	  echo "ERROR: $(JUJU_TFVARS) not found — cp $(JUJU_TFVARS).example $(JUJU_TFVARS) and fill in this cluster's values"; \
	  exit 1; \
	fi
	@set -euo pipefail; \
	tfvar() { sed -n "s/^[[:space:]]*$$1[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*\$$/\1/p" "$(JUJU_TFVARS)" | tail -n1; }; \
	INGRESS_HOSTNAME="$$(tfvar ingress_hostname)"; NODE_IP="$$(tfvar node_ip)"; \
	for v in INGRESS_HOSTNAME NODE_IP; do \
	  if [ -z "$${!v}" ]; then \
	    echo "ERROR: $$v has no value in $(JUJU_TFVARS) (see $(JUJU_TFVARS).example)"; exit 1; \
	  fi; \
	done; \
	export INGRESS_HOSTNAME NODE_IP; \
	rm -rf $(JUJU_MANIFESTS)/.rendered; mkdir -p $(JUJU_MANIFESTS)/.rendered; \
	for tpl in $(JUJU_MANIFESTS)/*.yaml.tpl; do \
	  out="$(JUJU_MANIFESTS)/.rendered/$$(basename "$$tpl" .tpl)"; \
	  echo "# GENERATED by \`make render-manifests\` from $$(basename "$$tpl") — do not edit, do not commit." > "$$out"; \
	  envsubst '$$INGRESS_HOSTNAME $$NODE_IP' < "$$tpl" >> "$$out"; \
	  echo "✓ rendered $$out"; \
	done; \
	for plain in $(JUJU_MANIFESTS)/*.yaml; do \
	  cp "$$plain" $(JUJU_MANIFESTS)/.rendered/; \
	  echo "✓ copied   $(JUJU_MANIFESTS)/.rendered/$$(basename "$$plain")"; \
	done
	@echo "Apply with: kubectl apply -f $(JUJU_MANIFESTS)/.rendered/"

matrix-up: ensure-intranet ## Bring up a materialized matrix row: make matrix-up ROW=<name> (tear down with `make down`)
	@if [ -z "$(ROW)" ] || [ ! -d "matrix/rows/$(ROW)" ]; then \
	  echo "Usage: make matrix-up ROW=<name>  (rows listed in matrix/matrix.json)"; exit 1; fi
	COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) docker compose \
	  -f $(COMPOSE_INFRA) -f $(COMPOSE_AUTH) -f $(COMPOSE_SERVICES) \
	  -f matrix/rows/$(ROW)/docker-compose.override.yml up -d --wait
	@echo "✓ Platform running with matrix row: $(ROW)"

test-matrix-row: ## Deploy, verify, seed and test one matrix row: make test-matrix-row ROW=<name> [BACKEND=compose|juju|urls] [ATTACH=1] [PLAN_ONLY=1]
	node matrix/run-row.mjs $(ROW) --backend=$(or $(BACKEND),compose) $(if $(ATTACH),--attach) $(if $(PLAN_ONLY),--plan-only)

test-matrix: ## The nightly matrix lane: every seed+generated row, non-blocking failures reported at the end
	node matrix/run-row.mjs --all --backend=$(or $(BACKEND),compose)

audit-ports: ## Detect duplicate host-port publications across all profiles
	@echo "Auditing compose port mappings..."
	./scripts/audit-compose-ports.sh

dev-check: ## Verify required tools are installed (JUJU_LANE=1 also checks the charmed-lane CLIs)
	@echo "Checking required tools..."
	@command -v go >/dev/null 2>&1 || { echo "ERROR: go not found"; exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
	@command -v npx >/dev/null 2>&1 || { echo "ERROR: npx not found"; exit 1; }
	@command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }
	@docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose not found"; exit 1; }
	@echo "✓ All required tools installed"
	@if [ -n "$(JUJU_LANE)" ]; then \
	  command -v terraform >/dev/null 2>&1 || { echo "ERROR: terraform not found (JUJU_LANE=1)"; exit 1; }; \
	  command -v juju >/dev/null 2>&1 || { echo "ERROR: juju not found (JUJU_LANE=1)"; exit 1; }; \
	  echo "✓ Juju-lane tools installed"; \
	fi

matrix-baseline: ## Nightly baseline: drop compose volumes so the matrix lane starts from one deterministic state (ROW=<name> selects the override)
	@if [ -z "$(ROW)" ] || [ ! -d "matrix/rows/$(ROW)" ]; then \
	  echo "Usage: make matrix-baseline ROW=<name>  (rows listed in matrix/matrix.json)"; exit 1; fi
	@echo "Resetting compose state (down --volumes) before the matrix lane"
	-COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) docker compose \
	  -f $(COMPOSE_INFRA) -f $(COMPOSE_AUTH) -f $(COMPOSE_SERVICES) \
	  -f matrix/rows/$(ROW)/docker-compose.override.yml down --remove-orphans --volumes
	@$(MAKE) matrix-up ROW=$(ROW)

clean: ## Stop containers, drop volumes and generated test artifacts
	-$(COMPOSE) down --remove-orphans --volumes 2>/dev/null
	rm -rf tests/browser/test-results
	rm -f tests/browser/manifest.json tests/browser/active-config.json
	@echo "✓ Clean complete"
