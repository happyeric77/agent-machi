package bridge

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

type health struct {
	OK     bool `json:"ok"`
	Fake   bool `json:"fake"`
	Agents int  `json:"agents"`
}

func (b *Bridge) Handler(static fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			_, _ = w.Write([]byte("method not allowed"))
			return
		}

		switch r.URL.Path {
		case "/snapshot":
			writeJSON(w, b.Snapshot())
			return
		case "/log":
			writeJSON(w, b.ReadLog(logLimit(r.URL.Query().Get("limit"))))
			return
		case "/health":
			writeJSON(w, health{OK: true, Fake: b.cfg.Fake, Agents: b.AgentCount()})
			return
		case "/events":
			b.serveEvents(w, r)
			return
		}

		serveStatic(w, r, static)
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	data, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "encoding error", http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(data)
}

func logLimit(raw string) int {
	if raw == "" {
		return 200
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 200
	}
	limit := int(math.Floor(value))
	if limit < 1 {
		return 1
	}
	if limit > 2000 {
		return 2000
	}
	return limit
}

func (b *Bridge) serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("retry: 1000\n\n"))
	flusher.Flush()

	client := make(chan []byte, 64)
	b.addSSEClient(client)
	defer b.removeSSEClient(client)

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case line, open := <-client:
			if !open {
				return
			}
			if _, err := w.Write(line); err != nil {
				return
			}
			flusher.Flush()
		case <-keepAlive.C:
			if _, err := w.Write([]byte(": keep-alive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func serveStatic(w http.ResponseWriter, r *http.Request, static fs.FS) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	data, err := fs.ReadFile(static, name)
	if err != nil {
		data, err = fs.ReadFile(static, "index.html")
		name = "index.html"
		if err != nil {
			http.NotFound(w, r)
			return
		}
	}
	http.ServeContent(w, r, name, time.Time{}, strings.NewReader(string(data)))
}

func (b *Bridge) String() string {
	return fmt.Sprintf("%s:%d", b.cfg.Host, b.cfg.Port)
}
