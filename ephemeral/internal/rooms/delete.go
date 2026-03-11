package rooms

import "database/sql"

func Delete(db *sql.DB, token string) error {
	_, err := db.Exec(`
		DELETE FROM ephemeral_rooms
		WHERE token = ?
	`, token)
	return err
}
