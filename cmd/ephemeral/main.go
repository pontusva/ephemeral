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

	"ephemeral/internal/config"
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
	// Load configuration based on runtime mode
	cfg, err := config.Load()
	if err != nil {
		log.Fatal("config error:", err)
	}

	if err := cfg.Validate(); err != nil {
		log.Fatal("config validation failed:", err)
	}

	log.Printf("starting ephemeral in %s mode", cfg.Mode)

	notify.Emit("system.start", "-", "ephemeral online")

	// Ensure database directory exists (important for development mode)
	if err := cfg.EnsureDBDirectory(); err != nil {
		log.Fatal("failed to create db directory:", err)
	}

	db, err := sql.Open("sqlite3", cfg.DBPath)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("using sqlite db:", cfg.DBPath)

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

	addr := cfg.Address()
	log.Printf("listening on http://%s", addr)
	log.Fatal(http.ListenAndServe(
		addr,
		httpx.Router(db),
	))
}
