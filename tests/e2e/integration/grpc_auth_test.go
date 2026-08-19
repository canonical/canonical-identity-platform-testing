//go:build e2e

package integration

import (
	"context"
	"testing"
	"time"

	v0 "github.com/canonical/tenant-service/v0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// grpcAddress returns the gRPC server address for the tenant-service.
func grpcAddress() string {
	return envOr("TENANT_SERVICE_GRPC_ADDR", "localhost:50051")
}

// TestGRPCAuthentication tests that gRPC endpoints require authentication.
func TestGRPCAuthentication(t *testing.T) {
	requireService(t, "tenant-service")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, grpcAddress(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		t.Skipf("failed to connect to gRPC server at %s: %v", grpcAddress(), err)
		return
	}
	defer conn.Close()

	client := v0.NewTenantServiceClient(conn)

	t.Run("RequestWithoutAuthShouldFail", func(t *testing.T) {
		_, err := client.ListTenants(ctx, &v0.ListTenantsRequest{})
		if err == nil {
			t.Error("expected error when calling without authentication, got nil")
		}
	})

	// LookupTenants is deliberately excluded from the auth interceptor
	// (tenant-service cmd/serve.go). login-ui attaches no credentials to its
	// tenant-lookup call, so if this exclusion regresses, every login on a
	// multi-tenancy profile 500s with "authorization token is not provided".
	// That was PD-1: it blocked the four tenant browser scenarios entirely.
	t.Run("LookupTenantsWithoutAuthShouldSucceed", func(t *testing.T) {
		_, err := client.LookupTenants(ctx, &v0.LookupTenantsRequest{
			Email: "grpc-auth-probe@test.example",
		})
		if err != nil {
			t.Errorf("LookupTenants must not require authentication (login-ui sends none), got: %v", err)
		}
	})

	t.Run("RequestWithValidAuthShouldSucceed", func(t *testing.T) {
		auth := NewAuthHelper()
		token, err := auth.GetToken(ctx)
		if err != nil {
			t.Skipf("cannot get auth token: %v", err)
			return
		}

		md := metadata.Pairs("authorization", "Bearer "+token)
		authCtx := metadata.NewOutgoingContext(ctx, md)

		_, err = client.ListTenants(authCtx, &v0.ListTenantsRequest{})
		if err != nil {
			t.Errorf("expected success with valid auth, got error: %v", err)
		}
	})
}
