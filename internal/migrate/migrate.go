package migrate

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Migration represents a single migration file
type Migration struct {
	Version int
	Name    string
	Path    string
}

// Runner handles database migrations
type Runner struct {
	db            *sql.DB
	migrationsDir string
}

// NewRunner creates a new migration runner
func NewRunner(db *sql.DB, migrationsDir string) *Runner {
	return &Runner{
		db:            db,
		migrationsDir: migrationsDir,
	}
}

// Run executes all pending migrations
func (r *Runner) Run() error {
	// Ensure schema_migrations table exists
	if err := r.ensureSchemaMigrationsTable(); err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	// Get highest applied migration version
	appliedVersion, err := r.getAppliedVersion()
	if err != nil {
		return fmt.Errorf("failed to get applied version: %w", err)
	}

	// Discover all migration files
	migrations, err := r.discoverMigrations()
	if err != nil {
		return fmt.Errorf("failed to discover migrations: %w", err)
	}

	// Filter migrations that need to be applied
	pending := r.filterPending(migrations, appliedVersion)

	if len(pending) == 0 {
		return nil // No migrations to run
	}

	// Apply each pending migration
	for _, m := range pending {
		if err := r.applyMigration(m); err != nil {
			return fmt.Errorf("failed to apply migration %d_%s: %w", m.Version, m.Name, err)
		}
	}

	return nil
}

// ensureSchemaMigrationsTable creates the schema_migrations table if it doesn't exist
func (r *Runner) ensureSchemaMigrationsTable() error {
	query := `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)
	`
	_, err := r.db.Exec(query)
	return err
}

// getAppliedVersion returns the highest applied migration version
// Returns 0 if no migrations have been applied
func (r *Runner) getAppliedVersion() (int, error) {
	var version int
	err := r.db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&version)
	if err != nil {
		return 0, err
	}
	return version, nil
}

// discoverMigrations finds all .sql files in the migrations directory
func (r *Runner) discoverMigrations() ([]Migration, error) {
	entries, err := os.ReadDir(r.migrationsDir)
	if err != nil {
		return nil, err
	}

	var migrations []Migration
	for _, e := range entries {
		if e.IsDir() {
			continue
		}

		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}

		// Parse version from filename (e.g., "001_initial.sql" -> 1)
		parts := strings.SplitN(name, "_", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid migration filename format: %s (expected: NNN_name.sql)", name)
		}

		version, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("invalid version number in filename %s: %w", name, err)
		}

		// Extract name without version prefix and .sql extension
		migrationName := strings.TrimSuffix(parts[1], ".sql")

		migrations = append(migrations, Migration{
			Version: version,
			Name:    migrationName,
			Path:    filepath.Join(r.migrationsDir, name),
		})
	}

	// Sort by version
	sort.Slice(migrations, func(i, j int) bool {
		return migrations[i].Version < migrations[j].Version
	})

	return migrations, nil
}

// filterPending returns migrations that haven't been applied yet
func (r *Runner) filterPending(migrations []Migration, appliedVersion int) []Migration {
	var pending []Migration
	for _, m := range migrations {
		if m.Version > appliedVersion {
			pending = append(pending, m)
		}
	}
	return pending
}

// applyMigration applies a single migration within a transaction
func (r *Runner) applyMigration(m Migration) error {
	// Read migration file
	sqlBytes, err := os.ReadFile(m.Path)
	if err != nil {
		return fmt.Errorf("failed to read migration file: %w", err)
	}

	// Start transaction
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback() // Rollback if we don't commit

	// Execute migration SQL
	if _, err := tx.Exec(string(sqlBytes)); err != nil {
		return fmt.Errorf("failed to execute migration SQL: %w", err)
	}

	// Record migration in schema_migrations
	timestamp := currentUnixTimestamp()
	_, err = tx.Exec(
		"INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
		m.Version, m.Name, timestamp,
	)
	if err != nil {
		return fmt.Errorf("failed to record migration: %w", err)
	}

	// Commit transaction
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// currentUnixTimestamp returns the current Unix timestamp in seconds
func currentUnixTimestamp() int64 {
	return time.Now().Unix()
}