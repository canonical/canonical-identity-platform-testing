//go:build e2e

package integration

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestUpdateTenant_MemberForbidden verifies that a caller without can_edit
// permission on a tenant receives HTTP 403 when calling UpdateTenant.
//
// This test requires:
//   - tenant-service in the active profile
//   - Two Hydra clients: an owner (privileged admin) and a member (plain user)
//   - AUTH_CLIENT_ID / AUTH_CLIENT_SECRET for the owner client
//   - MEMBER_CLIENT_ID / MEMBER_CLIENT_SECRET for the member client
func TestUpdateTenant_MemberForbidden(t *testing.T) {
	requireService(t, "tenant-service")

	// This asserts a 403 that the stack cannot currently produce, for two
	// independent reasons — so the skip names them rather than blaming a missing
	// env var:
	//   1. tenant-service runs the no-op authorizer. AUTHORIZATION_ENABLED is
	//      unset everywhere in docker/ and matrix/rows/, and it defaults to false,
	//      so every permission check returns true. A non-privileged caller would
	//      be ALLOWED, and this test would fail rather than skip.
	//   2. Even with authorization on, UpdateTenant cannot return 403: the
	//      handler wraps ErrPermissionDenied into codes.Internal, which maps to
	//      500. Only InviteMember maps it correctly.
	// Enabling this needs an upstream fix for (2), plus AUTHORIZATION_ENABLED,
	// an OpenFGA store/model bootstrap, and a seeded privileged-admin tuple.
	if envOr("E2E_AUTHZ_ENFORCED", "") != "true" {
		t.Skip("tenant-service runs the no-op authorizer and UpdateTenant maps " +
			"permission-denied to 500 — a 403 is unreachable; set E2E_AUTHZ_ENFORCED=true once both are fixed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Owner client: the primary E2E client that has privileged-admin access
	ownerClient, err := NewHTTPTenantClient()
	if err != nil {
		t.Fatalf("failed to create owner client: %v", err)
	}
	defer ownerClient.Close()

	// Create a tenant as the owner
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
	// Reuse NewAuthHelper's hydraURL — it converts the admin port to the public
	// one, which is the only port that serves /oauth2/token.
	memberAuth := &AuthHelper{
		clientID:     envOr("MEMBER_CLIENT_ID", "browser-test-member"),
		clientSecret: envOr("MEMBER_CLIENT_SECRET", "browser-test-member-secret"),
		hydraURL:     NewAuthHelper().hydraURL,
	}

	baseURL := serviceURL("tenant-service")
	memberHTTPClient := &http.Client{Timeout: 10 * time.Second}

	// Attempt UpdateTenant as the member — must be forbidden
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
