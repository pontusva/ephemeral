package rooms

import (
	"database/sql"
	"errors"
	"time"
)

type MessageRow struct {
	Seq         int
	CreatedAt   int64
	Nonce       []byte
	Ciphertext  []byte
	MessageType string
}

func InsertMessage(
	db *sql.DB,
	roomID string,
	seq int,
	nonce []byte,
	ciphertext []byte,
	createdAt int64,
	messageType string,
) error {
	now := time.Now().Unix()

	tx, err := db.Begin()
	if err != nil {
		return err
	}

	expiresAt, err := scanUnixValueRow(tx.QueryRow(`
		SELECT expires_at FROM ephemeral_rooms
		WHERE token = ?
	`, roomID))
	if err != nil {
		_ = tx.Rollback()
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("room not found")
		}
		return err
	}

	if expiresAt <= now {
		_ = tx.Rollback()
		return errors.New("room expired")
	}

	if _, err := tx.Exec(`
		INSERT INTO ephemeral_messages (room_id, created_at, ciphertext, nonce, seq, message_type)
		VALUES (?, ?, ?, ?, ?, ?)
	`, roomID, createdAt, ciphertext, nonce, seq, messageType); err != nil {
		_ = tx.Rollback()
		return err
	}

	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		return err
	}

	return nil
}

func GetMaxSeq(db *sql.DB, roomID string) (int, error) {
	var maxSeq int
	err := db.QueryRow(`
		SELECT COALESCE(MAX(seq), 0) FROM ephemeral_messages
		WHERE room_id = ?
	`, roomID).Scan(&maxSeq)
	return maxSeq, err
}

func GetMessagesSince(
	db *sql.DB,
	roomID string,
	afterSeq int,
) ([]MessageRow, error) {
	now := time.Now().Unix()

	expiresAt, err := scanUnixValueRow(db.QueryRow(`
		SELECT expires_at FROM ephemeral_rooms
		WHERE token = ?
	`, roomID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("room not found")
		}
		return nil, err
	}

	if expiresAt <= now {
		return nil, errors.New("room expired")
	}

	rows, err := db.Query(`
		SELECT seq, created_at, nonce, ciphertext, message_type
		FROM ephemeral_messages
		WHERE room_id = ? AND seq > ?
		ORDER BY seq ASC
	`, roomID, afterSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []MessageRow
	for rows.Next() {
		var row MessageRow
		if err := rows.Scan(&row.Seq, &row.CreatedAt, &row.Nonce, &row.Ciphertext, &row.MessageType); err != nil {
			return nil, err
		}
		messages = append(messages, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return messages, nil
}
