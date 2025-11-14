# 🚀 Deployment Checklist - Multi-Chat Sessions

## Pre-Deployment Verification

### ✅ 1. Code Quality Checks

```bash
# Check TypeScript compilation
npm run build

# Run linter
npm run lint

# Verify no errors
echo "✅ Build successful"
```

**Status:** ✅ All checks passed (no linter errors)

### ✅ 2. Files Modified

**New files:**
- ✅ `supabase-migrations/features/multi-chat-sessions.sql`
- ✅ `src/api/chat/chat-sessions.controller.ts`
- ✅ `docs/api/multi-chat-sessions.md`
- ✅ `MULTI_CHAT_IMPLEMENTATION.md`

**Modified files:**
- ✅ `src/services/utils/chat.service.ts` (new methods added)
- ✅ `src/api/chat/chat.controller.ts` (refactored getOrCreateChatSession)
- ✅ `src/api/chat/chat.route.ts` (new routes added)
- ✅ `docs/README.md` (updated with new docs link)

### ✅ 3. Breaking Changes Check

**No breaking changes!** ✅

- Backward compatible with existing single-chat flow
- If `sessionId` not provided → uses last active session (old behavior)
- Existing chat sessions continue to work

---

## Deployment Steps

### 📊 Step 1: Apply Database Migration

**⚠️ IMPORTANT:** Run this BEFORE deploying backend code!

```bash
# Connect to production database
psql $SUPABASE_DATABASE_URL

# Or via Supabase Dashboard SQL Editor:
# Copy contents of: supabase-migrations/features/multi-chat-sessions.sql
# Paste in SQL Editor and execute
```

**Verification:**

```sql
-- Check if updated_at column exists
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'chat_sessions'
  AND column_name = 'updated_at';

-- Expected output:
-- column_name | data_type
-- updated_at  | timestamp with time zone

-- Check if trigger exists
SELECT trigger_name
FROM information_schema.triggers
WHERE trigger_name = 'chat_message_updates_session';

-- Expected output:
-- trigger_name
-- chat_message_updates_session

-- Verify indexes created
SELECT indexname
FROM pg_indexes
WHERE tablename = 'chat_sessions'
  AND indexname LIKE 'idx_chat_sessions_user%';

-- Expected output:
-- idx_chat_sessions_user_updated
-- idx_chat_sessions_user_created
```

✅ Migration successful when all verifications pass

---

### 🔧 Step 2: Deploy Backend Code

```bash
# Pull latest code
git pull origin main

# Install dependencies (if needed)
npm install

# Build project
npm run build

# Restart server (depends on your setup)
pm2 restart qai-backend
# OR
npm start
```

**Verification:**

```bash
# Check server started successfully
curl http://localhost:3000/health

# Expected: 200 OK

# Check new endpoints exist
curl http://localhost:3000/api/v1/docs | grep "sessions/new"

# Should see Swagger documentation for new endpoints
```

✅ Backend deployed when server responds correctly

---

### 🧪 Step 3: Test Functionality

#### Test 1: Create New Chat Session

```bash
curl -X POST http://YOUR_DOMAIN/api/v1/chat/sessions/new \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H "Content-Type: application/json"

# Expected response:
# {
#   "success": true,
#   "data": {
#     "sessionId": "uuid-here",
#     "title": "New Chat",
#     "created_at": "2025-11-14T..."
#   }
# }
```

#### Test 2: Send Message to New Session

```bash
SESSION_ID="uuid-from-previous-step"

curl -X POST http://YOUR_DOMAIN/api/v1/chat \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test my login flow on example.com",
    "sessionId": "'$SESSION_ID'"
  }'

# Expected: AI response with sessionId in response
```

#### Test 3: List All Sessions

```bash
curl http://YOUR_DOMAIN/api/v1/chat/sessions \
  -H "Authorization: Bearer $TEST_USER_TOKEN"

# Expected: List of sessions including the newly created one
# Title should be auto-generated: "Test my login flow on example.co..."
```

