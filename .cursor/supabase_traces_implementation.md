# ✅ Playwright Traces + Supabase Storage - Полная реализация

## 🎯 Что реализовано

### Backend Implementation

```
src/api/playwright/
├── playwright.controller.ts   ✅ 4 функции (upload, get, list, delete)
└── playwright.route.ts         ✅ 4 endpoints + multer config

src/types/index.ts              ✅ Типы для trace файлов

supabase-migrations/
├── playwright-traces.sql       ✅ Миграция БД + RLS policies
└── README_TRACES.md            ✅ Setup инструкция

docs/api/
└── playwright.md               ✅ Обновлена документация
```

---

## 🏗️ Architecture

### Storage Structure

```
Supabase Storage Bucket: traces (private)
└── {userId}/
    └── trace_{timestamp}_{userId}_{testId}_{browser}.zip
```

### Database Schema

```sql
trace_files
├── id (UUID, PK)
├── user_id (UUID) ← Привязка к пользователю
├── test_id (UUID, nullable) ← Опциональная привязка к тесту
├── file_name (TEXT)
├── storage_path (TEXT, unique)
├── file_size (BIGINT)
├── browser (TEXT)
├── status (TEXT) ← uploaded|parsing|parsed|failed
├── parsed_data (JSONB) ← Для будущего парсинга
├── public_url (TEXT)
├── created_at (TIMESTAMP)
├── updated_at (TIMESTAMP)
└── parsed_at (TIMESTAMP, nullable)

Indexes:
- idx_trace_files_user_id
- idx_trace_files_test_id
- idx_trace_files_status
- idx_trace_files_created_at DESC
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/playwright/upload-trace` | Upload trace to Supabase Storage |
| GET | `/api/v1/playwright/trace/:id` | Get signed download URL |
| GET | `/api/v1/playwright/traces` | List traces (filter by userId/testId) |
| DELETE | `/api/v1/playwright/trace/:id` | Delete trace from storage & DB |

---

## 💡 Key Features

### 1. Upload to Supabase Storage

```typescript
// В контроллере:
await supabase.storage
  .from('traces')
  .upload(storagePath, req.file.buffer, {
    contentType: 'application/zip',
    upsert: false,
    cacheControl: '3600',
  });

// Сохранение метаданных в БД
await supabase
  .from('trace_files')
  .insert({
    id: traceId,
    user_id: userId,
    test_id: testId,
    file_name: fileName,
    storage_path: storagePath,
    file_size: fileSize,
    browser,
    status: 'uploaded',
    public_url: publicUrl,
  });
```

### 2. Signed URLs для скачивания

```typescript
// Генерация signed URL (valid for 1 hour)
const { data: signedUrlData } = await supabase.storage
  .from('traces')
  .createSignedUrl(storagePath, 3600);
```

### 3. Multer Memory Storage

```typescript
// Используем memoryStorage для прямой загрузки в Supabase
const storage = multer.memoryStorage();

// req.file.buffer доступен для upload
```

### 4. Автоматическая очистка при ошибках

```typescript
// Если insert в БД failed, удаляем файл из storage
if (insertError) {
  await supabase.storage.from('traces').remove([storagePath]);
}
```

### 5. Связь с test_results

```typescript
// Обновляем test_results если testId предоставлен
if (testId && browser) {
  await supabase
    .from('test_results')
    .update({
      trace_file: fileName,
      trace_uploaded_at: new Date().toISOString(),
    })
    .eq('test_id', testId)
    .eq('browser', browser);
}
```

---

## 🔒 Security

### Supabase Storage Policies

```sql
-- Users can upload to own folder only
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'traces' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can read own files only
CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'traces' AND
  (storage.foldername(name))[1] = auth.uid()::text
);
```

### RLS на trace_files

```sql
-- Users can view own traces
CREATE POLICY "Users can view own traces"
ON trace_files FOR SELECT
USING (auth.uid()::text = user_id::text);

-- Users can insert own traces
CREATE POLICY "Users can insert own traces"
ON trace_files FOR INSERT
WITH CHECK (auth.uid()::text = user_id::text);
```

### Validation

- ✅ Only .zip files
- ✅ Max 100MB
- ✅ userId required
- ✅ Signed URLs expire after 1 hour
- ✅ Path traversal protection
- ✅ Files organized by userId

---

## 📋 Usage Examples

### 1. Upload Trace

```bash
curl -X POST http://localhost:3000/api/v1/playwright/upload-trace \
  -F "trace=@trace.zip" \
  -F "userId=user_123" \
  -F "testId=test_456" \
  -F "browser=chrome"
```

