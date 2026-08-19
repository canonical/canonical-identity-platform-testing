//go:build e2e

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// AuthHelper provides JWT tokens for authenticated requests.
// Tokens are cached and refreshed automatically before expiry.
type AuthHelper struct {
	clientID     string
	clientSecret string
	hydraURL     string

	cachedToken string
	tokenExpiry time.Time
	mu          sync.RWMutex
}

// NewAuthHelper creates an AuthHelper from environment variables with defaults.
func NewAuthHelper() *AuthHelper {
	clientID := envOr("AUTH_CLIENT_ID", "")
	clientSecret := envOr("AUTH_CLIENT_SECRET", "")
	hydraURL := envOr("HYDRA_PUBLIC_URL", "")
	if hydraURL == "" {
		adminURL := envOr("HYDRA_ADMIN_URL", "http://localhost:4445")
		hydraURL = strings.Replace(adminURL, "4445", "4444", 1)
	}

	if clientID == "" || clientSecret == "" {
		manifestPaths := []string{
			"../../browser/manifest.json",
			"tests/browser/manifest.json",
			"manifest.json",
		}
		for _, path := range manifestPaths {
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var manifest struct {
				OAuthClients struct {
					SVC struct {
						ClientID     string `json:"clientId"`
						ClientSecret string `json:"clientSecret"`
					} `json:"svc"`
				} `json:"oauthClients"`
			}
			if err := json.Unmarshal(data, &manifest); err != nil {
				continue
			}
			if clientID == "" {
				clientID = manifest.OAuthClients.SVC.ClientID
			}
			if clientSecret == "" {
				clientSecret = manifest.OAuthClients.SVC.ClientSecret
			}
			break
		}
	}

	return &AuthHelper{
		clientID:     clientID,
		clientSecret: clientSecret,
		hydraURL:     hydraURL,
	}
}

// GetToken returns a valid JWT token, refreshing if necessary.
func (a *AuthHelper) GetToken(ctx context.Context) (string, error) {
	a.mu.RLock()
	if a.cachedToken != "" && time.Now().Before(a.tokenExpiry) {
		token := a.cachedToken
		a.mu.RUnlock()
		return token, nil
	}
	a.mu.RUnlock()

	// Check env var override first
	if token := os.Getenv("JWT_TOKEN"); token != "" {
		a.mu.Lock()
		a.cachedToken = token
		a.tokenExpiry = time.Now().Add(5 * time.Minute)
		a.mu.Unlock()
		return token, nil
	}

	if a.clientID == "" || a.clientSecret == "" {
		return "", fmt.Errorf("no authentication credentials: set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET")
	}

	token, expiresIn, err := a.exchangeToken(ctx, a.clientID, a.clientSecret)
	if err != nil {
		return "", err
	}

	a.mu.Lock()
	a.cachedToken = token
	safetyMargin := 60
	if expiresIn > safetyMargin {
		a.tokenExpiry = time.Now().Add(time.Duration(expiresIn-safetyMargin) * time.Second)
	} else {
		a.tokenExpiry = time.Now().Add(time.Duration(expiresIn) * time.Second)
	}
	a.mu.Unlock()

	return token, nil
}

// exchangeToken exchanges client credentials for a JWT token via Hydra.
func (a *AuthHelper) exchangeToken(ctx context.Context, clientID, clientSecret string) (string, int, error) {
	tokenURL := fmt.Sprintf("%s/oauth2/token", a.hydraURL)

	data := url.Values{}
	data.Set("grant_type", "client_credentials")
	data.Set("scope", envOr("AUTH_REQUIRED_SCOPE", "tenant-service"))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", 0, fmt.Errorf("create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(clientID, clientSecret)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", 0, fmt.Errorf("read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse the token response
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}

	if err := parseJSON(body, &tokenResp); err != nil {
		return "", 0, fmt.Errorf("parse token response: %w", err)
	}

	return tokenResp.AccessToken, tokenResp.ExpiresIn, nil
}

// authedRequest creates an HTTP request with Bearer token authentication.
func authedRequest(ctx context.Context, method, url string, body io.Reader, getToken func(context.Context) (string, error)) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}

	token, err := getToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("get auth token: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	return req, nil
}

// Tenant represents a minimal tenant structure for E2E testing.
type Tenant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// TenantUser represents a user within a tenant.
type TenantUser struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}

// HTTPTenantClient provides HTTP access to the tenant-service API.
type HTTPTenantClient struct {
	baseURL  string
	client   *http.Client
	getToken func(context.Context) (string, error)
}

