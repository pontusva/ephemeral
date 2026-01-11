INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (3, 'add_message_type', strftime('%s','now'));