**Response:**
```json
{
  "success": true,
  "message": "Trace file uploaded successfully",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "fileName": "trace_1730545200000_user_123_test_456_chrome.zip",
    "storagePath": "traces/user_123/trace_1730545200000_user_123_test_456_chrome.zip",
    "publicUrl": "https://xxx.supabase.co/storage/v1/object/public/traces/...",
    "fileSize": 1024000,
    "uploadedAt": "2024-11-02T10:00:00.000Z",
    "testId": "test_456",
    "userId": "user_123"
  }
}
```

### 2. Get Download URL

```bash
curl "http://localhost:3000/api/v1/playwright/trace/550e8400-e29b-41d4-a716-446655440000"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "fileName": "trace_1730545200000_user_123_test_456_chrome.zip",
    "downloadUrl": "https://xxx.supabase.co/storage/v1/object/sign/traces/...",
    "expiresIn": 3600,
    "fileSize": 1024000,
    "createdAt": "2024-11-02T10:00:00.000Z"
  }
}
```

### 3. List User's Traces

```bash
curl "http://localhost:3000/api/v1/playwright/traces?userId=user_123"
```

### 4. List Test's Traces

```bash
curl "http://localhost:3000/api/v1/playwright/traces?testId=test_456"
```

### 5. Delete Trace

```bash
curl -X DELETE "http://localhost:3000/api/v1/playwright/trace/550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123"}'
```

---

## 🚀 Setup Steps

### 1. Создать Supabase Storage Bucket

```sql
-- Через Supabase Dashboard: Storage → New bucket
-- Name: traces
-- Public: false
```

### 2. Запустить миграцию

```bash
psql -h YOUR_SUPABASE_HOST \
     -U postgres \
     -d postgres \
     -f supabase-migrations/playwright-traces.sql
```

### 3. Настроить Storage Policies

См. `supabase-migrations/README_TRACES.md`

### 4. Тестирование

```bash
# Upload test
curl -X POST http://localhost:3000/api/v1/playwright/upload-trace \
  -F "trace=@test.zip" \
  -F "userId=test_user" \
  -F "testId=test_123"
```

---

## 📊 Database Queries

### Total storage per user

```sql
SELECT
  user_id,
  COUNT(*) as trace_count,
  SUM(file_size) as total_bytes,
  ROUND(SUM(file_size) / 1024.0 / 1024.0, 2) as total_mb
FROM trace_files
GROUP BY user_id
ORDER BY total_bytes DESC;
```

### Recent uploads

```sql
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

### Failed uploads

```sql
SELECT * FROM trace_files
WHERE status = 'failed'
ORDER BY created_at DESC;
```

---

## ✅ Проверки

- ✅ TypeScript компиляция
- ✅ Type-check passed
- ✅ Нет linter ошибок
- ✅ Multer использует memoryStorage
- ✅ Upload в Supabase Storage
- ✅ Метаданные в БД
- ✅ Signed URLs generation
- ✅ Delete с очисткой storage
- ✅ RLS policies
- ✅ Документация обновлена

---

## 🔄 Future Enhancements

### 1. Automatic Trace Parsing

```typescript
// После загрузки, запустить парсинг
const parsed = await parseTraceFile(buffer);
await supabase
  .from('trace_files')
  .update({
    status: 'parsed',
    parsed_data: parsed,
    parsed_at: new Date().toISOString(),
  })
  .eq('id', traceId);
```

### 2. Webhooks

```typescript
// Notify on upload complete
await sendWebhook(userId, {
  event: 'trace.uploaded',
  traceId,
  fileName,
});
```

### 3. CDN Integration

```typescript
// Generate CDN URL
const cdnUrl = `https://cdn.example.com/traces/${storagePath}`;
```

### 4. Auto-cleanup

```sql
-- Cron job to delete old traces
DELETE FROM trace_files
WHERE created_at < NOW() - INTERVAL '30 days';
```

### 5. Storage Quotas

```typescript
// Check user quota before upload
const { data } = await supabase
  .from('trace_files')
  .select('file_size')
  .eq('user_id', userId);

const totalUsed = data.reduce((sum, t) => sum + t.file_size, 0);
const QUOTA = 1073741824; // 1GB

if (totalUsed + fileSize > QUOTA) {
  throw new Error('Storage quota exceeded');
}
```

---

## 📚 Документация

- **API Docs:** `docs/api/playwright.md`
- **Setup Guide:** `supabase-migrations/README_TRACES.md`
- **Migration:** `supabase-migrations/playwright-traces.sql`
- **Swagger:** `/api/docs` (localhost:3000)

---

**Created:** 2024-11-02
**Status:** ✅ Production Ready
**Version:** 1.0.0
