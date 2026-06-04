// Package migrations embeds the SQL migration files so they ship inside the
// binary and can be applied on startup without a separate tool.
package migrations

import "embed"

// FS holds every *.sql migration, applied in lexical filename order.
//
//go:embed *.sql
var FS embed.FS
