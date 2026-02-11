# ✅ Workspace Onboarding & Logo Upload - Implementation Summary

Реализация завершена! Все файлы созданы и обновлены согласно плану.

---

## 📋 Что было сделано

### 1. ✅ База данных (Migration)
**Файл:** `supabase-migrations/20260212_workspace_onboarding_logo.sql`

- Добавлена колонка `logo_url TEXT` в таблицу `workspaces`
- Создан индекс `idx_workspaces_logo_url` для оптимизации запросов
- Добавлены комментарии и документация для RLS политик

### 2. ✅ TypeScript типы
**Файл:** `src/types/index.ts`

- Добавлены типы: `WorkspaceRole`, `WorkspaceAccountType`, `WorkspaceLogoUploadResponse`
- Расширен `WorkspaceOnboardingRequest` с новыми полями:
  - `role: WorkspaceRole`
  - `position?: string`
  - `accountType: WorkspaceAccountType`
  - `companyName?: string`
- Расширен `WorkspaceOnboardingResponse` с полями:
  - `workspace_id: string` ← **теперь возвращается в ответе**
  - Все новые поля из request
  - `logo_url?: string`

### 3. ✅ Storage Service
**Файл:** `src/services/storage/workspace-logo-storage.service.ts`

Методы:
- `uploadLogo()` — загрузка в Supabase Storage с валидацией
- `deleteLogo()` — удаление файла из storage
- `deleteOldLogo()` — парсинг URL и удаление старого logo
- `validateFile()` — проверка размера, MIME type, extension
- `getPublicUrl()` — генерация публичного URL

Константы:
- MAX_FILE_SIZE: 2MB
- ALLOWED_MIME_TYPES: PNG, JPEG, SVG, WebP
- ALLOWED_EXTENSIONS: .png, .jpg, .jpeg, .svg, .webp

### 4. ✅ Logo Controller
**Файл:** `src/api/workspace/workspace-logo.controller.ts`

Эндпоинты:
- `uploadWorkspaceLogo()` — POST /:id/logo
  - Валидация auth, UUID, file, permissions
  - Удаление старого logo
  - Загрузка нового
  - Обновление БД
  - Cleanup при ошибке

- `deleteWorkspaceLogo()` — DELETE /:id/logo
  - Валидация auth, UUID, permissions
  - Удаление из storage
  - Очистка logo_url в БД

### 5. ✅ Onboarding Controller Updates
**Файл:** `src/api/workspace/onboarding.controller.ts`

Добавлена валидация:
- `role` (обязательное) — enum validation
- `position` (опционально) — max 255 символов
- `accountType` (обязательное) — enum validation
- `companyName` (обязательное when accountType='company') — max 255 символов

Обновлены:
- `newSettings` object — сохранение новых полей в settings JSONB
- Response — добавлен `workspace_id` и все новые поля

### 6. ✅ Routes Configuration
**Файл:** `src/api/workspace/workspace.routes.ts`

Добавлено:
- Multer configuration для logo uploads
- POST /:id/logo route с middleware chain
- DELETE /:id/logo route
- Error handler middleware для multer errors
- Swagger documentation для обоих endpoints

---

## 🚀 Следующие шаги для развертывания

### Шаг 1: Применить миграцию БД

```bash
# Подключитесь к вашей Supabase БД
psql -U postgres -h your-supabase-host -d postgres
```

Затем выполните:
```sql
\i supabase-migrations/20260212_workspace_onboarding_logo.sql
```

Или через Supabase Dashboard:
- Перейдите в **SQL Editor**
- Скопируйте содержимое `supabase-migrations/20260212_workspace_onboarding_logo.sql`
- Выполните

### Шаг 2: Создать Storage Bucket

**Через Supabase Dashboard:**

1. Перейдите в **Storage** → **Create a new bucket**
2. Настройки bucket:
   - **Bucket name:** `workspace-logos`
   - **Public:** ❌ false (private)
   - **File size limit:** 2MB (2097152 bytes)
   - **Allowed MIME types:** `image/png, image/jpeg, image/svg+xml, image/webp`

### Шаг 3: Добавить RLS политики для Storage

**Через Supabase Dashboard:**

Перейдите в **Storage** → **workspace-logos** → **Policies** → **New policy**

**Policy 1: Upload**
```sql
CREATE POLICY "Users can upload logos to their workspace"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'workspace-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Policy 2: Read**
```sql
CREATE POLICY "Users can read their own workspace logos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'workspace-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Policy 3: Delete**
```sql
CREATE POLICY "Users can delete their own workspace logos"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'workspace-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Policy 4: Update**
```sql
CREATE POLICY "Users can update their own workspace logos"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'workspace-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

### Шаг 4: Проверить зависимости

Убедитесь что `multer` установлен:

```bash
npm list multer
```

Если не установлен:
```bash
npm install multer
npm install --save-dev @types/multer
```

