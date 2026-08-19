//go:build e2e

package integration

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestTenantLifecycle(t *testing.T) {
	requireService(t, "tenant-service")

	client, err := NewHTTPTenantClient()
	if err != nil {
		t.Fatalf("failed to create tenant client: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantName := fmt.Sprintf("e2e-lifecycle-%d", time.Now().UnixNano())

	var tenantID string

	t.Run("CreateTenant", func(t *testing.T) {
		id, err := client.CreateTenant(ctx, tenantName)
		if err != nil {
			t.Fatalf("CreateTenant failed: %v", err)
		}
		if id == "" {
			t.Fatal("expected non-empty tenant ID")
		}
		tenantID = id
		t.Logf("created tenant %s (%s)", tenantName, id)
	})

	// Cleanup regardless of test outcome
	defer func() {
		if tenantID == "" {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := client.DeleteTenant(cleanupCtx, tenantID); err != nil {
			t.Logf("warning: failed to delete tenant %s: %v", tenantID, err)
		}
	}()

	t.Run("ListTenants", func(t *testing.T) {
		// Prove the endpoint answers at all, then locate our own tenant across
		// pages — the first page alone is not a reliable place to look.
		if _, err := client.ListTenants(ctx); err != nil {
			t.Fatalf("ListTenants failed: %v", err)
		}

		found, err := client.findTenantByID(ctx, tenantID)
		if err != nil {
			t.Fatalf("findTenantByID failed: %v", err)
		}
		if found == nil {
			t.Fatalf("created tenant %s not found in any page", tenantID)
		}
		if found.Name != tenantName {
			t.Errorf("expected tenant name %s, got %s", tenantName, found.Name)
		}
	})

	t.Run("UpdateTenant", func(t *testing.T) {
		updatedName := tenantName + "-updated"
		if err := client.UpdateTenant(ctx, tenantID, updatedName); err != nil {
			t.Fatalf("UpdateTenant failed: %v", err)
		}

		found, err := client.findTenantByID(ctx, tenantID)
		if err != nil {
			t.Fatalf("findTenantByID after update failed: %v", err)
		}
		if found == nil {
			t.Fatalf("tenant %s not found after update", tenantID)
		}
		if found.Name != updatedName {
			t.Errorf("expected updated name %s, got %s", updatedName, found.Name)
		}
	})

	t.Run("DeleteTenant", func(t *testing.T) {
		deletedID := tenantID
		if err := client.DeleteTenant(ctx, deletedID); err != nil {
			t.Fatalf("DeleteTenant failed: %v", err)
		}
		tenantID = "" // prevent double-delete in cleanup

		tenants, err := client.ListTenants(ctx)
		if err != nil {
			t.Fatalf("ListTenants after delete failed: %v", err)
		}

		for _, tenant := range tenants {
			if tenant.ID == deletedID {
				t.Errorf("deleted tenant %s still appears in list", deletedID)
			}
		}
	})
}
