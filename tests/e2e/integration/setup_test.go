//go:build e2e

// Package integration provides cross-service E2E tests against the compose stack (`make up`).
//
//   - E2E_USE_EXISTING_DEPLOYMENT=true — required; the suite never starts a stack.
//   - E2E_ALLOW_SKIP=1 — turns that failure into exit 0 for a local run with no
//     stack. CI must never set it: a skipped run would look like a pass.
//   - ACTIVE_PROFILE=<name> — overrides the repo's .active-profile file.
//
// Tests skip when the target service is not declared by the active profile.
package integration

import (
	"fmt"
	"os"
	"testing"

	"github.com/canonical/canonical-identity-platform/tests/e2e/internal/harness"
)

// active is the profile under test, resolved once in TestMain.
var active harness.Profile

// requireService skips the test if the service is not in the active profile.
func requireService(t *testing.T, service string) {
	t.Helper()
	if !active.Has(service) {
		t.Skipf("service %s not in profile %s", service, active.Name)
	}
}

// envOr returns the value of the environment variable or the default.
func envOr(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func TestMain(m *testing.M) {
	// A run with no stack is not a pass: `go test` prints `ok` for a TestMain that exits 0.
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

	var err error
	active, err = harness.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot resolve the active profile: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Running integration tests against profile: %s\n", active.Name)
	os.Exit(m.Run())
}
