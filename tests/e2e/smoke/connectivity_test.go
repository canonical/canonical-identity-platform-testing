//go:build e2e

// Package smoke probes the health endpoint of every service the active
// profile declares (matrix/rows/<profile>/capabilities.json). A declared
// service that never answers is a failure, never a skip.
package smoke

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/canonical/canonical-identity-platform/tests/e2e/internal/harness"
)

// healthProbe is the health-check target for one declared service.
type healthProbe struct {
	Endpoint harness.Endpoint
	Path     string
}

func (p healthProbe) url() string {
	return p.Endpoint.URL() + p.Path
}

// probes maps every service the matrix can declare to its health check. A
// declared service missing here fails the run: a probe must be added before a
// new service counts as covered.
var probes = map[string]healthProbe{
	harness.Kratos:           {harness.KratosPublic, "/health/alive"},
	harness.Hydra:            {harness.HydraAdmin, "/health/alive"},
	harness.LoginUI:          {harness.LoginUIHTTP, "/ui/login"},
	harness.Dex:              {harness.DexHTTP, "/dex/.well-known/openid-configuration"},
	harness.OpenFGA:          {harness.OpenFGAHTTP, "/healthz"},
	harness.HookService:      {harness.HookServiceHTTP, "/api/v0/status"},
	harness.TenantService:    {harness.TenantServiceHTTP, "/api/v0/status"},
	harness.UserVerification: {harness.UserVerificationHTTP, "/api/v0/status"},
}

// activeProfile loads the active profile and checks every declared service
// has a probe.
func activeProfile(t *testing.T) harness.Profile {
	t.Helper()
	profile := harness.MustLoad(t)
	for _, svc := range profile.Services {
		if _, ok := probes[svc]; !ok {
			t.Fatalf("profile %s declares service %q, which has no health probe", profile.Name, svc)
		}
	}
	return profile
}

// probe GETs url, retrying until deadline. Containers can report healthy via
// their supervisor while the application itself is still crash-looping, so a
// single immediate attempt is not enough.
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
	profile := activeProfile(t)
	t.Logf("Active profile: %s", profile.Name)

	client := &http.Client{Timeout: 3 * time.Second}

	for _, svc := range profile.Services {
		t.Run(svc, func(t *testing.T) {
			url := probes[svc].url()
			resp := probe(t, client, url)
			defer resp.Body.Close()

			if resp.StatusCode < 200 || resp.StatusCode >= 400 {
				t.Errorf("service %s returned status %d, want 2xx/3xx", svc, resp.StatusCode)
			} else {
				t.Logf("service %s healthy (status %d)", svc, resp.StatusCode)
			}
		})
	}
}

func TestServiceHealthFormat(t *testing.T) {
	profile := activeProfile(t)
	client := &http.Client{Timeout: 3 * time.Second}

	for _, svc := range profile.Services {
		t.Run(fmt.Sprintf("%s_content_type", svc), func(t *testing.T) {
			url := probes[svc].url()
			resp := probe(t, client, url)
			defer resp.Body.Close()

			if ct := resp.Header.Get("Content-Type"); ct == "" {
				t.Errorf("service %s returned no Content-Type header for %s", svc, url)
			}
		})
	}
}
