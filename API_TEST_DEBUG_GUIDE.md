# 🔍 API Test Debug Guide

## 🔴 Проблема
Пользователь пишет "начинай тестинг" после одобрения плана, но:
- Нет WebSocket прогресс-обновлений
- Нет логов на сервере
- Висит на "🔄 Executing API test..."

## 🎯 Причина
**"🔄 Executing API test..." - это AI генерирует этот текст, а не наш код выполняется!**

Pending plan НЕ находился потому что:
1. ❌ Сервер искал план ТОЛЬКО если фронтенд отправил `conversationId`
2. ❌ Фронтенд НЕ отправлял `conversationId` обратно при approval
3. ❌ План не находился, сообщение шло в AI как general chat
4. 💬 AI отвечал "I will proceed..." но ничего не выполнялось

## ✅ Исправления

### 1. ✅ Исправлен поиск pending plan (ГЛАВНЫЙ ФИКС!)
**Файлы:**
- `src/services/testing/exploration-cache.service.ts`
- `src/api/chat/chat.controller.ts`

**Добавлена функция `getLatestPendingTestPlan(userId)`** - ищет последний pending plan если `conversationId` не передан.

**Теперь логика:**
1. Если есть `conversationId` → ищет по нему
2. Если нет → ищет последний pending plan пользователя (fallback)

```typescript
// FALLBACK: If no conversationId provided, check if user has any recent pending plan
if (!pendingPlan) {
  logger.info('[CHAT] No conversationId or plan not found, checking for latest pending plan', { userId });
  pendingPlan = await getLatestPendingTestPlan(userId);
}
```

### 2. Добавлены WebSocket прогресс-обновления
**Файл:** `src/services/testing/apiTest.service.ts`

Теперь отправляет:
- **72%** - `📡 Sending ${method} request...`
- **80%** - `📥 Processing response (${status})...`
- **90%** - `✅ API test completed (${ms}ms)`
- **90%** - `⏱️ Request timeout` (при timeout)
- **90%** - `❌ API test failed` (при ошибке)

### 3. Добавлены детальные логи
**Файлы:**
- `src/api/chat/chat.controller.ts`
- `src/services/testing/apiTest.service.ts`
- `src/services/ai/ai-helpers.service.ts`

**Логи для диагностики:**

```
🟢 [APPROVAL] Test approved, executing now...
🚀 [EXECUTE] ==> FUNCTION CALLED - Test plan approved
🔵 [API_TEST] Starting API test execution
🔵 [API_TEST] Step 1: Confirming plan...
🔵 [API_TEST] Step 2: Plan confirmed, extracting details...
🔵 [API_TEST] Step 3: Calling executeApiTest

🟢 [executeApiTest] FUNCTION CALLED
🔵 [executeApiTest] Step 1: Validating request...
🔵 [executeApiTest] Step 2: Request validated, preparing fetch
🔵 [executeApiTest] Step 3: Emitting progress and starting fetch...
📡 [executeApiTest] Emitting WebSocket progress
🔵 [executeApiTest] Step 4: Calling fetch()...
🔵 [executeApiTest] Step 5: Fetch completed!
```

### 4. Улучшена детекция approval
**Файл:** `src/services/ai/ai-helpers.service.ts`

Добавлены keywords:
- `начинай`
- `начни`
- `тестинг`
- `тест`

## 📊 Что должно быть ПОСЛЕ "🔄 Executing API test..."

**Правильный flow:**

1. **AI генерирует текст** (не наш код!):
   - "Thank you for confirming! I will proceed with executing..."
   - "🔄 Executing API test..."

2. **Наш код начинает выполнение:**
   ```
   🔍 [CHAT] Looking for pending plan by conversationId
   🔍 [CHAT] Found pending test plan, checking for approval
   🔍 [APPROVAL_DETECT] Starting detection
   ✅ [APPROVAL_DETECT] User approval detected
   🟢 [APPROVAL] Test approved, executing now...
   🚀 [EXECUTE] ==> FUNCTION CALLED
   🔵 [API_TEST] Starting API test execution
   ```

