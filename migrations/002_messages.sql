-- Rooms table (already mostly what you have)
CREATE TABLE IF NOT EXISTS ephemeral_rooms (
  id TEXT PRIMARY KEY,        -- public room identifier (random, non-sequential)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_expires_at
  ON ephemeral_rooms (expires_at);


-- Persisted encrypted messages
CREATE TABLE IF NOT EXISTS ephemeral_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,

  seq INTEGER NOT NULL,
  message_type TEXT  -- MSG, IMG_META, IMG_CHUNK, IMG_END
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id
  ON ephemeral_messages (room_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON ephemeral_messages (created_at);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq
  ON ephemeral_messages (room_id, seq);