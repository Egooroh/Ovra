package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"ovra/internal/domain"
)

// DigestStore is the storage slice the digest scheduler needs.
type DigestStore interface {
	ListWorkspaces(ctx context.Context) ([]domain.Workspace, error)
}

// DigestScheduler fires the daily task digest. Once a minute it checks every
// workspace: if its digest is enabled and the current wall-clock time in the
// workspace timezone matches its configured DigestTime ("HH:MM"), it asks the
// Telegram bot to build and post the digest to the group chat.
//
// The bot owns formatting and sending; this scheduler only decides *when* and
// for *which* chat, mirroring the meeting-done notification flow.
type DigestScheduler struct {
	store        DigestStore
	botURL       string // BotInternalURL, e.g. http://bot:3000
	workerSecret string // optional bearer token shared with the bot
	log          *slog.Logger

	mu       sync.Mutex
	lastSent map[string]string // tenantID → "2006-01-02" of last send, dedupes within the minute
}

// NewDigestScheduler builds a DigestScheduler. botURL must be non-empty for the
// scheduler to do anything useful (the caller gates on that).
func NewDigestScheduler(store DigestStore, botURL, workerSecret string, log *slog.Logger) *DigestScheduler {
	return &DigestScheduler{
		store:        store,
		botURL:       botURL,
		workerSecret: workerSecret,
		log:          log,
		lastSent:     make(map[string]string),
	}
}

// Tick runs one scheduling pass. Call it once a minute.
func (d *DigestScheduler) Tick(ctx context.Context) {
	workspaces, err := d.store.ListWorkspaces(ctx)
	if err != nil {
		d.log.Error("digest: list workspaces", "err", err)
		return
	}
	for _, ws := range workspaces {
		if !ws.DigestEnabled || ws.ChatID == "" {
			continue
		}
		digestTime := ws.DigestTime
		if digestTime == "" {
			digestTime = "09:00"
		}

		loc := digestLocation(ws.Timezone)
		now := time.Now().In(loc)
		if now.Format("15:04") != digestTime {
			continue
		}

		// Send at most once per calendar day per tenant (the minute can tick twice).
		today := now.Format("2006-01-02")
		d.mu.Lock()
		already := d.lastSent[ws.ID] == today
		if !already {
			d.lastSent[ws.ID] = today
		}
		d.mu.Unlock()
		if already {
			continue
		}

		d.notifyBot(ws)
	}
}

// notifyBot POSTs {chat_id, tenant_id} to the bot's /internal/digest endpoint.
// The bot fetches the digest data itself and renders it.
func (d *DigestScheduler) notifyBot(ws domain.Workspace) {
	body, err := json.Marshal(map[string]string{
		"chat_id":   ws.ChatID,
		"tenant_id": ws.ID,
	})
	if err != nil {
		d.log.Error("digest: marshal", "tenant", ws.ID, "err", err)
		return
	}

	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost,
		d.botURL+"/internal/digest", bytes.NewReader(body),
	)
	if err != nil {
		d.log.Error("digest: build request", "tenant", ws.ID, "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if d.workerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+d.workerSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		d.log.Error("digest: POST failed", "tenant", ws.ID, "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		d.log.Error("digest: unexpected status", "tenant", ws.ID, "status", resp.StatusCode)
		return
	}
	d.log.Info("digest: sent", "tenant", ws.ID, "chat", ws.ChatID)
}

// digestLocation resolves a workspace timezone, falling back to DEADLINE_TZ,
// then Europe/Moscow, then UTC. Mirrors workspaceLocation in the http package.
func digestLocation(tz string) *time.Location {
	if tz == "" {
		tz = os.Getenv("DEADLINE_TZ")
	}
	if tz == "" {
		tz = "Europe/Moscow"
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.UTC
}
