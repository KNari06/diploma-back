# RAG System Setup Guide

## ✅ Миграция применена - что дальше?

### 1️⃣ Создать первого админа

```sql
-- В Supabase Dashboard → SQL Editor
UPDATE users
SET role = 'admin'
WHERE email = 'твой@email.com';

-- Проверка
SELECT id, email, name, role FROM users WHERE role = 'admin';
```

### 2️⃣ Проверить что API работает

```bash
# Запусти backend
npm run dev

# Проверь health
curl http://localhost:3000/health

# Проверь KB stats (должен вернуть 0 chunks)
curl http://localhost:3000/api/v1/kb/stats \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN"

# Ожидаемый ответ:
# {
#   "success": true,
#   "data": {
#     "globalChunkCount": 0,
#     "globalFileCount": 0,
#     "projectChunkCount": 0,
#     "projectFileCount": 0
#   }
# }
```

### 3️⃣ Создать тестовый проект

```bash
# Создай проект через API или Supabase Dashboard
curl -X POST http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test QA Project",
    "description": "Testing RAG system"
  }'

# Сохрани PROJECT_ID из ответа
```

### 4️⃣ Загрузить глобальные знания (админ)

Создай файл с базовыми знаниями:

**`docs/global-kb/playwright-basics.md`:**
```markdown
# Playwright Testing Guide

## Что такое Playwright?

Playwright - это современный фреймворк для E2E тестирования веб-приложений.

## Основы автоматизации

### Запуск браузера

```typescript
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com');
```

### Взаимодействие с элементами

```typescript
// Клик по кнопке
await page.click('button.submit');

// Заполнение формы
await page.fill('input[name="email"]', 'test@example.com');

// Проверка текста
await expect(page.locator('h1')).toContainText('Welcome');
```

## API тестирование

### Отправка запроса

```typescript
const response = await page.request.get('https://api.example.com/users');
expect(response.status()).toBe(200);

const data = await response.json();
console.log(data);
```

### POST запрос с телом

```typescript
const response = await page.request.post('https://api.example.com/login', {
  data: {
    email: 'user@example.com',
    password: 'secret123'
  }
});

expect(response.status()).toBe(200);
```

## Best Practices

1. Используй data-testid для селекторов
2. Всегда ждите элементы перед взаимодействием
3. Группируй тесты по фичам
4. Используй beforeEach для setup
5. Очищай данные после тестов
```

Загрузи в Global KB:

```bash
curl -X POST http://localhost:3000/api/v1/kb/global/upload \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -F "file=@docs/global-kb/playwright-basics.md" \
  -F 'tags=["playwright", "testing", "guide", "e2e"]'

# Должен вернуть:
# {
#   "success": true,
#   "data": {
#     "message": "Global KB file uploaded successfully",
#     "fileName": "playwright-basics.md",
#     "chunkCount": 5
#   }
# }
```

### 5️⃣ Загрузить проектные знания (обычный юзер)

Создай файл с API спецификацией проекта:

**`docs/project-kb/api-spec.txt`:**
```
API Specification for Test Project

Base URL: https://api.myproject.com

Authentication:
- Header: Authorization: Bearer <token>
- Token получается через POST /api/v1/auth/login

Endpoints:

1. GET /api/v1/users
   - Returns list of users
   - Auth required
   - Response: { "users": [...] }

2. POST /api/v1/users
   - Create new user
   - Body: { "name": "string", "email": "string" }
   - Response: { "id": "uuid", "name": "...", "email": "..." }

3. GET /api/v1/users/:id
   - Get user by ID
   - Auth required
   - Response: { "id": "...", "name": "...", "email": "..." }

Error responses:
- 400: Bad Request
- 401: Unauthorized
- 404: Not Found
- 500: Internal Server Error
```

Загрузи в Project KB:

```bash
curl -X POST http://localhost:3000/api/v1/kb/upload \
  -H "Authorization: Bearer USER_TOKEN" \
  -F "file=@docs/project-kb/api-spec.txt" \
  -F "projectId=YOUR_PROJECT_ID"
```

### 6️⃣ Протестировать RAG в чате

```bash
# Вопрос 1: Глобальные знания (Playwright)
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Как в Playwright отправить POST запрос?",
    "context": {}
  }'

# Вопрос 2: Проектные знания (твоя API спека)
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Как создать пользователя в моем API?",
    "context": {
      "projectId": "YOUR_PROJECT_ID"
    }
  }'

# Вопрос 3: Комбинация знаний
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Напиши Playwright тест для создания пользователя через мой API",
    "context": {
      "projectId": "YOUR_PROJECT_ID"
    }
  }'
```

### 7️⃣ Проверить что RAG работает

В логах должны появиться:

```
[INFO] KB context retrieved {
  globalSources: 1,
  projectSources: 1,
  chunkCount: 3
}
```

Ответ GPT должен содержать информацию из твоих файлов.

### 8️⃣ Просмотр загруженных файлов

```bash
# Файлы проекта
curl http://localhost:3000/api/v1/kb/project-files?projectId=YOUR_PROJECT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Статистика
curl http://localhost:3000/api/v1/kb/stats?projectId=YOUR_PROJECT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 9️⃣ Удаление файла (если нужно)

```bash
curl -X DELETE http://localhost:3000/api/v1/kb/project-files \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "YOUR_PROJECT_ID",
    "fileName": "api-spec.txt"
  }'
```

---

## 🎉 Готово!

Теперь у тебя работает RAG система:
- ✅ Глобальная база знаний (для всех пользователей)
- ✅ Проектные базы знаний (для каждого проекта)
- ✅ Интеграция с чатом
- ✅ Векторный поиск
- ✅ Автоматический context для GPT

## 📊 Следующие улучшения (опционально)

1. **Добавить больше глобальных знаний:**
   - Playwright advanced guide
   - API testing best practices
   - CI/CD guides
   - Testing patterns

2. **Улучшить chunking:**
   - Semantic chunking (учитывать смысл)
   - Больше metadata (автор, дата, версия)

3. **Добавить фильтрацию по тегам:**
   ```typescript
   searchKB(query, projectId, { tags: ['playwright', 'api'] })
   ```

4. **Добавить reranking:**
   - Cross-encoder для улучшения качества поиска

5. **Добавить кэширование:**
   - Redis для кэширования embeddings

6. **Мониторинг:**
   - Отслеживание качества RAG ответов
   - Аналитика по использованию KB
