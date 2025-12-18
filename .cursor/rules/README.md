# Cursor Rules - AIApply Parser

## 📋 Активные правила

### 1. project-critical-rules.mdc (ВСЕГДА)

**Auto-applied to all files**

Критические правила которые НИКОГДА нельзя нарушать:

- 🚫 НЕ создавать документацию без разрешения
- 🚫 НЕ деплоить без разрешения
- 🚫 НЕ коммитить без запроса
- ✅ Обязательные pre-deploy проверки
- ✅ Процедура исправления ошибок на проде

### 2. code-quality-checks.mdc (auto)

**Applied to: src/\*\*/\*.js, scripts/\*\*/\*.js**

Проверки качества кода:

- Импорты после рефакторинга
- Проверка полей БД
- Дубликаты файлов
- Синтаксис и логика
- Performance паттерны

### 3. deployment-rules.mdc (manual)

**Fetch with: "Fetch rule: Deployment procedures"**

Полная процедура деплоя:

- Pre-deployment checklist
- Deployment process
- Post-deployment verification
- Rollback процедура
- Monitoring

### 4. database-schema.mdc (auto)

**Applied to: src/\*\*/\*.js, scripts/\*\*/\*.js**

Схема БД all_jobs_data:

- Правильные поля (unique_id, published_at)
- Индексы
- Связанные таблицы

### 5. docs.mdc (always applied)

**Documentation guidelines**

Правила создания документации:

- Всегда в `/docs/` папке
- Центральный индекс: `/docs/README.md`
- СПРАШИВАЙ перед созданием

### 6. prompt-optimization-rules.mdc (auto)

**Applied to: src/ai/prompts/\*\*, src/services/ai/\*\*, src/api/chat/\*\***

Правила оптимизации AI промптов:

- 🥇 Context-First подход (НЕ keyword-based!)
- 📚 Читай `/docs/development/INTENT_PARSING_GUIDE.md` ПЕРЕД изменениями
- ✅ Тестируй с known test cases
- ✅ Документируй все изменения
- 🚫 НИКОГДА не возвращайся к keyword matching

### 7. folder-structure.mdc (ВСЕГДА)

**Auto-applied to all files**

Правила структуры папок:

- 📁 `/agent` - структура по ролям (core, analysis, execution, safety, browser)
- 📁 `/config` - структура по категориям (environment, infrastructure, api, testing)
- 📁 `/websocket` - структура по слоям (core, infrastructure, middleware, handlers, types)
- 📁 `/utils` - структура по назначению (core, validation, parsing, text-processing, helpers, monitoring)
- 📁 `/services` - структура по доменам (ai, feedback, core, testing, api, auth, kb, etc.)
- ❌ НЕ создавай файлы в корне этих папок
- ✅ Всегда следуй установленной структуре при создании новых файлов
- ✅ Обновляй все импорты при перемещении файлов

## 🚨 Критически важное

### Перед КАЖДЫМ деплоем:

```bash
# 1. Синтаксис
git diff --name-only | grep '\.js$' | xargs -I {} node -c {}

# 2. Логика
grep -r "\.job\.id[^_]" src/
grep -r "published_date" src/

# 3. Локальный тест
npm start
curl http://localhost:3001/health

# 4. Деплой
./deploy-full-scp.sh

# 5. Production check
curl https://api.hrgpt.kz/health
```

### Если ошибка на проде:

```bash
exit                    # выйди из сервера
npm start               # исправь и протестируй локально
./deploy-full-scp.sh    # задеплой только после теста
```

## 🔍 Быстрые команды

```bash
# Найти проблемы
grep -r "\.job\.id[^_]" src/
grep -r "published_date" src/
grep -r "unified_jobs" src/

# Проверить импорты
grep -r "require.*config/database" src/

# Проверить синтаксис
node -c src/server.js

# Найти дубликаты
find scripts/ -name "*deploy*"
```

## 💡 Основные принципы

1. **Всегда спрашивай** перед документацией и деплоем
2. **Всегда проверяй** синтаксис и логику перед деплоем
3. **Всегда тестируй** локально перед production
4. **Никогда не исправляй** на проде - только локально
5. **Всегда проверяй** что поля существуют в БД

## 📚 Документация (когда разрешено)

- Создавать только в `/docs` папке
- Обновлять `/docs/README.md` при добавлении
- Писать кратко, без воды (экономия токенов)
- Всегда спрашивать разрешение сначала
