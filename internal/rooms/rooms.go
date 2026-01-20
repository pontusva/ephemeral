package rooms

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"ephemeral/internal/notify"
	"time"
)

func Create(db *sql.DB, ttl time.Duration) (string, time.Time, error) {
	b := make([]byte, 16)
	rand.Read(b)

	token := hex.EncodeToString(b)
	now := time.Now().Unix()
	expires := time.Now().Add(ttl).Unix()

	_, err := db.Exec(`
		INSERT INTO ephemeral_rooms (token, expires_at, created_at)
		VALUES (?, ?, ?)
	`, token, expires, now)

	if err == nil {
		notify.Emit("room.created", token, ttl.String())
	}

	return token, time.Unix(expires, 0), err
}

func Exists(db *sql.DB, token string) (bool, error) {
	var count int
	now := time.Now().Unix()
	err := db.QueryRow(`
		SELECT COUNT(*) FROM ephemeral_rooms
		WHERE token = ? AND expires_at > ?
	`, token, now).Scan(&count)

	return count == 1, err
}

func GetExpiry(db *sql.DB, token string) (time.Time, error) {
	now := time.Now().Unix()
	expiresAt, err := scanUnixValueRow(db.QueryRow(`
		SELECT expires_at FROM ephemeral_rooms
		WHERE token = ? AND expires_at > ?
	`, token, now))
	if err != nil {
		return time.Time{}, err
	}

	return time.Unix(expiresAt, 0), nil
}
