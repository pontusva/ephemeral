package rooms

import (
	"database/sql"
	"time"
)

func CleanupExpired(db *sql.DB) error {
	now := time.Now().Unix()

	tx, err := db.Begin()
	if err != nil {
		return err
	}

	if _, err := tx.Exec(`
		DELETE FROM ephemeral_messages
		WHERE room_id IN (
			SELECT id FROM ephemeral_rooms
			WHERE expires_at <= ?
		)
	`, now); err != nil {
		_ = tx.Rollback()
		return err
	}

	if _, err := tx.Exec(`
		DELETE FROM ephemeral_rooms
		WHERE expires_at <= ?
	`, now); err != nil {
		_ = tx.Rollback()
		return err
	}

	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		return err
	}

	return nil
}
