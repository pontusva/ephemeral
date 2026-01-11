# Migration System: Before vs After

## The Problem

### Old Implementation (Broken)

The original `runMigrations()` function blindly executed all migration files on every startup:

```go
func runMigrations(db *sql.DB) error {
    // Read all .sql files
    files := []string{"001_rooms.sql", "002_messages.sql", "003_add_message_type.sql"}

    // Execute each one, every time
    for _, file := range files {
        db.Exec(readFile(file))  // Always runs!
    }
}
```

**Migration files:**
```sql
-- 002_messages.sql
CREATE TABLE IF NOT EXISTS ephemeral_messages (
  id INTEGER PRIMARY KEY,
  message_type TEXT  -- ❌ Included in initial CREATE
);

-- 003_add_message_type.sql
ALTER TABLE ephemeral_messages
ADD COLUMN message_type TEXT;  -- ❌ Tries to add again!
```

### What Went Wrong

#### Scenario 1: Fresh Database
```
Startup → Run 002 → Creates table WITH message_type
       → Run 003 → ❌ ERROR: "duplicate column name: message_type"
```

#### Scenario 2: Existing Database (after manual fix)
```
Startup → Run 002 → "IF NOT EXISTS" skips (table exists)
       → Run 003 → Tries to add column
       → ❌ ERROR: "duplicate column name: message_type"
                   (column was added manually or in earlier run)
```

**Root Causes:**
1. No tracking of which migrations ran
2. Migrations re-run on every startup
3. CREATE TABLE includes columns that ALTER TABLE later adds
4. No way to skip already-applied migrations

---

## The Solution

### New Implementation (Correct)

Uses a tracking table to run each migration exactly once:

```go
func runMigrations(db *sql.DB) error {
    runner := migrate.NewRunner(db, "migrations")
    return runner.Run()  // Smart migration tracking
}
```

**How it works:**

1. **Creates tracking table:**
```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);
```

2. **Checks what's been applied:**
```go
appliedVersion := getMaxVersion()  // e.g., returns 2
pending := findMigrations(version > appliedVersion)  // Only [003, 004, ...]
```

3. **Applies only new migrations:**
```go
for migration in pending {
    tx := db.Begin()
    tx.Exec(migration.SQL)
    tx.Exec("INSERT INTO schema_migrations VALUES (?)", migration.Version)
    tx.Commit()
}
```

### Fixed Migration Files

```sql
-- 002_messages.sql (FIXED)
CREATE TABLE IF NOT EXISTS ephemeral_messages (
  id INTEGER PRIMARY KEY,
  -- ✓ message_type NOT included here
);

-- 003_add_message_type.sql (Same)
ALTER TABLE ephemeral_messages
ADD COLUMN message_type TEXT;  -- ✓ Will run exactly once
```

---

## Comparison Table

| Aspect | Old Implementation | New Implementation |
|--------|-------------------|-------------------|
| **Tracking** | None | `schema_migrations` table |
| **Re-runs** | Every startup | Once per migration |
| **Fresh DB** | ❌ Fails (duplicate columns) | ✓ All migrations run in order |
| **Existing DB** | ❌ Fails or skips randomly | ✓ Only new migrations run |
| **Transactions** | ❌ No | ✓ Yes - atomic |
| **Rollback** | ❌ No | ✓ Yes - on failure |
| **Error Handling** | ❌ Continues after errors | ✓ Fails fast |
| **Idempotent** | ❌ No | ✓ Yes |

---

## Example Execution Flows

### Fresh Database (No existing data)

**Old Way:**
```
Run 001_rooms.sql        → ✓ Creates ephemeral_rooms
Run 002_messages.sql     → ✓ Creates ephemeral_messages (with message_type)
Run 003_add_message_type → ❌ FAILS: column message_type already exists
Application crashes
```

**New Way:**
```
Create schema_migrations table → ✓
Check applied version         → 0 (none applied)
Run 001 in transaction        → ✓ Creates ephemeral_rooms, records version 1
Run 002 in transaction        → ✓ Creates ephemeral_messages (NO message_type), records version 2
Run 003 in transaction        → ✓ Adds message_type column, records version 3
Application starts successfully
```

### Existing Database (After restart)

**Old Way:**
```
Run 001_rooms.sql        → Skipped (IF NOT EXISTS)
Run 002_messages.sql     → Skipped (IF NOT EXISTS)
Run 003_add_message_type → ❌ FAILS: column already exists (was added on first run)
Application crashes again
```

**New Way:**
```
Check schema_migrations  → ✓ Found: versions 1, 2, 3 applied
Check for new migrations → ✓ None found (or would run only 004+)
Skip all applied ones    → ✓ Nothing to do
Application starts immediately
```

### Adding New Migration (After deployment)

**Old Way:**
```
Add 004_add_index.sql
Restart application
Run 001 → Skip (IF NOT EXISTS)
Run 002 → Skip (IF NOT EXISTS)
Run 003 → ❌ FAILS (column exists)
004 never runs
```

**New Way:**
```
Add 004_add_index.sql
Restart application
Check schema_migrations   → Versions 1, 2, 3 applied
Pending migrations        → [004]
Run 004 in transaction    → ✓ Creates index, records version 4
Application starts successfully
```

---

## Key Benefits

### 1. Correctness
- **Old:** Random failures based on DB state
- **New:** Deterministic behavior always

### 2. Fresh vs Existing DB
- **Old:** Both scenarios fail differently
- **New:** Both scenarios work correctly

### 3. Safety
- **Old:** No transactions, partial failures possible
- **New:** Atomic migrations, rollback on error

### 4. Maintainability
- **Old:** Must carefully manage IF NOT EXISTS everywhere
- **New:** Write normal SQL, runner handles idempotency

### 5. Debugging
- **Old:** Hard to know what ran
- **New:** Query `schema_migrations` table shows exactly what's applied

### 6. Production Ready
- **Old:** Will break in production
- **New:** Safe for production use

---

## Migration from Old to New

If you already have a database using the old system:

### Option 1: Fresh Start (Development only)
```bash
rm ephemeral.db
# New system creates everything correctly
```

### Option 2: Bootstrap Existing DB (Production)
```sql
-- Manually create tracking table
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);

-- Record what's already applied
INSERT INTO schema_migrations VALUES (1, 'rooms', strftime('%s', 'now'));
INSERT INTO schema_migrations VALUES (2, 'messages', strftime('%s', 'now'));
INSERT INTO schema_migrations VALUES (3, 'add_message_type', strftime('%s', 'now'));

-- Now new system takes over
```

---

## Conclusion

The new migration system:
- ✓ Fixes the duplicate column error
- ✓ Works correctly on fresh databases
- ✓ Works correctly on existing databases
- ✓ Prevents re-running migrations
- ✓ Provides transaction safety
- ✓ Is production-ready

The old system should not be used in production.
