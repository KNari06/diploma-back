# 🏗️ Database Schema

Main database schema files for QAIT Backend.

## Files

### `recreate-all-tables-with-text-user-id.sql`

**Purpose:** Complete database schema with TEXT user_id support (UUID + IP addresses)

**Contains:**
- All table definitions (25+ tables)
- Indexes (including HNSW for vectors)
- RLS (Row Level Security) policies
- Foreign key constraints
- PostgreSQL functions and triggers
- Permissions

**When to use:**
- ✅ Fresh installation
- ✅ Complete database reset
- ✅ Major version upgrades

**How to apply:**

```bash
# In Supabase SQL Editor:
\i schema/recreate-all-tables-with-text-user-id.sql

# Or via psql:
psql -h your-host -U postgres -d your-db -f schema/recreate-all-tables-with-text-user-id.sql
```

---

## ⚠️ Important Notes

1. **DESTRUCTIVE OPERATION!**
   - This script DROPS all existing tables
   - ALL DATA WILL BE LOST
   - Always backup before running

2. **Production Use:**
   ```bash
   # 1. Backup first!
   pg_dump -h host -U user -d db > backup.sql

   # 2. Test on staging
   psql -h staging -U user -d db -f schema/recreate-all-tables-with-text-user-id.sql

   # 3. If successful, apply to production
   psql -h prod -U user -d db -f schema/recreate-all-tables-with-text-user-id.sql
   ```

3. **Key Features:**
   - TEXT user_id (supports UUID and IP addresses)
   - RLS enabled on all user tables
   - Vector embeddings (pgvector extension)
   - Automatic timestamps (updated_at triggers)
   - Cascade deletes where appropriate

---

## 🔍 Verification

After applying schema, verify with:

```sql
-- Check table count
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema = 'public';
-- Expected: 25 tables

-- Check RLS enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = true;

-- Check user_id type
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE column_name IN ('user_id', 'uploaded_by');
-- Expected: TEXT
```

---

**Last updated:** 2025-11-11
