// Command ygsetup bootstraps a YouGile workspace for the demo: it logs in with
// YOUGILE_LOGIN/YOUGILE_PASSWORD, creates a project, a board and the four MVP
// columns, then prints a ready-to-paste workspace.yaml block. The API key is
// never printed.
//
// Usage:
//
//	YOUGILE_LOGIN=... YOUGILE_PASSWORD=... go run ./cmd/ygsetup
//
// Optional env: YOUGILE_COMPANY (if the account has several companies),
// PROJECT_NAME (default "Ovra Demo"), YOUGILE_BASE_URL.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"ovra/internal/integrations/yougile"
)

func main() {
	login := os.Getenv("YOUGILE_LOGIN")
	password := os.Getenv("YOUGILE_PASSWORD")
	if login == "" || password == "" {
		fmt.Fprintln(os.Stderr, "set YOUGILE_LOGIN and YOUGILE_PASSWORD")
		os.Exit(2)
	}
	projectName := envOr("PROJECT_NAME", "Ovra Demo")

	var opts []yougile.Option
	if base := os.Getenv("YOUGILE_BASE_URL"); base != "" {
		opts = append(opts, yougile.WithBaseURL(base))
	}
	c := yougile.New(opts...)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fmt.Fprintln(os.Stderr, "→ authenticating…")
	token, err := c.ObtainKey(ctx, login, password, os.Getenv("YOUGILE_COMPANY"))
	if err != nil {
		fatal("auth", err)
	}

	// Grant every company user (the creator on a fresh account) admin on the
	// project — without a users map YouGile hides the project in the UI.
	users, err := c.ListUsers(ctx, token)
	if err != nil {
		fatal("list users", err)
	}
	admins := make(map[string]string, len(users))
	for _, u := range users {
		admins[u.ID] = "admin"
	}

	fmt.Fprintln(os.Stderr, "→ creating project…")
	projectID, err := c.CreateProject(ctx, token, projectName, admins)
	if err != nil {
		fatal("create project", err)
	}

	fmt.Fprintln(os.Stderr, "→ creating board…")
	boardID, err := c.CreateBoard(ctx, token, "Main", projectID)
	if err != nil {
		fatal("create board", err)
	}

	// Create the four MVP columns and capture their ids.
	cols := []struct{ key, title string }{
		{"todo", "Сделать"},
		{"in_progress", "В работе"},
		{"review", "Ревью"},
		{"done", "Готово"},
	}
	ids := make(map[string]string, len(cols))
	for _, col := range cols {
		fmt.Fprintf(os.Stderr, "→ creating column %q…\n", col.title)
		id, err := c.CreateColumn(ctx, token, col.title, boardID)
		if err != nil {
			fatal("create column "+col.key, err)
		}
		ids[col.key] = id
	}

	// Print a workspace.yaml-ready block to stdout (the key is never printed).
	fmt.Println()
	fmt.Println("# --- paste into workspace.yaml under your workspace entry ---")
	fmt.Printf("    yougile_project_id: %q\n", projectID)
	fmt.Println("    columns:")
	fmt.Printf("      todo: %q\n", ids["todo"])
	fmt.Printf("      in_progress: %q\n", ids["in_progress"])
	fmt.Printf("      review: %q\n", ids["review"])
	fmt.Printf("      done: %q\n", ids["done"])
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func fatal(stage string, err error) {
	fmt.Fprintf(os.Stderr, "✗ %s: %v\n", stage, err)
	os.Exit(1)
}
