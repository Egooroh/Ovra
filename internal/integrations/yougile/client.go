// Package yougile is a thin REST client for the YouGile API v2.
//
// Two credential flows are supported, matching the bot onboarding (see the
// project's per-workspace credentials design):
//   - the host pastes a ready API key — used directly as a Bearer token;
//   - the host gives login/password — ObtainKey resolves the company and
//     creates a key via /auth/companies + /auth/keys.
//
// Auth endpoints (/auth/*) take login/password in the body and need no token;
// every other call authenticates with `Authorization: Bearer <key>`.
package yougile

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is the YouGile API v2 root.
// ru.yougile.com is preferred in environments where yougile.com is blocked.
const DefaultBaseURL = "https://ru.yougile.com/api-v2"

// Client talks to the YouGile API. It is safe for concurrent use; the
// per-workspace token is passed per call rather than stored on the client.
type Client struct {
	baseURL string
	http    *http.Client
}

// Option customises a Client.
type Option func(*Client)

// WithBaseURL overrides the API root (useful in tests).
func WithBaseURL(u string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") }
}

// WithHTTPClient injects a custom *http.Client.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

// New builds a Client with sensible defaults.
func New(opts ...Option) *Client {
	c := &Client{
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// APIError is returned for non-2xx responses.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("yougile: status %d: %s", e.Status, e.Body)
}

// do performs a JSON request. token may be empty for /auth endpoints. When out
// is non-nil the response body is decoded into it.
func (c *Client) do(ctx context.Context, method, path, token string, body, out any) error {
	var raw []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		raw = b
	}

	// Retry transient network failures (e.g. TLS handshake timeouts to
	// yougile.com). A connection-level error means the request never reached
	// the server, so retrying is safe even for POST.
	const attempts = 3
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}

		var rdr io.Reader
		if raw != nil {
			rdr = bytes.NewReader(raw)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
		if err != nil {
			return fmt.Errorf("new request: %w", err)
		}
		req.Header.Set("Accept", "application/json")
		if raw != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("%s %s: %w", method, path, err)
			continue // network error — retry
		}

		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return &APIError{Status: resp.StatusCode, Body: string(respBody)}
		}
		if out != nil && len(respBody) > 0 {
			if err := json.Unmarshal(respBody, out); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
		}
		return nil
	}
	return lastErr
}