// NewHTTPTenantClient creates a tenant client using the control repo's auth.
func NewHTTPTenantClient() (*HTTPTenantClient, error) {
	auth := NewAuthHelper()
	baseURL := serviceURL("tenant-service")

	return &HTTPTenantClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		getToken: auth.GetToken,
	}, nil
}

// CreateTenant creates a new tenant and returns its ID.
func (c *HTTPTenantClient) CreateTenant(ctx context.Context, name string) (string, error) {
	payload := fmt.Sprintf(`{"name":%q}`, name)
	req, err := authedRequest(ctx, http.MethodPost, c.baseURL+"/api/v0/tenants", strings.NewReader(payload), c.getToken)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("CreateTenant failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Tenant Tenant `json:"tenant"`
	}
	if err := parseJSON(body, &result); err != nil {
		return "", fmt.Errorf("parse CreateTenant response: %w", err)
	}

	return result.Tenant.ID, nil
}

// DeleteTenant deletes a tenant by ID.
func (c *HTTPTenantClient) DeleteTenant(ctx context.Context, id string) error {
	req, err := authedRequest(ctx, http.MethodDelete, c.baseURL+"/api/v0/tenants/"+id, nil, c.getToken)
	if err != nil {
		return err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("DeleteTenant failed (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// ListTenants returns all tenants.
func (c *HTTPTenantClient) ListTenants(ctx context.Context) ([]Tenant, error) {
	req, err := authedRequest(ctx, http.MethodGet, c.baseURL+"/api/v0/tenants", nil, c.getToken)
	if err != nil {
		return nil, err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ListTenants failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Tenants []Tenant `json:"tenants"`
	}
	if err := parseJSON(body, &result); err != nil {
		return nil, fmt.Errorf("parse ListTenants response: %w", err)
	}

	return result.Tenants, nil
}

// UpdateTenant updates a tenant's name.
func (c *HTTPTenantClient) UpdateTenant(ctx context.Context, id, name string) error {
	// The field mask is mandatory: tenant-service's storage layer short-circuits
	// on an empty mask and returns 200 with the row untouched, so omitting it
	// makes the update a silent no-op. Every other client in the platform sends one.
	payload := fmt.Sprintf(`{"tenant":{"name":%q},"update_mask":"name"}`, name)
	req, err := authedRequest(ctx, http.MethodPatch, c.baseURL+"/api/v0/tenants/"+id, strings.NewReader(payload), c.getToken)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("UpdateTenant failed (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// findTenantByID pages through every tenant looking for one id.
//
// ListTenants returns only the first page (the service caps it at 100), so a
// test that scans it silently stops finding its own tenant once enough others
// exist — which is exactly what leaked webhook tenants caused. Never scan a
// single page for a specific record.
func (c *HTTPTenantClient) findTenantByID(ctx context.Context, id string) (*Tenant, error) {
	pageToken := ""
	for {
		page, next, err := c.ListTenantsPaged(ctx, pageToken, 100)
		if err != nil {
			return nil, err
		}
		for i := range page {
			if page[i].ID == id {
				return &page[i], nil
			}
		}
		if next == "" {
			return nil, nil
		}
		pageToken = next
	}
}

// ListTenantsPaged returns a page of tenants with the next page token.
func (c *HTTPTenantClient) ListTenantsPaged(ctx context.Context, pageToken string, pageSize int) ([]Tenant, string, error) {
	u := fmt.Sprintf("%s/api/v0/tenants?page_size=%d", c.baseURL, pageSize)
	if pageToken != "" {
		u += fmt.Sprintf("&page_token=%s", pageToken)
	}

	req, err := authedRequest(ctx, http.MethodGet, u, nil, c.getToken)
	if err != nil {
		return nil, "", err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("ListTenantsPaged failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Tenants        []Tenant `json:"tenants"`
		NextToken      string   `json:"next_page_token"`
		NextTokenCamel string   `json:"nextPageToken"`
	}
	if err := parseJSON(body, &result); err != nil {
		return nil, "", fmt.Errorf("parse ListTenantsPaged response: %w", err)
	}

	nextToken := result.NextToken
	if nextToken == "" {
		nextToken = result.NextTokenCamel
	}

	return result.Tenants, nextToken, nil
}

// Close is a no-op for HTTP clients (satisfies io.Closer convention).
func (c *HTTPTenantClient) Close() error { return nil }

// parseJSON unmarshals JSON data into the provided value.
func parseJSON(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}
