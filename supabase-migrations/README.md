# Knowledge Base Migration Guide

## 📋 Что делает миграция

Создает RAG систему для QAI с двумя базами знаний:
- **Global KB** - универсальные знания (Playwright, API testing, best practices)
- **Project KB** - проектные знания (API спеки, кастомные гайды)

## ✅ Подготовка

### 1. Проверь что основная схема применена
```sql
-- Должны существовать:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('users', 'projects');
```

### 2. Проверь vector extension
```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

### 3. Проверь что у users есть role column
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'role';
```

## 🚀 Применение миграции

### Вариант 1: Через Supabase Dashboard (рекомендуется)

1. Открой Supabase Dashboard
2. SQL Editor → New Query
3. Скопируй содержимое `knowledge-base-safe.sql`
4. Run (F5)
5. Проверь что все прошло успешно

### Вариант 2: Через Supabase CLI

```bash
# Из корня проекта
supabase db push --file supabase-migrations/knowledge-base-safe.sql

# Или напрямую
psql $DATABASE_URL -f supabase-migrations/knowledge-base-safe.sql
```

## 🔍 Проверка после применения

```sql
-- 1. Таблицы созданы
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%kb_chunks%';
-- Ожидается: global_kb_chunks, project_kb_chunks

-- 2. Индексы созданы
SELECT indexname FROM pg_indexes
WHERE tablename IN ('global_kb_chunks', 'project_kb_chunks');
-- Должно быть ~8-10 индексов

-- 3. RLS включен
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE '%kb_chunks%';
-- Оба должны быть true

-- 4. Функции созданы
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name LIKE '%kb%';
-- Ожидается: search_global_kb, search_project_kb, get_kb_stats

-- 5. Тест vector
SELECT '[1,2,3]'::vector(3);
-- Должно вернуть: [1,2,3]
```

## 🔧 Rollback (если что-то пошло не так)

```sql
-- ВНИМАНИЕ: Удаляет все данные!
DROP TABLE IF EXISTS project_kb_chunks CASCADE;
DROP TABLE IF EXISTS global_kb_chunks CASCADE;
DROP FUNCTION IF EXISTS search_global_kb CASCADE;
DROP FUNCTION IF EXISTS search_project_kb CASCADE;
DROP FUNCTION IF EXISTS get_kb_stats CASCADE;
```

## 📊 Тест после применения

```bash
# Запусти сервер
npm run dev

# Проверь health endpoint
curl http://localhost:3000/health

# Проверь KB stats
curl http://localhost:3000/api/v1/kb/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## ⚠️ Важные замечания

1. **Vector extension** - уже должен быть установлен (из основной схемы)
2. **HNSW индексы** - могут долго строиться на больших данных (это нормально)
3. **RLS политики** - используют `auth.uid()`, требуется Supabase Auth
4. **Admin role** - убедись что у админа `role = 'admin'` в таблице users

## 🐛 Troubleshooting

### Ошибка: "extension vector does not exist"
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Ошибка: "relation users does not exist"
Сначала примени основную схему: `supabase-schema.sql`

### Ошибка: "function auth.uid() does not exist"
Supabase Auth не настроен. Проверь конфигурацию.

### Ошибка при создании HNSW индекса
```sql
-- Попробуй без HNSW (медленнее, но всегда работает)
DROP INDEX IF EXISTS idx_global_kb_embedding;
CREATE INDEX idx_global_kb_embedding ON global_kb_chunks USING ivfflat (embedding vector_cosine_ops);
```

## 📚 Следующие шаги

1. Создай первого админа:
```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

2. Загрузи глобальные знания:
```bash
curl -X POST http://localhost:3000/api/v1/kb/global/upload \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -F "file=@docs/playwright-guide.md" \
  -F 'tags=["playwright", "testing"]'
```

3. Тестируй RAG в чате:
```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Как тестировать API в Playwright?"}'
```
