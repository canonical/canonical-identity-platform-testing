//go:build e2e

// Package integration provides cross-service E2E tests for the Identity Platform.
// These tests run against the control repo's Docker Compose stack (started via `make up`).
//
// Prerequisites:
//   - Platform running: `make up`
//   - Set E2E_USE_EXISTING_DEPLOYMENT=true
//   - Active profile set: `make profile-set PROFILE=<name>`
//
// Environment:
//   - E2E_USE_EXISTING_DEPLOYMENT=true — required; the suite never starts a stack
//     itself, so without it there is nothing to test against and TestMain fails.
//   - E2E_ALLOW_SKIP=1 — turns that failure into an explicit exit 0, for a
//     local `go test ./...` with no stack up. CI must never set it: a skipped
//     run would otherwise be indistinguishable from a passing one.
//   - ACTIVE_PROFILE=<name> — overrides the repo's .active-profile file.
//
// Tests are profile-aware: they skip when the target service is not in the active profile.
package integration

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// serviceProfiles maps each service to the pinned profiles that deploy it.
// Derived at TestMain from the checked-in matrix artifacts — see loadServiceProfiles.
var serviceProfiles map[string][]string

// repoRoot resolves the control repo root from this source file's location.
// Deliberately not derived from the working directory: `go test ./...` runs each
// package in its own directory, and the E2E targets are invoked from both the
// repo root and tests/e2e.
func repoRoot() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot resolve the path of setup_test.go")
	}
	// tests/e2e/integration/setup_test.go -> repo root
	return filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", "..", ".."))
}

// loadServiceProfiles derives service → profiles from the generated matrix
// artifacts, so the Go suite and the browser matrix cannot disagree about what
// a profile deploys. matrix.json names the rows and their kind; each pinned
// row's capabilities.json holds the authoritative `services` list. Generated and
// seed rows are excluded: they are matrix coverage rows, not named profiles a
// developer can `make profile-set`.
func loadServiceProfiles(root string) (map[string][]string, error) {
	matrixPath := filepath.Join(root, "matrix", "matrix.json")
	raw, err := os.ReadFile(matrixPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", matrixPath, err)
	}

	var matrix struct {
		Rows []struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(raw, &matrix); err != nil {
		return nil, fmt.Errorf("parse %s: %w", matrixPath, err)
	}

	profiles := map[string][]string{}
	pinned := 0
	for _, row := range matrix.Rows {
		if row.Kind != "pinned" {
			continue
		}
		pinned++
		capPath := filepath.Join(root, "matrix", "rows", row.Name, "capabilities.json")
		capRaw, err := os.ReadFile(capPath)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", capPath, err)
		}
		var capabilities struct {
			Services []string `json:"services"`
		}
		if err := json.Unmarshal(capRaw, &capabilities); err != nil {
			return nil, fmt.Errorf("parse %s: %w", capPath, err)
		}
		if len(capabilities.Services) == 0 {
			return nil, fmt.Errorf("%s declares no services", capPath)
		}
		for _, svc := range capabilities.Services {
			profiles[svc] = append(profiles[svc], row.Name)
		}
	}
	if pinned == 0 {
		return nil, fmt.Errorf("%s declares no pinned rows", matrixPath)
	}
	return profiles, nil
}

// activeProfile reads the current profile from the environment or the repo's
// .active-profile file.
func activeProfile(root string) string {
	if p := os.Getenv("ACTIVE_PROFILE"); p != "" {
		return p
	}
	data, err := os.ReadFile(filepath.Join(root, ".active-profile"))
	if err != nil {
		return "core"
	}
	return strings.TrimSpace(string(data))
}

// serviceInProfile checks whether a service is expected in the given profile.
func serviceInProfile(service, profile string) bool {
	profiles, ok := serviceProfiles[service]
	if !ok {
		return false
	}
	for _, p := range profiles {
		if p == profile {
			return true
		}
	}
	return false
}

// requireService skips the test if the service is not in the active profile.
func requireService(t *testing.T, service string) {
	t.Helper()
	profile := activeProfile(mustRepoRoot(t))
	if !serviceInProfile(service, profile) {
		t.Skipf("service %s not in profile %s", service, profile)
	}
}

// requireServices skips the test if ANY of the services are not in the active profile.
func requireServices(t *testing.T, services ...string) {
	t.Helper()
	profile := activeProfile(mustRepoRoot(t))
	for _, svc := range services {
		if !serviceInProfile(svc, profile) {
			t.Skipf("service %s not in profile %s (required for this test)", svc, profile)
		}
	}
}

// mustRepoRoot is repoRoot for test bodies, where a failure to resolve it is fatal.
func mustRepoRoot(t *testing.T) string {
	t.Helper()
	root, err := repoRoot()
	if err != nil {
		t.Fatalf("cannot locate the repo root: %v", err)
	}
	return root
}

// envOr returns the value of the environment variable or the default.
func envOr(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

// serviceURL returns the base URL for a service using env vars with canonical defaults.
func serviceURL(service string) string {
	switch service {
	case "kratos":
		return envOr("KRATOS_PUBLIC_URL", "http://localhost:4433")
	case "hydra":
		return envOr("HYDRA_ADMIN_URL", "http://localhost:4445")
	case "hook-service":
		return envOr("HOOK_SERVICE_URL", "http://localhost:8080")
	case "tenant-service":
		return envOr("TENANT_SERVICE_URL", "http://localhost:8081")
	case "login-ui":
		return envOr("LOGIN_UI_URL", "http://localhost:8082")
	case "user-verification-service":
		return envOr("USER_VERIFICATION_URL", "http://localhost:8083")
	default:
		panic(fmt.Sprintf("unknown service: %s", service))
	}
}

func TestMain(m *testing.M) {
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot locate the repo root: %v\n", err)
		os.Exit(1)
	}

	// A run with no stack is not a pass. `go test` prints `ok` for a package
	// whose TestMain exits 0, and green-run stdout is hidden in CI — which is
	// exactly how this package reported success while running nothing.
	if os.Getenv("E2E_USE_EXISTING_DEPLOYMENT") != "true" {
		fmt.Println("Integration tests need a running platform and E2E_USE_EXISTING_DEPLOYMENT=true.")
		fmt.Println("To run against a live stack:")
		fmt.Println("  make up")
		fmt.Println("  E2E_USE_EXISTING_DEPLOYMENT=true make test-integration")
		if os.Getenv("E2E_ALLOW_SKIP") == "1" {
			fmt.Println("E2E_ALLOW_SKIP=1 — reporting the skipped run as a pass.")
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "FAIL: E2E_USE_EXISTING_DEPLOYMENT is not set (set E2E_ALLOW_SKIP=1 to skip deliberately)")
		os.Exit(1)
	}

	serviceProfiles, err = loadServiceProfiles(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot derive service profiles from the matrix artifacts: %v\n", err)
		os.Exit(1)
	}

	profile := activeProfile(root)
	fmt.Printf("Running integration tests against profile: %s\n", profile)
	os.Exit(m.Run())
}
