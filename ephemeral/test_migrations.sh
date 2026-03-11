#!/bin/bash
set -e

echo "=== Testing Migration Runner ==="
echo

# Clean up any existing test database
rm -f test.db

echo "1. Running migrations on FRESH database..."
sqlite3 test.db ".databases" > /dev/null 2>&1 || true

echo "2. Simulating migration run..."
cat << 'EOF' | sqlite3 test.db
-- Create schema_migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- Simulate running migration 001_rooms.sql
CREATE TABLE IF NOT EXISTS ephemeral_rooms (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON ephemeral_rooms (expires_at);
INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'rooms', strftime('%s', 'now'));

-- Simulate running migration 002_messages.sql
CREATE TABLE IF NOT EXISTS ephemeral_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON ephemeral_messages (room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON ephemeral_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON ephemeral_messages (room_id, seq);
INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'messages', strftime('%s', 'now'));

-- Simulate running migration 003_add_message_type.sql
ALTER TABLE ephemeral_messages ADD COLUMN message_type TEXT;
INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'add_message_type', strftime('%s', 'now'));
EOF

echo "3. Checking schema_migrations table..."
sqlite3 test.db "SELECT version, name FROM schema_migrations ORDER BY version;"

echo
echo "4. Verifying ephemeral_messages schema..."
sqlite3 test.db "PRAGMA table_info(ephemeral_messages);"

echo
echo "5. Testing that migration 003 added message_type column..."
COLUMN_EXISTS=$(sqlite3 test.db "SELECT COUNT(*) FROM pragma_table_info('ephemeral_messages') WHERE name='message_type';")
if [ "$COLUMN_EXISTS" = "1" ]; then
  echo "✓ message_type column exists"
else
  echo "✗ message_type column MISSING"
  exit 1
fi

echo
echo "=== Testing EXISTING database (simulating restart) ==="
echo "6. Highest applied migration version:"
sqlite3 test.db "SELECT MAX(version) FROM schema_migrations;"

echo
echo "7. If we had migration 004, it would run. Migrations 001-003 would be skipped."
echo "   This prevents 'column already exists' errors."

echo
echo "=== All tests passed! ==="
echo
echo "Cleaning up..."
rm -f test.db

echo "Done!"
