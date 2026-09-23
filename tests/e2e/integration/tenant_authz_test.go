//go:build e2e

package integration

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/canonical/canonical-identity-platform/tests/e2e/internal/harness"
)

// TestUpdateTenant_MemberForbidden verifies that a caller without can_edit
// on a tenant receives HTTP 403 from UpdateTenant. Needs two Hydra clients:
// AUTH_CLIENT_ID/SECRET (privileged owner) and MEMBER_CLIENT_ID/SECRET (plain member).
func TestUpdateTenant_MemberForbidden(t *testing.T) {
	requireService(t, harness.TenantService)

	// Unreachable on the current stack: tenant-service runs the no-op authorizer
	// (AUTHORIZATION_ENABLED defaults to false) and, even enforced, UpdateTenant
	// maps ErrPermissionDenied to codes.Internal (500).
	if envOr("E2E_AUTHZ_ENFORCED", "") != "true" {
		t.Skip("tenant-service runs the no-op authorizer and UpdateTenant maps " +
			"permission-denied to 500 — a 403 is unreachable; set E2E_AUTHZ_ENFORCED=true once both are fixed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	ownerClient, err := NewHTTPTenantClient()
	if err != nil {
		t.Fatalf("failed to create owner client: %v", err)
	}
	defer ownerClient.Close()

	tenantName := fmt.Sprintf("authz-test-%d", time.Now().UnixNano())
	tenantID, err := ownerClient.CreateTenant(ctx, tenantName)
	if err != nil {
		t.Fatalf("CreateTenant as owner failed: %v", err)
	}

	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := ownerClient.DeleteTenant(cleanupCtx, tenantID); err != nil {
			t.Logf("warning: cleanup delete failed for tenant %s: %v", tenantID, err)
		}
	}()

	// Member client: authenticated but holds no FGA relation on the tenant.
	memberAuth := &AuthHelper{
		clientID:     envOr("MEMBER_CLIENT_ID", "browser-test-member"),
		clientSecret: envOr("MEMBER_CLIENT_SECRET", "browser-test-member-secret"),
		hydraURL:     harness.HydraPublic.URL(),
	}

	baseURL := harness.TenantServiceHTTP.URL()
	memberHTTPClient := &http.Client{Timeout: 10 * time.Second}

	payload := fmt.Sprintf(`{"tenant":{"name":%q},"update_mask":"name"}`, tenantName+"-hacked")
	req, err := authedRequest(ctx, http.MethodPatch, baseURL+"/api/v0/tenants/"+tenantID, strings.NewReader(payload), memberAuth.GetToken)
	if err != nil {
		t.Fatalf("create member request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := memberHTTPClient.Do(req)
	if err != nil {
		t.Fatalf("member UpdateTenant request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		t.Fatal("expected 403 Forbidden when member calls UpdateTenant, got 200 OK")
	}

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected HTTP 403, got %d", resp.StatusCode)
	}
}
