# 🎭 Playwright Trace Upload API

API для загрузки и управления Playwright trace файлами в Supabase Storage.

## Architecture

- **Storage:** Supabase Storage bucket `traces`
- **Database:** Table `trace_files` для метаданных
- **Structure:** `traces/{userId}/{filename}.zip`
- **Access:** Private bucket с signed URLs (valid for 1 hour)

---

## Endpoints

### 1. Upload Trace File

**POST** `/api/v1/playwright/upload-trace`

Загружает Playwright trace .zip файл в Supabase Storage и сохраняет метаданные в БД.

**Content-Type:** `multipart/form-data`

**Parameters:**
- `trace` (file, required) - .zip файл с trace
- `userId` (string, required) - ID пользователя
- `testId` (string, optional) - ID теста
- `browser` (string, optional) - Браузер (chrome, firefox, etc.)
- `metadata` (object, optional) - Дополнительные метаданные

**Response (Success):**
```json
{
  "success": true,
  "message": "Trace file uploaded successfully",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "fileName": "trace_1699123456_user_123_test_456_chrome.zip",
    "storagePath": "traces/user_123/trace_1699123456_user_123_test_456_chrome.zip",
    "publicUrl": "https://xxx.supabase.co/storage/v1/object/public/traces/...",
    "fileSize": 1024000,
    "uploadedAt": "2024-11-02T10:30:00.000Z",
    "testId": "test_456",
    "userId": "user_123"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "userId is required",
  "error": "MISSING_USER_ID"
}
```

---

### 2. Get Trace Download URL

**GET** `/api/v1/playwright/trace/:id`

Генерирует signed URL для скачивания trace файла из Supabase Storage.

**Parameters:**
- `id` (path, required) - ID trace файла
- `userId` (query, optional) - ID пользователя для security check

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "fileName": "trace_1699123456_user_123_test_456_chrome.zip",
    "downloadUrl": "https://xxx.supabase.co/storage/v1/object/sign/traces/...",
    "expiresIn": 3600,
    "fileSize": 1024000,
    "createdAt": "2024-11-02T10:30:00.000Z"
  }
}
```

---

### 3. List Trace Files

**GET** `/api/v1/playwright/traces`

Возвращает список trace файлов с фильтрацией по testId или userId.

**Parameters:**
- `testId` (query, optional) - Фильтр по test ID
- `userId` (query, optional) - Фильтр по user ID

**Note:** Требуется хотя бы один параметр (testId или userId).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": "user_123",
      "test_id": "test_456",
      "file_name": "trace_1699123456_user_123_test_456_chrome.zip",
      "storage_path": "traces/user_123/trace_1699123456_user_123_test_456_chrome.zip",
      "file_size": 1024000,
      "browser": "chrome",
      "status": "uploaded",
      "public_url": "https://...",
      "created_at": "2024-11-02T10:30:00.000Z",
      "updated_at": "2024-11-02T10:30:00.000Z"
    }
  ],
  "message": "Found 1 trace file(s)",
  "count": 1
}
```

---

### 4. Get Trace Files by User

**GET** `/api/v1/playwright/trace-files?userId=...`

Получает список всех trace файлов для конкретного пользователя.

