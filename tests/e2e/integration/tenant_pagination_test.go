//go:build e2e

package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/canonical/canonical-identity-platform/tests/e2e/internal/harness"
)

const (
	paginationPageSize   = 2
	paginationNumTenants = 5
)

// TestListTenantsPagination: every non-final page is exactly paginationPageSize,
// no tenant ID repeats across pages, and every created tenant appears exactly once.
func TestListTenantsPagination(t *testing.T) {
	requireService(t, harness.TenantService)

	client, err := NewHTTPTenantClient()
	if err != nil {
		t.Fatalf("failed to create tenant client: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("e2e-pg-%d-", time.Now().UnixNano())

	createdIDs := make(map[string]struct{}, paginationNumTenants)
	for i := 0; i < paginationNumTenants; i++ {
		name := fmt.Sprintf("%s%03d", prefix, i+1)
		id, err := client.CreateTenant(ctx, name)
		if err != nil {
			t.Fatalf("setup: CreateTenant(%q): %v", name, err)
		}
		createdIDs[id] = struct{}{}

		cleanupID := id
		t.Cleanup(func() {
			cleanCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := client.DeleteTenant(cleanCtx, cleanupID); err != nil {
				t.Logf("cleanup: DeleteTenant(%s): %v", cleanupID, err)
			}
		})
	}

	seen := make(map[string]struct{})
	pageToken := ""
	for pageNum := 1; ; pageNum++ {
		tenants, nextToken, err := client.ListTenantsPaged(ctx, pageToken, paginationPageSize)
		if err != nil {
			t.Fatalf("page %d: ListTenantsPaged(%q, %d): %v", pageNum, pageToken, paginationPageSize, err)
		}

		// A non-final page must be exactly full
		if nextToken != "" && len(tenants) != paginationPageSize {
			t.Errorf("page %d: got %d item(s) with next_page_token set; want exactly %d",
				pageNum, len(tenants), paginationPageSize)
		}

		for _, tenant := range tenants {
			if !strings.HasPrefix(tenant.Name, prefix) {
				continue // from a different test / pre-existing data
			}
			if _, dup := seen[tenant.ID]; dup {
				t.Errorf("page %d: duplicate tenant ID %s", pageNum, tenant.ID)
			}
			seen[tenant.ID] = struct{}{}
		}

		if nextToken == "" {
			break
		}
		pageToken = nextToken
	}

	// Every created tenant must appear exactly once
	for id := range createdIDs {
		if _, ok := seen[id]; !ok {
			t.Errorf("tenant %s was created but never returned by pagination", id)
		}
	}

	// Nothing extra from our prefix group
	for id := range seen {
		if _, ok := createdIDs[id]; !ok {
			t.Errorf("pagination returned tenant %s from our prefix that we didn't create", id)
		}
	}
}
