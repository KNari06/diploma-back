# 🔄 Data Migrations

Data migration scripts for QAIT Backend.

## 📋 Available Migrations

### 1️⃣ Anonymous User Migrations

#### `anonymous-to-auth-migration.sql`

**Purpose:** Migrate anonymous user data to authenticated account

**What it does:**
- Transfers chat sessions from IP to UUID
- Moves workspace ownership
- Updates test ownership
- Preserves history

**When to use:**
- After user signs up (automatic)
- Manual data migration
- Merging duplicate accounts

**How to use:**

```sql
-- Automatic (called by backend on signup)
-- No manual intervention needed

-- Manual migration (if needed):
SELECT migrate_anonymous_to_authenticated(
  'anonymous_id',  -- IP address or temp ID
  'user_uuid'      -- New authenticated user UUID
);
```

---

#### `anonymous-chat-limits.sql`

**Purpose:** Set up rate limiting for anonymous users

**What it does:**
- Creates `anonymous_chat_limits` table
- Tracks request counts by IP
- 24-hour reset window

**When to use:**
- Setting up anonymous user limits
- Rate limiting implementation

**Schema:**
```sql
CREATE TABLE anonymous_chat_limits (
  id UUID PRIMARY KEY,
  anonymous_id TEXT UNIQUE,  -- IP address
  request_count INTEGER DEFAULT 0,
  last_reset TIMESTAMP,
  created_at TIMESTAMP
);
```

---

## 🚀 How to Apply

### Single Migration:

```sql
\i migrations/anonymous-chat-limits.sql
```

### Check Migration Status:

```sql
-- Check if anonymous limits exist
SELECT COUNT(*) FROM anonymous_chat_limits;

-- Check migration function exists
SELECT routine_name
FROM information_schema.routines
WHERE routine_name = 'migrate_anonymous_to_authenticated';
```

---

## 📋 Migration Best Practices

1. **Always use transactions:**
   ```sql
   BEGIN;
   -- your migration
   COMMIT;
   ```

2. **Idempotent migrations:**
   - Use `IF NOT EXISTS`
   - Check before deleting
   - Handle already-migrated data

3. **Logging:**
   - Use `RAISE NOTICE` for progress
   - Log what was changed
   - Count affected rows

4. **Rollback plan:**
   - Document how to revert
   - Keep backups
   - Test rollback procedure

---

## 🔄 Migration Workflow

```
1. Development
   ├── Test migration locally
   ├── Verify data integrity
   └── Document any issues

2. Staging
   ├── Apply to staging DB
   ├── Run integration tests
   └── Verify with real data

3. Production
   ├── Backup database
   ├── Apply during low-traffic period
   ├── Monitor for errors
   └── Verify migration success
```

---

## ⚠️ Important Notes

- **Backup first!** Migrations modify data
- **Test thoroughly** on staging
- **Monitor during migration** on production
- **Have rollback plan** ready

---

**Last updated:** 2025-11-11
