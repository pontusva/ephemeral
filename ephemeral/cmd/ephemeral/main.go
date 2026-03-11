package main

import (
	"database/sql"
	"log"
	"net/http"
	"time"

	"ephemeral/internal/config"
	"ephemeral/internal/httpx"
	"ephemeral/internal/migrate"
	"ephemeral/internal/notify"
	"ephemeral/internal/rooms"

	_ "github.com/mattn/go-sqlite3"
)

func runMigrations(db *sql.DB) error {
	runner := migrate.NewRunner(db, "migrations")
	return runner.Run()
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
