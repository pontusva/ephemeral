package httpx

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"ephemeral/internal/rooms"
)

// parseTTL converts a string like "15m", "1h", "24h" to time.Duration
func parseTTL(ttlStr string) (time.Duration, error) {
	switch ttlStr {
	case "15m":
		return 15 * time.Minute, nil
	case "1h":
		return 1 * time.Hour, nil
	case "24h":
		return 24 * time.Hour, nil
	default:
		return 1 * time.Hour, nil // default to 1 hour
	}
}

func Router(db *sql.DB) http.Handler {
	mux := http.NewServeMux()

	// create room with TTL
	mux.HandleFunc("/create", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}

		var req struct {
			TTL string `json:"ttl"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			req.TTL = "1h" // default
		}

		ttl, _ := parseTTL(req.TTL)

		token, expires, err := rooms.Create(db, ttl)
		if err != nil {
			log.Println("rooms.Create failed:", err)
			http.Error(w, "server error", 500)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"url":        "/#" + token,
			"expires_at": expires.Format(time.RFC3339),
		})
	})

	// get room expiry
	mux.HandleFunc("/room/", func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Path[len("/room/"):]
		if token == "" {
			http.Error(w, "missing token", 400)
			return
		}

		switch r.Method {
		case http.MethodGet:
			expires, err := rooms.GetExpiry(db, token)
			if err != nil {
				http.Error(w, "room not found or expired", 404)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"expires_at":     expires.Format(time.RFC3339),
				"expires_in_sec": int(time.Until(expires).Seconds()),
			})

		case http.MethodDelete:
			// Destroy room immediately
			if err := rooms.Delete(db, token); err != nil {
				log.Println("rooms.Delete failed:", err)
				http.Error(w, "failed to delete room", 500)
				return
			}

			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	// websocket rooms
	mux.Handle("/ws/", wsHandler(db))

	// Create room page
	mux.HandleFunc("/create-room", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "ui/create.html")
	})

	// Security documentation
	mux.HandleFunc("/docs/security", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "ui/docs/security.html")
	})

	// UI - serve different pages based on path
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// Always serve index.html - JavaScript will handle routing based on hash
		http.ServeFile(w, r, "ui/index.html")
	})

	// JavaScript application
	mux.HandleFunc("/app.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		http.ServeFile(w, r, "ui/app.js")
	})

	// Vendor directory (libsodium, etc.)
	mux.Handle("/vendor/", http.StripPrefix("/vendor/", http.FileServer(http.Dir("ui/vendor"))))

	return mux
}