### Шаг 5: Перезапустить сервер

```bash
npm run dev
```

---

## 🧪 Тестирование

### 1. Тест POST /workspaces/onboarding

```bash
curl -X POST http://localhost:3000/api/v1/workspaces/onboarding \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Project",
    "baseUrls": ["https://example.com"],
    "environments": { "dev": "https://dev.example.com" },
    "browserType": "chrome",
    "role": "qaEngineer",
    "position": "Senior QA Engineer",
    "accountType": "company",
    "companyName": "Acme Corp"
  }'
```

**Ожидается:**
```json
{
  "success": true,
  "data": {
    "workspace_id": "uuid-here",  ← должен вернуться!
    "name": "Test Project",
    "baseUrls": ["https://example.com"],
    "environments": { "dev": "https://dev.example.com" },
    "browserType": "chrome",
    "completed": true,
    "role": "qaEngineer",
    "position": "Senior QA Engineer",
    "accountType": "company",
    "companyName": "Acme Corp",
    "logo_url": null
  },
  "message": "Onboarding data saved successfully",
  "timestamp": "2024-02-12T..."
}
```

### 2. Тест POST /workspaces/:id/logo

```bash
curl -X POST http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "logo=@/path/to/logo.png"
```

**Ожидается:**
```json
{
  "success": true,
  "data": {
    "logo_url": "https://xxx.supabase.co/storage/v1/object/public/workspace-logos/...",
    "file_name": "logo_1707734400000.png",
    "file_size": 102400,
    "uploaded_at": "2024-02-12T10:30:00.000Z"
  },
  "message": "Logo uploaded successfully",
  "timestamp": "2024-02-12T..."
}
```

### 3. Тест GET /workspaces/:id (проверка logo_url)

```bash
curl http://localhost:3000/api/v1/workspaces/WORKSPACE_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Ожидается:** workspace object с полем `logo_url`

### 4. Тест DELETE /workspaces/:id/logo

```bash
curl -X DELETE http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Ожидается:**
```json
{
  "success": true,
  "message": "Logo deleted successfully",
  "timestamp": "2024-02-12T..."
}
```

### 5. Тесты валидации

**a) Файл >2MB:**
```bash
# Создать файл 3MB
dd if=/dev/zero of=large.png bs=1M count=3

curl -X POST http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "logo=@large.png"
```
Ожидается: `400 "File too large"`

**b) Неверный тип файла (.txt):**
```bash
echo "test" > test.txt

curl -X POST http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "logo=@test.txt"
```
Ожидается: `400 "Only PNG, JPG, SVG, and WebP files are allowed"`

**c) accountType=company без companyName:**
```bash
curl -X POST http://localhost:3000/api/v1/workspaces/onboarding \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "baseUrls": ["https://example.com"],
    "environments": { "dev": "https://dev.example.com" },
    "browserType": "chrome",
    "role": "qaEngineer",
    "accountType": "company"
  }'
```
Ожидается: `400 "Missing required field: companyName"`

---

## 📊 Checklist финального развертывания

- [ ] ✅ Migration применён в БД
- [ ] ✅ Bucket `workspace-logos` создан в Supabase Dashboard
- [ ] ✅ RLS политики добавлены (4 политики)
- [ ] ✅ `multer` установлен
- [ ] ✅ Сервер перезапущен
- [ ] ✅ POST /workspaces/onboarding тест пройден
- [ ] ✅ POST /workspaces/:id/logo тест пройден
- [ ] ✅ GET /workspaces/:id возвращает logo_url
- [ ] ✅ DELETE /workspaces/:id/logo тест пройден
- [ ] ✅ Валидация работает (размер файла, тип, companyName)

---

## 📝 Изменённые и созданные файлы

### Созданные:
1. `supabase-migrations/20260212_workspace_onboarding_logo.sql`
2. `src/services/storage/workspace-logo-storage.service.ts`
3. `src/api/workspace/workspace-logo.controller.ts`

### Изменённые:
1. `src/types/index.ts`
2. `src/api/workspace/onboarding.controller.ts`
3. `src/api/workspace/workspace.routes.ts`

---

## 🔍 Примечания

1. **Storage bucket** должен быть создан **вручную** через Supabase Dashboard — SQL миграция не создаёт bucket (требуются admin права)
2. **RLS политики** для storage также добавляются через Dashboard
3. **Путь в storage:** `{userId}/{workspaceId}/logo_{timestamp}.{ext}`
4. **Старый логотип** автоматически удаляется при загрузке нового
5. **Cleanup при ошибке:** если DB update fails, загруженный файл удаляется (rollback)
6. **Permissions:** требуется `WORKSPACE_WRITE` permission (owner или full_access role)

---

## 🎉 Готово!

Все изменения реализованы согласно плану. После выполнения шагов развертывания (миграция, bucket, RLS) API будет полностью функциональным.

Для проверки используйте тесты из раздела **Тестирование** выше.
