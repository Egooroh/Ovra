package yougile

import (
	"context"
	"errors"
	"strings"
)

// User is a YouGile account in a company.
type User struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	RealName string `json:"realName"`
}

// ListUsers returns the users visible to the token. GET /users.
func (c *Client) ListUsers(ctx context.Context, token string) ([]User, error) {
	if token == "" {
		return nil, errors.New("yougile: missing token")
	}
	var env listEnvelope[User]
	if err := c.do(ctx, "GET", "/users", token, nil, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}

// FindUserByName returns the user whose real name matches name (case-insensitive,
// trimmed). Tries exact match first, then first-name-only match so that "Егор"
// resolves to "Егор Иванов".
func FindUserByName(users []User, name string) (User, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	if want == "" {
		return User{}, false
	}
	// Pass 1: exact match.
	for _, u := range users {
		if strings.ToLower(strings.TrimSpace(u.RealName)) == want {
			return u, true
		}
	}
	// Pass 2: first-name match ("Егор" matches "Егор Иванов").
	for _, u := range users {
		first := strings.ToLower(strings.Fields(strings.TrimSpace(u.RealName))[0])
		if first == want {
			return u, true
		}
	}
	return User{}, false
}
