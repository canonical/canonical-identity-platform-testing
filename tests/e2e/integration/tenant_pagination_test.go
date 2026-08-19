//go:build e2e

package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

const (
	paginationPageSize   = 2
	paginationNumTenants = 5
)

// TestListTenantsPagination verifies cursor-based pagination for ListTenants:
//   - Each page (except the last) contains exactly paginationPageSize items
//   - No tenant ID is returned more than once across all pages
//   - Every tenant created by this test appears exactly once in the results
//
// This directly guards against off-by-one bugs in cursor-based pagination.
func TestListTenantsPagination(t *testing.T) {
	requireService(t, "tenant-service")

	client, err := NewHTTPTenantClient()
	if err != nil {
		t.Fatalf("failed to create tenant client: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("e2e-pg-%d-", time.Now().UnixNano())

	// Create N tenants and record their IDs
	createdIDs := make(map[string]struct{}, paginationNumTenants)
	for i := 0; i < paginationNumTenants; i++ {
		name := fmt.Sprintf("%s%03d", prefix, i+1)
		id, err := client.CreateTenant(ctx, name)
		if err != nil {
			t.Fatalf("setup: CreateTenant(%q): %v", name, err)
		}
		createdIDs[id] = struct{}{}

		// Register cleanup
		cleanupID := id
		t.Cleanup(func() {
			cleanCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := client.DeleteTenant(cleanCtx, cleanupID); err != nil {
				t.Logf("cleanup: DeleteTenant(%s): %v", cleanupID, err)
			}
		})
	}

	// Walk every page and collect tenant IDs that belong to this test run
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
