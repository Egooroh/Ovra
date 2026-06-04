package yougile

import (
	"context"
	"errors"
	"fmt"
)

// Company is a YouGile company the credentials have access to.
type Company struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	IsAdmin bool   `json:"isAdmin"`
}

// listEnvelope is the standard list response wrapper used by YouGile.
type listEnvelope[T any] struct {
	Content []T `json:"content"`
}

// ListCompanies returns the companies reachable with the given login/password.
// POST /auth/companies — no Bearer token required.
func (c *Client) ListCompanies(ctx context.Context, login, password string) ([]Company, error) {
	body := map[string]string{"login": login, "password": password}
	var env listEnvelope[Company]
	if err := c.do(ctx, "POST", "/auth/companies", "", body, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}

// CreateKey creates (or returns) an API key for the given company.
// POST /auth/keys — no Bearer token required. The key string is what later
// calls use as a Bearer token.
func (c *Client) CreateKey(ctx context.Context, login, password, companyID string) (string, error) {
	body := map[string]string{"login": login, "password": password, "companyId": companyID}
	var resp struct {
		Key string `json:"key"`
	}
	if err := c.do(ctx, "POST", "/auth/keys", "", body, &resp); err != nil {
		return "", err
	}
	if resp.Key == "" {
		return "", errors.New("yougile: empty key in /auth/keys response")
	}
	return resp.Key, nil
}

// ObtainKey is the high-level login/password flow: resolve the company, then
// create a key. When companyName is empty and exactly one company is available
// it is used; otherwise companyName must match one of them.
func (c *Client) ObtainKey(ctx context.Context, login, password, companyName string) (string, error) {
	companies, err := c.ListCompanies(ctx, login, password)
	if err != nil {
		return "", err
	}
	if len(companies) == 0 {
		return "", errors.New("yougile: no companies for these credentials")
	}

	company, err := pickCompany(companies, companyName)
	if err != nil {
		return "", err
	}
	return c.CreateKey(ctx, login, password, company.ID)
}

// pickCompany selects a company by name, or the sole company when name is empty.
func pickCompany(companies []Company, name string) (Company, error) {
	if name == "" {
		if len(companies) == 1 {
			return companies[0], nil
		}
		names := make([]string, len(companies))
		for i, co := range companies {
			names[i] = co.Name
		}
		return Company{}, fmt.Errorf("yougile: %d companies available, specify one of %v", len(companies), names)
	}
	for _, co := range companies {
		if co.Name == name {
			return co, nil
		}
	}
	return Company{}, fmt.Errorf("yougile: company %q not found", name)
}
