package rooms

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"
)

func NormalizeRoomTimestamps(db *sql.DB) error {
	rows, err := db.Query(`
		SELECT token, created_at, expires_at
		FROM ephemeral_rooms
		WHERE typeof(created_at) != 'integer'
		   OR typeof(expires_at) != 'integer'
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var token string
		var createdValue interface{}
		var expiresValue interface{}
		if err := rows.Scan(&token, &createdValue, &expiresValue); err != nil {
			return err
		}

		createdAt, err := parseUnixValue(createdValue)
		if err != nil {
			return fmt.Errorf("normalize created_at for %s: %w", token, err)
		}
		expiresAt, err := parseUnixValue(expiresValue)
		if err != nil {
			return fmt.Errorf("normalize expires_at for %s: %w", token, err)
		}

		if _, err := db.Exec(`
			UPDATE ephemeral_rooms
			SET created_at = ?, expires_at = ?
			WHERE token = ?
		`, createdAt, expiresAt, token); err != nil {
			return err
		}
	}

	return rows.Err()
}

func scanUnixValueRow(row *sql.Row) (int64, error) {
	var value interface{}
	if err := row.Scan(&value); err != nil {
		return 0, err
	}
	return parseUnixValue(value)
}

func parseUnixValue(value interface{}) (int64, error) {
	switch v := value.(type) {
	case int64:
		return v, nil
	case int:
		return int64(v), nil
	case time.Time:
		return v.Unix(), nil
	case []byte:
		return parseUnixOrTime(string(v))
	case string:
		return parseUnixOrTime(v)
	default:
		return 0, fmt.Errorf("unsupported time value type %T", value)
	}
}

func parseUnixOrTime(s string) (int64, error) {
	if unix, err := strconv.ParseInt(s, 10, 64); err == nil {
		return unix, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.Unix(), nil
	}
	if t, err := time.Parse("2006-01-02 15:04:05.999999999 -0700 -0700", s); err == nil {
		return t.Unix(), nil
	}
	return 0, errors.New("invalid unix/time format")
}
