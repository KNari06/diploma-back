# 🗄️ Supabase Migrations

Организованная структура миграций для QAIT Backend.

## 📁 Структура

```
supabase-migrations/
├── schema/              # Основные схемы БД
├── features/            # Feature-specific migrations
├── migrations/          # Data migrations and updates
├── docs/                # Documentation
└── archive/             # Старые/устаревшие миграции
```

---

## 📂 Описание папок

### 1️⃣ `schema/` - Основные схемы БД

Полные схемы создания/пересоздания таблиц:

- `recreate-all-tables-with-text-user-id.sql` - Основная схема со всеми таблицами

**Когда использовать:**
- Новая установка проекта
- Полное пересоздание БД
- Major версионные изменения

---

### 2️⃣ `features/` - Функциональные миграции

Миграции для отдельных фич:

- `auth-sync.sql` - Auth синхронизация
- `jira-oauth.sql` - Jira OAuth интеграция
- `knowledge-base-safe.sql` - Knowledge Base
- `playwright-traces.sql` - Playwright trace files
- `api-configurations.sql` - API конфигурации
- `workspaces.sql` - Workspace management
- `default-project.sql` - Default project setup
- `autonomous-exploration.sql` - Autonomous testing
- `test-chat-mappings.sql` - Test-chat связи
- `token-based-credits-system.sql` - Token/credits система

**Когда использовать:**
- Добавление новой фичи
- Обновление существующей фичи
- Feature flags

---

### 3️⃣ `migrations/` - Миграции данных

Миграции для изменения/обновления данных:

- `anonymous-to-auth-migration.sql` - Миграция анонимных → auth
- `anonymous-chat-limits.sql` - Лимиты для анонимов

**Когда использовать:**
- Изменение формата данных
- Массовые обновления
- Data transformations

---

### 4️⃣ `docs/` - Документация

Документация по миграциям:

- `QUICK_START.md` - Быстрый старт
- `README_TRACES.md` - Trace файлы документация

**Когда использовать:**
- Инструкции по применению миграций
- Troubleshooting guides
- Examples

---

### 5️⃣ `archive/` - Архив

Устаревшие миграции (для истории):

- Старые версии миграций
- Deprecated features
- Legacy schemas

**Когда использовать:**
- Миграция больше не актуальна
- Заменена новой версией
- Только для справки

---

## 🚀 Как использовать

### Новая установка:

```sql
-- 1. Основная схема
\i schema/recreate-all-tables-with-text-user-id.sql

-- 2. Фичи (выборочно)
\i features/auth-sync.sql
\i features/jira-oauth.sql
\i features/knowledge-base-safe.sql
```

### Обновление существующей БД:

```sql
-- Применить конкретную фичу
\i features/token-based-credits-system.sql
```

### Миграция данных:

```sql
-- Мигрировать анонимных юзеров
\i migrations/anonymous-to-auth-migration.sql
```

---

## 📋 Правила

1. **Именование файлов:**
   - `kebab-case.sql`
   - Описательные имена
   - Версионирование: `v1-feature-name.sql`, `v2-feature-name.sql`

2. **Структура миграции:**
   ```sql
   -- =========================================
   -- Migration: Feature Name
   -- Created: YYYY-MM-DD
   -- Description: What this does
   -- =========================================
   
   BEGIN;
   
   -- Your SQL here
   
   COMMIT;
   ```

3. **Безопасность:**
   - Всегда используй `CREATE OR REPLACE` для функций
   - Используй `IF NOT EXISTS` для таблиц
   - Используй транзакции `BEGIN/COMMIT`
   - Проверяй на существование перед DROP

4. **Документация:**
   - Комментарии на английском
   - Описание цели миграции
   - Примеры использования

---

## ⚠️ Важно

- **НЕ удаляй** файлы из `schema/` - это основа проекта
- **НЕ изменяй** примененные миграции - создавай новые
- **Тестируй локально** перед применением на production
- **Делай бэкап** перед major миграциями

---

## 📞 Помощь

Если не уверен какую миграцию применить - спроси в документации или у команды.

**Last updated:** 2025-11-11
