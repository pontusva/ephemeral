CREATE TABLE IF NOT EXISTS ephemeral_rooms (
  token TEXT PRIMARY KEY,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL
);