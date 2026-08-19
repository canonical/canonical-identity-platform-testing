//go:build e2e

// Package smoke provides basic connectivity tests for Identity Platform services.
// These tests verify that each service's health endpoint is reachable.
// Tests gracefully skip if services are not running.
//
// Port mapping (canonical, matches docker-compose.services.yml):
//
//	Service                Host Port  Env Var
//	kratos                 4433       KRATOS_PUBLIC_PORT
//	hydra                  4445       HYDRA_ADMIN_PORT
//	hook-service           8080       HOOK_SERVICE_PORT
//	tenant-service         8081       TENANT_SERVICE_PORT
//	login-ui               8082       LOGIN_UI_PORT
//	user-verification      8083       USER_VERIFICATION_PORT
package smoke

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// serviceEndpoint defines a service's health check target.
type serviceEndpoint struct {
	Name     string
	Port     string // environment variable name for the port
	Default  string // default host port (matches docker-compose.services.yml)
	Path     string // health check path
	Profiles []string
}

// url constructs the health check URL from env or default port.
func (ep serviceEndpoint) url() string {
	port := os.Getenv(ep.Port)
	if port == "" {
		port = ep.Default
	}
	return fmt.Sprintf("http://localhost:%s%s", port, ep.Path)
}

// endpoints lists services and their health check configuration.
// Host ports match the canonical mapping in docker-compose.services.yml.
var endpoints = []serviceEndpoint{
	{
		Name:     "kratos",
		Port:     "KRATOS_PUBLIC_PORT",
		Default:  "4433",
		Path:     "/health/alive",
		Profiles: []string{"core", "canonical-internal", "canonical-portal"},
	},
	{
		Name:     "hydra",
		Port:     "HYDRA_ADMIN_PORT",
		Default:  "4445",
		Path:     "/health/alive",
		Profiles: []string{"core", "canonical-internal", "canonical-portal"},
	},
	{
		Name:     "hook-service",
		Port:     "HOOK_SERVICE_PORT",
		Default:  "8080",
		Path:     "/api/v0/status",
		Profiles: []string{"canonical-internal", "canonical-portal"},
	},
	{
		Name:    "tenant-service",
		Port:    "TENANT_SERVICE_PORT",
		Default: "8081",
		Path:    "/api/v0/status",
		// probe() fails rather than skips for an in-profile service, so this
		// list must track the rows that actually deploy it.
		Profiles: []string{"canonical-portal"},
	},
	{
		Name: "login-ui",
		// login-ui is validated through Traefik because direct service paths on :8082
		// are base-path dependent and can legitimately return 404 in local profiles.
		Port:     "TRAEFIK_PORT",
		Default:  "80",
		Path:     "/ui/login",
		Profiles: []string{"core", "canonical-internal", "canonical-portal"},
	},
	{
		Name:     "user-verification",
		Port:     "USER_VERIFICATION_PORT",
		Default:  "8083",
		Path:     "/api/v0/status",
		Profiles: []string{"canonical-internal", "canonical-portal"},
	},
}

// activeProfile reads the current profile from the environment or .active-profile file.
func activeProfile() string {
	if p := os.Getenv("ACTIVE_PROFILE"); p != "" {
		return p
	}
	data, err := os.ReadFile("../../.active-profile")
	if err != nil {
		return "core"
	}
	return strings.TrimSpace(string(data))
}

// inProfile checks whether a service is expected in the current profile.
func inProfile(profiles []string, active string) bool {
	for _, p := range profiles {
		if p == active {
			return true
		}
	}
	return false
}

// probe GETs url, retrying until deadline. Containers can report healthy via
// their supervisor while the application itself is still crash-looping, so a
// single immediate attempt is not enough — but a service declared by the active
// profile that never answers is a failure, never a skip — skipping would let a
// crash-looping login-ui pass as "healthy".
func probe(t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	var lastErr error
	for {
		resp, err := client.Get(url)
		if err == nil {
			return resp
		}
		lastErr = err
		if time.Now().After(deadline) {
			t.Fatalf("service never became reachable at %s within 30s: %v", url, lastErr)
		}
		time.Sleep(time.Second)
	}
}

func TestServiceConnectivity(t *testing.T) {
	profile := activeProfile()
	t.Logf("Active profile: %s", profile)

	client := &http.Client{
		Timeout: 3 * time.Second,
	}

	for _, ep := range endpoints {
		ep := ep // capture
		t.Run(ep.Name, func(t *testing.T) {
			if !inProfile(ep.Profiles, profile) {
				t.Skipf("service %s not in profile %s", ep.Name, profile)
			}

			url := ep.url()
			resp := probe(t, client, url)
			defer resp.Body.Close()

			if resp.StatusCode < 200 || resp.StatusCode >= 400 {
				t.Errorf("service %s returned status %d, want 2xx/3xx", ep.Name, resp.StatusCode)
			} else {
				t.Logf("service %s healthy (status %d)", ep.Name, resp.StatusCode)
			}
		})
	}
}

func TestServiceHealthFormat(t *testing.T) {
	profile := activeProfile()
	client := &http.Client{Timeout: 3 * time.Second}

	for _, ep := range endpoints {
		ep := ep
		t.Run(fmt.Sprintf("%s_content_type", ep.Name), func(t *testing.T) {
			if !inProfile(ep.Profiles, profile) {
				t.Skipf("service %s not in profile %s", ep.Name, profile)
			}

			url := ep.url()
			resp := probe(t, client, url)
			defer resp.Body.Close()

			if ct := resp.Header.Get("Content-Type"); ct == "" {
				t.Errorf("service %s returned no Content-Type header for %s", ep.Name, url)
			}
		})
	}
}
