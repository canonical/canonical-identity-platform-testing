//go:build e2e

// tenant-service's Kratos webhook routes (/api/v0/webhooks/registration and
// /login), driven directly. hook-service's token-hook contract is owned by its
// own suite (canonical/hook-service@295273b pkg/hooks/*_test.go); this repo covers
// only that the hook's output reaches RP tokens (docs/testing-spec.md §10 item 8).

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/canonical/canonical-identity-platform/tests/e2e/internal/harness"
)

// webhookLoginPayload mirrors the Kratos login webhook payload.
type webhookLoginPayload struct {
	IdentityID string `json:"identity_id"`
	Email      string `json:"email"`
	TenantID   string `json:"tenant_id"`
}

// webhookRegistrationPayload mirrors the Kratos registration webhook payload.
type webhookRegistrationPayload struct {
	ID    string `json:"identity_id"`
	Email string `json:"email"`
}

// postWebhook sends a JSON POST request to a webhook endpoint.
func postWebhook(ctx context.Context, baseURL, path string, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "secret_api_key")

	client := &http.Client{Timeout: 10 * time.Second}
	return client.Do(req)
}

// cleanupShadowTenant deletes the tenant the registration webhook creates
// ("<email>'s Org"); leaked tenants break unrelated tenant tests.
func cleanupShadowTenant(t *testing.T, ctx context.Context, email string) {
	t.Helper()

	client, err := NewHTTPTenantClient()
	if err != nil {
		t.Logf("warning: shadow-tenant cleanup could not build a client: %v", err)
		return
	}
	name := fmt.Sprintf("%s's Org", email)

	pageToken := ""
	for {
		page, next, err := client.ListTenantsPaged(ctx, pageToken, 100)
		if err != nil {
			t.Logf("warning: shadow-tenant cleanup could not list tenants: %v", err)
			return
		}
		for i := range page {
			if page[i].Name == name {
				if err := client.DeleteTenant(ctx, page[i].ID); err != nil {
					t.Logf("warning: failed to delete shadow tenant %s: %v", page[i].ID, err)
				}
				return
			}
		}
		if next == "" {
			return
		}
		pageToken = next
	}
}

// TestWebhookRegistration creates a shadow tenant and membership via the registration webhook.
func TestWebhookRegistration(t *testing.T) {
	requireService(t, harness.TenantService)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Traefik routes PathPrefix(`/api/v0/webhooks`) to tenant-service (docker/docker-compose.services.yml).
	webhookURL := harness.TenantServiceHTTP.URL()
	identityID := uuid.New().String()
	email := fmt.Sprintf("e2e-reg-%s@test.example", identityID)
	defer cleanupShadowTenant(t, ctx, email)

	resp, err := postWebhook(ctx, webhookURL, "/api/v0/webhooks/registration", webhookRegistrationPayload{
		ID:    identityID,
		Email: email,
	})
	if err != nil {
		t.Fatalf("registration webhook request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("registration webhook returned %d: %s", resp.StatusCode, string(body))
	}
}

// TestWebhookLogin_ValidMember tests that the login webhook succeeds for a
// registered identity with existing memberships.
func TestWebhookLogin_ValidMember(t *testing.T) {
	requireService(t, harness.TenantService)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	webhookURL := harness.TenantServiceHTTP.URL()
	identityID := uuid.New().String()
	email := fmt.Sprintf("e2e-login-%s@test.example", identityID)

	// Setup: register the identity first so a tenant + membership exist
	resp, err := postWebhook(ctx, webhookURL, "/api/v0/webhooks/registration", webhookRegistrationPayload{
		ID:    identityID,
		Email: email,
	})
	if err != nil {
		t.Fatalf("registration webhook request failed: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("registration webhook returned %d", resp.StatusCode)
	}

	// Now test the login webhook with no explicit tenant_id (fallback path)
	loginResp, err := postWebhook(ctx, webhookURL, "/api/v0/webhooks/login", webhookLoginPayload{
		IdentityID: identityID,
		Email:      email,
		TenantID:   "",
	})
	if err != nil {
		t.Fatalf("login webhook request failed: %v", err)
	}
	defer loginResp.Body.Close()

	if loginResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(loginResp.Body)
		t.Errorf("login webhook returned %d: %s", loginResp.StatusCode, string(body))
	}
}
