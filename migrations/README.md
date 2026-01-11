# Database Migrations

This directory contains SQLite database migrations for the ephemeral application.

## How the Migration System Works

The migration system uses a `schema_migrations` table to track which migrations have been applied. Each migration runs exactly once, in order, within a transaction.

### Schema Migrations Table

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)
```

This table is automatically created on first run and tracks:
- `version`: The migration version number (e.g., 1, 2, 3)
- `name`: The migration name (e.g., "rooms", "messages", "add_message_type")
- `applied_at`: Unix timestamp when the migration was applied

## Fresh Database vs Existing Database

### Fresh Database (No schema_migrations table)
1. The runner creates the `schema_migrations` table
2. All migrations (001, 002, 003, etc.) run in order
3. Each migration is recorded in `schema_migrations`

### Existing Database (schema_migrations exists)
1. The runner queries for the highest applied version (e.g., version 2)
2. Only migrations with higher versions run (e.g., 003, 004, etc.)
3. Previously applied migrations are skipped

This ensures:
- Fresh databases get the full schema from all migrations
- Existing databases only get new migrations
- No duplicate columns or tables
- No "column already exists" errors

## Migration File Naming

Migrations must follow the naming convention:
```
NNN_descriptive_name.sql
```

Examples:
- `001_rooms.sql`
- `002_messages.sql`
- `003_add_message_type.sql`

The numeric prefix determines execution order.

## Creating New Migrations

1. Choose the next sequential number (e.g., if 003 exists, use 004)
2. Create a descriptive name
3. Write ONLY the changes needed for this migration

### Example: Adding a New Column

If you want to add a `priority` column to `ephemeral_messages`:

**004_add_priority.sql**
```sql
-- Add priority column for message ordering
ALTER TABLE ephemeral_messages
ADD COLUMN priority INTEGER DEFAULT 0;
```

### Example: Creating a New Table

**005_sessions.sql**
```sql
-- User sessions table
CREATE TABLE ephemeral_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires_at ON ephemeral_sessions (expires_at);
```

## Important Rules

### DO:
- Write migrations that can run on both fresh and existing databases
- Use CREATE TABLE (without IF NOT EXISTS) for new migrations
- Use ALTER TABLE to modify existing tables in new migrations
- Keep each migration focused on one logical change
- Run migrations in a transaction (automatically handled)

### DON'T:
- Modify existing migration files after they've been deployed
- Use CREATE TABLE IF NOT EXISTS in new migrations
- Add ALTER TABLE statements for columns that already exist in earlier migrations
- Skip version numbers in the sequence

## Transaction Safety

Each migration runs in a transaction:
1. Begin transaction
2. Execute migration SQL
3. Record in schema_migrations
4. Commit transaction

If ANY step fails:
- The entire migration is rolled back
- No partial changes are applied
- The application exits with a clear error message

## Verifying Applied Migrations

To see which migrations have been applied:

```sql
SELECT * FROM schema_migrations ORDER BY version;
```

Output:
```
version | name               | applied_at
--------|-------------------|------------
1       | rooms             | 1704067200
2       | messages          | 1704067200
3       | add_message_type  | 1704067201
```

## Troubleshooting

### "column already exists" error
This means:
- A migration is trying to add a column that already exists
- Usually caused by including a column in a CREATE TABLE that's later added by ALTER TABLE
- Fix: Remove the column from the CREATE TABLE migration, or remove the ALTER TABLE migration

### "no such table" error on fresh database
This means:
- A migration references a table that doesn't exist yet
- Check migration order - table must be created before being altered
- Ensure migrations run in the correct sequence

### Migration failed mid-sequence
- Check the `schema_migrations` table to see which version failed
- Fix the migration file
- The runner will retry from that version on next startup
