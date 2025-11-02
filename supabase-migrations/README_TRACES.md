# Playwright Traces Storage Setup

Инструкция по настройке Supabase Storage для Playwright trace файлов.

## 📋 Quick Setup

### 1. Создать Storage Bucket

**Через Supabase Dashboard:**
1. Открой Supabase Dashboard
2. Перейди в **Storage**
3. Нажми **New bucket**
4. Настройки:
   - **Name:** `traces`
   - **Public:** ❌ (оставь private)
   - **File size limit:** 100MB
   - **Allowed MIME types:** `application/zip`

**Или через SQL:**
```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'traces',
  'traces',
  false,
  104857600,  -- 100MB
  ARRAY['application/zip']
);
```

---

### 2. Создать Database Tables

Запусти миграцию:

```bash
psql -h YOUR_SUPABASE_HOST \
     -U postgres \
     -d postgres \
     -f supabase-migrations/playwright-traces.sql
```

Или вручную через Supabase SQL Editor:
- Скопируй содержимое `playwright-traces.sql`
- Вставь в SQL Editor
- Выполни

**Note:** Миграция работает независимо от существования таблицы `tests`.
- Если `tests` существует → автоматически добавляется foreign key constraint
- Если `tests` не существует → trace_files создается без constraint, можно добавить позже

**Чтобы добавить constraint позже (если создашь tests table):**
```sql
ALTER TABLE trace_files
ADD CONSTRAINT fk_trace_files_test_id
FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE;
```

---

### 3. Настроить Storage Policies

```sql
-- Allow authenticated users to upload to their own folder
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'traces' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to read their own files
CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'traces' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow users to delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'traces' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow service role full access
CREATE POLICY "Service role has full access"
ON storage.objects
TO service_role
USING (bucket_id = 'traces')
WITH CHECK (bucket_id = 'traces');
```

---

### 4. Проверить Setup

```bash
# Test connection
curl -X GET "https://YOUR_PROJECT.supabase.co/storage/v1/bucket/traces" \
  -H "Authorization: Bearer YOUR_ANON_KEY"

# Should return bucket info
```

---

## 📁 File Structure

```
traces/
├── user_001/
│   ├── trace_1699123456_user_001_test_123_chrome.zip
│   ├── trace_1699123457_user_001_test_124_firefox.zip
│   └── ...
├── user_002/
│   └── trace_1699123458_user_002_test_125_chrome.zip
└── ...
```

---

## 🗄️ Database Schema

### trace_files Table

```sql
CREATE TABLE trace_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  test_id UUID REFERENCES tests(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  file_size BIGINT,
  browser TEXT,
  status TEXT DEFAULT 'uploaded',
  parsed_data JSONB,
  public_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  parsed_at TIMESTAMP
);
```

**Indexes:**
- `idx_trace_files_user_id` on `user_id`
- `idx_trace_files_test_id` on `test_id`
- `idx_trace_files_status` on `status`
- `idx_trace_files_created_at` on `created_at DESC`

**RLS Policies:**
- Users can view/insert/update/delete own traces only

---

## 🧪 Testing

### 1. Upload Test

```bash
curl -X POST http://localhost:3000/api/v1/playwright/upload-trace \
  -F "trace=@test-trace.zip" \
  -F "userId=550e8400-e29b-41d4-a716-446655440000" \
  -F "testId=test_123" \
  -F "browser=chrome"
```

### 2. List Traces

```bash
curl -X GET "http://localhost:3000/api/v1/playwright/traces?userId=550e8400-e29b-41d4-a716-446655440000"
```

### 3. Get Download URL

```bash
curl -X GET "http://localhost:3000/api/v1/playwright/trace/TRACE_ID"
```

### 4. Delete Trace

```bash
curl -X DELETE "http://localhost:3000/api/v1/playwright/trace/TRACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"userId": "550e8400-e29b-41d4-a716-446655440000"}'
```

---

## 🔒 Security

### Current Implementation

1. **Private Bucket:** Files not publicly accessible
2. **Signed URLs:** Temporary access (1 hour expiry)
3. **RLS Policies:** Users can only access own files
4. **Path Structure:** Files organized by userId
5. **File Validation:** Only .zip files, max 100MB

### Recommended Enhancements

1. **Authentication Middleware:**
```typescript
import { requireAuth } from '@/middleware/auth.middleware';
router.post('/upload-trace', requireAuth, upload.single('trace'), uploadTrace);
```

2. **Rate Limiting:**
```typescript
import rateLimit from 'express-rate-limit';

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 uploads per window
});

router.post('/upload-trace', uploadLimiter, ...);
```

3. **Quota Management:**
```sql
-- Add storage quota tracking
ALTER TABLE users ADD COLUMN storage_used BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN storage_limit BIGINT DEFAULT 1073741824; -- 1GB
```

---

## 🚨 Troubleshooting

### Error: "Bucket not found"
```bash
# Check if bucket exists
SELECT * FROM storage.buckets WHERE id = 'traces';

# Create if missing
INSERT INTO storage.buckets (id, name, public) VALUES ('traces', 'traces', false);
```

### Error: "Policy violation"
```bash
# Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage';

# Disable RLS for testing (NOT for production!)
ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY;
```

### Error: "File too large"
```bash
# Check bucket limit
SELECT file_size_limit FROM storage.buckets WHERE id = 'traces';

# Update limit
UPDATE storage.buckets SET file_size_limit = 104857600 WHERE id = 'traces';
```

---

## 📊 Monitoring

### Storage Usage

```sql
-- Total storage used
SELECT
  user_id,
  COUNT(*) as trace_count,
  SUM(file_size) as total_size_bytes,
  ROUND(SUM(file_size) / 1024.0 / 1024.0, 2) as total_size_mb
FROM trace_files
GROUP BY user_id
ORDER BY total_size_bytes DESC;
```

### Recent Uploads

```sql
-- Last 10 uploads
SELECT
  file_name,
  user_id,
  file_size,
  status,
  created_at
FROM trace_files
ORDER BY created_at DESC
LIMIT 10;
```

### Failed Uploads

```sql
-- Traces with issues
SELECT * FROM trace_files
WHERE status = 'failed'
ORDER BY created_at DESC;
```

---

## 🔄 Maintenance

### Cleanup Old Traces

```sql
-- Delete traces older than 30 days
DELETE FROM trace_files
WHERE created_at < NOW() - INTERVAL '30 days';

-- Storage cleanup happens automatically via cascade
```

### Archive Old Traces

```sql
-- Move to archive table
CREATE TABLE trace_files_archive AS
SELECT * FROM trace_files
WHERE created_at < NOW() - INTERVAL '90 days';

DELETE FROM trace_files
WHERE created_at < NOW() - INTERVAL '90 days';
```

---

## 📚 Resources

- [Supabase Storage Docs](https://supabase.com/docs/guides/storage)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Storage Policies](https://supabase.com/docs/guides/storage/security/access-control)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)

---

**Created:** 2024-11-02
**Last Updated:** 2024-11-02
**Version:** 1.0.0