**Parameters:**
- `userId` (query, required) - ID пользователя

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "fileName": "trace_user_123_test_test456_2025-11-02.zip",
      "testId": "test456",
      "uploadedAt": "2025-11-02T15:22:10Z",
      "size": 5482112,
      "status": "parsed",
      "browser": "chrome",
      "publicUrl": "https://..."
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "fileName": "trace_user_123_test_test789_2025-11-01.zip",
      "testId": "test789",
      "uploadedAt": "2025-11-01T11:03:54Z",
      "size": 6423210,
      "status": "uploaded",
      "browser": "firefox"
    }
  ],
  "count": 2,
  "message": "Found 2 trace file(s)"
}
```

---

### 5. Parse Trace and Get Test Steps

**GET** `/api/v1/playwright/trace/:testId/steps`

Распаковывает trace.zip файл и извлекает последовательность шагов теста для визуализации.

**Parameters:**
- `testId` (path, required) - ID теста

**Response:**
```json
{
  "success": true,
  "data": {
    "testId": "test456",
    "userId": "user_123",
    "fileName": "trace_user_123_test_test456_2025-11-02.zip",
    "totalSteps": 4,
    "steps": [
      {
        "stepId": 1,
        "type": "goto",
        "url": "https://app.qai.ai/login",
        "timestamp": 1667312123123,
        "description": "Navigate to https://app.qai.ai/login"
      },
      {
        "stepId": 2,
        "type": "fill",
        "selector": "input#email",
        "text": "test@example.com",
        "description": "Fill \"test@example.com\" into input#email"
      },
      {
        "stepId": 3,
        "type": "click",
        "selector": "button#submit",
        "description": "Click on button#submit"
      },
      {
        "stepId": 4,
        "type": "assert",
        "text": "Dashboard loaded",
        "description": "Assert: Dashboard loaded"
      }
    ],
    "parsedAt": "2025-11-02T15:25:00.000Z"
  }
}
```

**Features:**
- ✅ Automatic caching - parsed data saved to database
- ✅ Subsequent calls return cached data instantly
- ✅ Supports various action types: goto, click, fill, check, assert, etc.
- ✅ Human-readable descriptions for each step
- ✅ Ready for flow visualization

---

### 6. Delete Trace File

**DELETE** `/api/v1/playwright/trace/:id`

Удаляет trace файл из Supabase Storage и базы данных.

**Parameters:**
- `id` (path, required) - ID trace файла

**Request Body:**
```json
{
  "userId": "user_123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Trace file deleted successfully"
}
```

---

## Database Schema

### trace_files Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | User who uploaded |
| test_id | UUID | Associated test (nullable, optional FK to tests) |
| file_name | TEXT | Original filename |
| storage_path | TEXT | Path in Supabase Storage |
| file_size | BIGINT | File size in bytes |
| browser | TEXT | Browser name |
| status | TEXT | uploaded, parsing, parsed, failed |
| parsed_data | JSONB | Parsed trace data (nullable) |
| public_url | TEXT | Public/signed URL |
| created_at | TIMESTAMP | Upload timestamp |
| updated_at | TIMESTAMP | Last update |
| parsed_at | TIMESTAMP | Parse timestamp (nullable) |

**Note:** Foreign key constraint to `tests` table is optional and will be added automatically during migration if `tests` table exists. If you create `tests` table later, you can manually add the constraint:

```sql
ALTER TABLE trace_files
ADD CONSTRAINT fk_trace_files_test_id
FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE;
```

---

## File Constraints

- **Allowed formats:** `.zip` only
- **Max file size:** 100 MB
- **Storage:** Supabase Storage bucket `traces`
- **Path structure:** `traces/{userId}/{filename}.zip`
- **Filename format:** `trace_{timestamp}_{userId}_{testId}_{browser}.zip`

---

## Error Codes

| Code | Description |
|------|-------------|
| `FILE_MISSING` | No trace file provided |
| `MISSING_USER_ID` | userId is required |
| `INVALID_FILE_TYPE` | Only .zip files allowed |
| `FILE_TOO_LARGE` | File exceeds 100MB limit |
| `STORAGE_UPLOAD_FAILED` | Supabase Storage upload error |
| `DATABASE_INSERT_FAILED` | Failed to save metadata |
| `FILE_NOT_FOUND` | Trace file not found |
| `URL_GENERATION_FAILED` | Failed to generate signed URL |
| `DELETE_FAILED` | Failed to delete trace |

---

## Supabase Setup

### 1. Create Storage Bucket

```sql
-- In Supabase Dashboard: Storage → New bucket
-- Name: traces
-- Public: false (private)
```

### 2. Configure Storage Policies

```sql
-- Allow authenticated users to upload to their own folder
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'traces' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow users to read their own files
CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'traces' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow users to delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'traces' AND
  auth.uid()::text = (storage.foldername(name))[1]
);
```

### 3. Run Migration

```bash
# Run the migration
psql -h YOUR_SUPABASE_HOST -U postgres -d postgres -f supabase-migrations/playwright-traces.sql
```

---

## Security

- ✅ Only `.zip` files accepted
- ✅ File size limited to 100MB
- ✅ Files stored in private bucket
- ✅ Signed URLs expire after 1 hour
- ✅ Row Level Security (RLS) policies
- ✅ User can only access own files
- ✅ Automatic cleanup on upload errors

---

## Future Features

- [ ] Automatic trace parsing
- [ ] Trace viewer in browser
- [ ] Webhook notifications
- [ ] Auto-cleanup of old traces
- [ ] CDN integration for faster access
- [ ] Compression optimization

---

[← Back to API Reference](./README.md) | [Examples →](./examples.md)
