package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"ephemeral/internal/notify"
	_ "github.com/mattn/go-sqlite3"

	"ephemeral/internal/httpx"
	"ephemeral/internal/rooms"
)

func runMigrations(db *sql.DB) error {
	entries, err := os.ReadDir("migrations")
	if err != nil {
		return err
	}

	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, filepath.Join("migrations", e.Name()))
		}
	}

	sort.Strings(files)

	for _, path := range files {
		sqlBytes, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(sqlBytes)); err != nil {
			return err
		}
	}

	return nil
}

func main() {
	// --- database path (explicit, systemd-safe) ---

	notify.Emit("system.start", "-", "ephemeral online")
	dbPath := os.Getenv("EPHEMERAL_DB_PATH")
	if dbPath == "" {
		dbPath = "/var/lib/ephemeral/data.db"
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("using sqlite db:", dbPath)

	if err := runMigrations(db); err != nil {
		log.Fatal("migration failed:", err)
	}

	// --- room expiry cleanup loop ---
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			if err := rooms.CleanupExpired(db); err != nil {
				log.Println("cleanup failed:", err)
			}
		}
	}()

	log.Println("listening on http://127.0.0.1:4000")
	log.Fatal(http.ListenAndServe(
		"127.0.0.1:4000",
		httpx.Router(db),
	))
}
