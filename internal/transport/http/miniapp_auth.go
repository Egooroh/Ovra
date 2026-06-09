package http

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

func parseInt64(s string) (int64, error) { return strconv.ParseInt(s, 10, 64) }
func itoa(n int64) string                { return strconv.FormatInt(n, 10) }

// --- Telegram Mini App authentication ---------------------------------------
//
// Every request from the Mini App carries Telegram's signed initData in the
// Authorization header as `tma <initData>`. initData is a URL-encoded query
// string signed by Telegram with HMAC-SHA256 keyed by the bot token. We verify
// that signature on the server, so a tg_id we read out of it is trustworthy and
// cannot be spoofed by the client. See:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

// maxInitDataAge bounds how old a signed initData may be. This blocks replay of
// a captured initData long after the user closed the app.
const maxInitDataAge = 24 * time.Hour

// appIdentity is the verified caller extracted from a valid initData.
type appIdentity struct {
	TgID       int64
	Username   string
	FirstName  string
	LastName   string
	StartParam string // `startapp=` payload — we pass tenant_id here.
}

type ctxKey int

const identityKey ctxKey = 1

// identityFrom returns the verified identity attached by requireTelegramAuth.
func identityFrom(ctx context.Context) (appIdentity, bool) {
	id, ok := ctx.Value(identityKey).(appIdentity)
	return id, ok
}

// tgUser is the subset of the Telegram `user` object we consume.
type tgUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

// verifyInitData validates the signature and freshness of a raw initData string
// against botToken and returns the verified identity. The algorithm:
//  1. split into key=value pairs, drop `hash`;
//  2. sort keys, join "key=value" with '\n' → data_check_string;
//  3. secret = HMAC_SHA256("WebAppData", botToken);
//  4. want = hex(HMAC_SHA256(secret, data_check_string));
//  5. constant-time compare want with the provided hash.
func verifyInitData(raw, botToken string, now time.Time) (appIdentity, error) {
	if botToken == "" {
		return appIdentity{}, errors.New("bot token not configured")
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return appIdentity{}, errors.New("malformed initData")
	}

	hash := values.Get("hash")
	if hash == "" {
		return appIdentity{}, errors.New("initData has no hash")
	}

	// Build the data-check-string from every field except `hash`, sorted by key.
	keys := make([]string, 0, len(values))
	for k := range values {
		if k == "hash" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(values.Get(k))
	}

	secret := hmacSHA256([]byte("WebAppData"), []byte(botToken))
	want := hmacSHA256(secret, []byte(b.String()))
	got, err := hex.DecodeString(hash)
	if err != nil || subtle.ConstantTimeCompare(want, got) != 1 {
		return appIdentity{}, errors.New("initData signature mismatch")
	}

	// Freshness: reject stale initData to limit replay.
	if authDate := values.Get("auth_date"); authDate != "" {
		secs, perr := parseInt64(authDate)
		if perr == nil {
			issued := time.Unix(secs, 0)
			if now.Sub(issued) > maxInitDataAge {
				return appIdentity{}, errors.New("initData expired")
			}
		}
	}

	var u tgUser
	if raw := values.Get("user"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &u); err != nil {
			return appIdentity{}, errors.New("initData user unparseable")
		}
	}
	if u.ID == 0 {
		return appIdentity{}, errors.New("initData has no user")
	}

	return appIdentity{
		TgID:       u.ID,
		Username:   u.Username,
		FirstName:  u.FirstName,
		LastName:   u.LastName,
		StartParam: values.Get("start_param"),
	}, nil
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

// requireTelegramAuth verifies the initData and injects the identity. It is the
// outer gate for every /app/api/* route.
func (s *Server) requireTelegramAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.BotToken == "" {
			writeError(w, http.StatusServiceUnavailable, "mini app disabled: TELEGRAM_BOT_TOKEN not set")
			return
		}
		raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "tma ")
		if !ok || raw == "" {
			writeError(w, http.StatusUnauthorized, "missing Telegram auth")
			return
		}
		id, err := verifyInitData(raw, s.cfg.BotToken, time.Now())
		if err != nil {
			s.log.Warn("miniapp auth rejected", "err", err)
			writeError(w, http.StatusUnauthorized, "invalid Telegram auth")
			return
		}
		ctx := context.WithValue(r.Context(), identityKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireHost wraps a handler so only the workspace's host (admin) may proceed.
// Use for sensitive ops: connecting YouGile, picking the project, calendars.
func (s *Server) requireHost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ws, ok := s.authorizeTenant(w, r)
		if !ok {
			return
		}
		if ws.HostTgID == "" || ws.HostTgID != itoa(id.TgID) {
			writeError(w, http.StatusForbidden, "only the workspace admin can do this")
			return
		}
		next(w, r)
	}
}

// requireMember wraps a handler so the host or any registered member may proceed.
// Use for read/view ops: tasks, digest, board.
func (s *Server) requireMember(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ws, ok := s.authorizeTenant(w, r)
		if !ok {
			return
		}
		if ws.HostTgID == itoa(id.TgID) {
			next(w, r)
			return
		}
		users, err := s.repo.ListUsersByTenant(r.Context(), ws.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		for _, u := range users {
			if u.TgID == itoa(id.TgID) {
				next(w, r)
				return
			}
		}
		writeError(w, http.StatusForbidden, "not a member of this workspace")
	}
}

// authorizeTenant resolves the {tenant} path value, loads its workspace and
// returns it together with the verified caller. It writes the error response
// itself when something is off, so callers only check the bool.
func (s *Server) authorizeTenant(w http.ResponseWriter, r *http.Request) (appIdentity, workspaceLike, bool) {
	id, ok := identityFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing Telegram auth")
		return appIdentity{}, workspaceLike{}, false
	}
	tenant := r.PathValue("tenant")
	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return appIdentity{}, workspaceLike{}, false
	}
	return id, workspaceLike{ID: ws.ID, HostTgID: ws.HostTgID}, true
}

// workspaceLike is the slice of domain.Workspace the auth layer needs, kept
// local so this file does not import beyond what it uses.
type workspaceLike struct {
	ID       string
	HostTgID string
}