3. **WebSocket обновления фронтенду:**
   - 70% - "🌐 Executing API request..."
   - 72% - "📡 Sending GET request..."
   - 80% - "📥 Processing response (200)..."
   - 90% - "✅ API test completed (123ms)"
   - 100% - "🎉 API test completed!"

4. **HTTP ответ с результатами**

## 📊 Как диагностировать

### Шаг 1: Проверить логи сервера
```bash
# Следить за логами в реальном времени
tail -f logs/app.log

# ИЛИ смотреть console output если запущен через npm start
```

**Что искать:**
1. `🔍 [APPROVAL_DETECT] Starting detection` - проверка approval началась
2. `✅ [APPROVAL_DETECT] User approval detected` - AI определил approval
3. `🟢 [APPROVAL] Test approved, executing now...` - начинается выполнение
4. `🚀 [EXECUTE] ==> FUNCTION CALLED` - функция executeApprovedTestPlan вызвана
5. `🔵 [API_TEST] Starting API test execution` - начинается API тест
6. `🟢 [executeApiTest] FUNCTION CALLED` - функция executeApiTest вызвана

### Шаг 2: Проверить WebSocket соединение
**На фронтенде:**
```javascript
socket.on('chat:processing:step', (data) => {
  console.log('WebSocket progress:', data);
});
```

**Должны приходить:**
- `🌐 Executing API request... (70%)`
- `📡 Sending GET request... (72%)`
- `📥 Processing response (200)... (80%)`
- `✅ API test completed (123ms) (90%)`
- `🎉 API test completed! (100%)`

### Шаг 3: Если логи не появляются

**Возможные причины:**

#### A. Сервер не перезапущен
```bash
# Перезапусти сервер с новым кодом
npm start
```

#### B. Approval не детектируется
Ищи в логах:
```
⚠️ [APPROVAL_DETECT] No clear intent detected
```

Значит пользователь написал что-то неожиданное.

#### C. Pending plan не найден
Ищи в логах:
```
[CHAT] No pending test plan found
```

Значит план истёк или не был создан.

#### D. Недостаточно кредитов
Ищи в логах:
```
[EXECUTE] Insufficient credits for test
```

## 🧪 Тестирование

### Локально:
1. Запусти сервер: `npm start`
2. Создай API test plan через фронтенд
3. Напиши "начинай тестинг" или "да"
4. Смотри логи в консоли

### Production:
⚠️ **НЕ ДЕПЛОЙ БЕЗ РАЗРЕШЕНИЯ!**

Когда будешь готов деплоить, скажи мне - я сделаю pre-deploy проверки.

## 📝 Что проверить перед деплоем

```bash
# 1. TypeScript компиляция
npx tsc --noEmit

# 2. Build
npm run build

# 3. Проверка что изменения в dist/
grep "executeApiTest" dist/services/testing/apiTest.service.js
grep "APPROVAL_DETECT" dist/services/ai/ai-helpers.service.js
grep "API_TEST.*Starting" dist/api/chat/chat.controller.js
```

## 🔑 Ключевые файлы изменены

1. **`src/services/testing/exploration-cache.service.ts`** - добавлена `getLatestPendingTestPlan()` (ГЛАВНЫЙ ФИКС)
2. **`src/api/chat/chat.controller.ts`** - fallback поиск pending plan + детальные логи
3. **`src/services/testing/apiTest.service.ts`** - WebSocket прогресс-обновления
4. **`src/services/ai/ai-helpers.service.ts`** - улучшенная детекция approval (начинай, тестинг)

Все скомпилировано в `dist/`.

## 🚀 Тестирование

1. **Перезапусти сервер** с новым кодом
2. Создай API test plan
3. Напиши "начинай тестинг" или "да"
4. **Смотри логи** - должны появиться все сообщения выше
5. **Фронтенд** должен получить WebSocket обновления 70% → 100%

Если всё равно не работает - пришли логи сервера из консоли.
