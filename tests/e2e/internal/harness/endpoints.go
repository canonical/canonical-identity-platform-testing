//go:build e2e

package harness

import "os"

// Endpoint is one host-published surface of the stack: the env var that
// overrides it (the same names tests/browser and matrix/run-row.mjs use) and
// the canonical host port from docker/docker-compose.*.yml.
type Endpoint struct {
	Env     string
	Default string
}

// URL returns the env override when set, else the canonical host address.
func (e Endpoint) URL() string {
	if v := os.Getenv(e.Env); v != "" {
		return v
	}
	return e.Default
}

// The host-port table for every surface the Go suites reach; the env names
// match tests/browser and matrix/verify/urls.mjs. Ports not consumed by a Go
// test are not listed — the full published set is docker/docker-compose.*.yml.
var (
	KratosPublic      = Endpoint{"KRATOS_PUBLIC_URL", "http://localhost:4433"}
	HydraPublic       = Endpoint{"HYDRA_PUBLIC_URL", "http://localhost:4444"}
	HydraAdmin        = Endpoint{"HYDRA_ADMIN_URL", "http://localhost:4445"}
	HookServiceHTTP   = Endpoint{"HOOK_SERVICE_URL", "http://localhost:8080"}
	TenantServiceHTTP = Endpoint{"TENANT_SERVICE_URL", "http://localhost:8081"}
	TenantServiceGRPC = Endpoint{"TENANT_SERVICE_GRPC_ADDR", "localhost:50051"}
	// login-ui is reached through Traefik: its direct port is base-path
	// dependent and legitimately 404s in local profiles.
	LoginUIHTTP          = Endpoint{"LOGIN_UI_URL", "http://localhost"}
	UserVerificationHTTP = Endpoint{"USER_VERIFICATION_URL", "http://localhost:8083"}
	OpenFGAHTTP          = Endpoint{"OPENFGA_URL", "http://localhost:8180"}
	DexHTTP              = Endpoint{"DEX_URL", "http://localhost:5556"}
)
