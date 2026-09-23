//go:build e2e

// Package harness is the shared ground truth for the Go E2E suites: which
// services the active profile deploys and where the compose stack publishes
// them, read from the same matrix artifacts the browser suite uses.
package harness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Service names exactly as matrix/rows/<row>/capabilities.json declares them.
const (
	Kratos           = "kratos"
	Hydra            = "hydra"
	LoginUI          = "login-ui"
	Dex              = "dex"
	OpenFGA          = "openfga"
	HookService      = "hook-service"
	TenantService    = "tenant-service"
	UserVerification = "user-verification-service"
)

// Profile is a matrix row and the services its capabilities.json declares.
type Profile struct {
	Name     string
	Services []string
}

// Has reports whether the profile deploys the named service.
func (p Profile) Has(service string) bool {
	for _, s := range p.Services {
		if s == service {
			return true
		}
	}
	return false
}

// RepoRoot resolves the repo root from this source file, not the working
// directory: `go test ./...` runs each package in its own directory.
func RepoRoot() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot resolve the path of harness/profile.go")
	}
	return filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".."))
}

// ActiveProfile reads the profile name from ACTIVE_PROFILE (as the Makefile
// sets it) or the repo's .active-profile file, defaulting to core.
func ActiveProfile(root string) string {
	if p := os.Getenv("ACTIVE_PROFILE"); p != "" {
		return p
	}
	data, err := os.ReadFile(filepath.Join(root, ".active-profile"))
	if err != nil {
		return "core"
	}
	return strings.TrimSpace(string(data))
}

// Load resolves the active profile and its declared services from
// matrix/rows/<profile>/capabilities.json, the same file the Makefile hands
// the browser suite as BROWSER_TEST_CAPABILITIES.
func Load() (Profile, error) {
	root, err := RepoRoot()
	if err != nil {
		return Profile{}, err
	}
	name := ActiveProfile(root)
	capPath := filepath.Join(root, "matrix", "rows", name, "capabilities.json")
	raw, err := os.ReadFile(capPath)
	if err != nil {
		return Profile{}, fmt.Errorf("profile %q has no matrix row: %w", name, err)
	}
	var capabilities struct {
		Services []string `json:"services"`
	}
	if err := json.Unmarshal(raw, &capabilities); err != nil {
		return Profile{}, fmt.Errorf("parse %s: %w", capPath, err)
	}
	if len(capabilities.Services) == 0 {
		return Profile{}, fmt.Errorf("%s declares no services", capPath)
	}
	return Profile{Name: name, Services: capabilities.Services}, nil
}

// MustLoad is Load for test bodies, where failing to resolve the profile is fatal.
func MustLoad(t testing.TB) Profile {
	t.Helper()
	p, err := Load()
	if err != nil {
		t.Fatalf("cannot resolve the active profile: %v", err)
	}
	return p
}