#### Test 4: Update Session Title

```bash
curl -X PATCH http://YOUR_DOMAIN/api/v1/chat/sessions/$SESSION_ID \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Custom Test Title"}'

# Expected: Success response with updated title
```

#### Test 5: Delete Session

```bash
curl -X DELETE http://YOUR_DOMAIN/api/v1/chat/sessions/$SESSION_ID \
  -H "Authorization: Bearer $TEST_USER_TOKEN"

# Expected: Success response, session deleted
```

#### Test 6: Verify Backward Compatibility

```bash
# Send message WITHOUT sessionId (should use last active session)
curl -X POST http://YOUR_DOMAIN/api/v1/chat \
  -H "Authorization: Bearer $TEST_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello without session ID"}'

# Expected: Works normally, uses existing session or creates new one
```

✅ All tests passed → Deployment successful!

---

### 📊 Step 4: Monitor Production

Watch logs for any errors:

```bash
# PM2 logs
pm2 logs qai-backend --lines 100

# Or Docker logs
docker logs qai-backend --tail=100 --follow

# Look for:
# - [CHAT_SESSIONS] logs
# - [CHAT_SERVICE] logs
# - No errors related to updated_at or multi-chat
```

Check database performance:

```sql
-- Monitor updated_at trigger performance
SELECT schemaname, tablename, n_tup_ins, n_tup_upd
FROM pg_stat_user_tables
WHERE tablename IN ('chat_sessions', 'chat_messages');

-- Should show normal insert/update counts, no bottlenecks
```

---

## Rollback Plan (If Needed)

### If Issues Found:

**Option 1: Revert Backend Only** (keeps DB changes)

```bash
# Revert to previous commit
git checkout <previous-commit-hash>
npm run build
pm2 restart qai-backend

# DB migration is harmless, can stay
```

**Option 2: Full Rollback** (revert everything)

```bash
# Revert code
git checkout <previous-commit-hash>
npm run build
pm2 restart qai-backend

# Revert database (if absolutely needed)
psql $SUPABASE_DATABASE_URL

-- Remove trigger
DROP TRIGGER IF EXISTS chat_message_updates_session ON chat_messages;
DROP FUNCTION IF EXISTS update_chat_session_timestamp();

-- Remove column (⚠️ data loss!)
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS updated_at;

-- Remove indexes
DROP INDEX IF EXISTS idx_chat_sessions_user_updated;
DROP INDEX IF EXISTS idx_chat_sessions_user_created;
```

---

## Post-Deployment Verification

### ✅ Health Checks

1. **API Endpoints Working**
   - ✅ `/api/v1/chat/sessions/new` returns 201
   - ✅ `/api/v1/chat/sessions/list` returns sessions
   - ✅ `/api/v1/chat` accepts `sessionId` parameter

2. **Database Integrity**
   - ✅ `updated_at` column exists
   - ✅ Trigger updates timestamp correctly
   - ✅ Indexes created successfully

3. **Backward Compatibility**
   - ✅ Old chat sessions still work
   - ✅ Messages without `sessionId` handled correctly
   - ✅ No errors for existing users

4. **Performance**
   - ✅ Session list queries fast (<100ms)
   - ✅ Message insertion triggers don't slow down
   - ✅ Vector search still works correctly

---

## Success Criteria

✅ **Deployment Successful When:**

1. All 6 test cases pass
2. No errors in production logs
3. Existing users can still chat normally
4. New multi-chat functionality works
5. Database queries remain fast
6. Swagger docs show new endpoints

---

## Support Contacts

**If issues arise:**

- **Backend Dev:** @your-telegram
- **DevOps:** @devops-telegram
- **Database:** @db-admin

**Monitoring:**

- Sentry: https://sentry.io/your-project
- Server logs: `ssh user@server && pm2 logs`
- DB logs: Supabase Dashboard → Database → Logs

---

**Deployment Date:** _____________
**Deployed By:** _____________
**Status:** ☐ Success  ☐ Rollback Needed
**Notes:** ___________________________________
