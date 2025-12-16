# Глубокий анализ метода `decideNextStep`

## 📋 Обзор

Метод `decideNextStep` в `ContextualActionGenerator` принимает решение о следующем шаге теста после выполнения действий на странице. Использует AI (GPT-4o-mini) для принятия решения на основе истории теста, текущего состояния и ошибок.

**Расположение:** `src/agent/contextual-action-generator.ts:597-705`

---

## ✅ Что метод ЗАКРЫВАЕТ (реализовано)

### 1. **Бюджетный контроль**
```typescript
if (costManager && !costManager.canContinue()) {
  return { action: 'stop', reason: 'Budget exceeded...' };
}
```
- ✅ Проверяет превышение бюджета перед AI вызовом
- ✅ Останавливает тест при превышении лимита
- ✅ Экономит токены на ненужных AI запросах

### 2. **Обработка ошибок AI**
```typescript
catch (error) {
  // Fallback логика
  if (state.pagesAnalyzed >= state.maxPages || state.errors.length > 5) {
    return { action: 'stop', ... };
  }
  return { action: 'continue', confidence: 0.3 };
}
```
- ✅ Graceful degradation при ошибках AI
- ✅ Fallback на безопасное продолжение
- ✅ Остановка при достижении лимитов

### 3. **Контекст для AI**
- ✅ История теста (`buildHistorySummary`)
- ✅ Посещенные страницы
- ✅ Ошибки
- ✅ Текущая страница
- ✅ Цель теста

### 4. **Валидация ответа AI**
```typescript
const parsed = this.parseRobustJSON(content, NextStepResponseSchema);
```
- ✅ Использует Zod схему для валидации
- ✅ `parseRobustJSON` с fallback извлечением
- ✅ Дефолтные значения при отсутствии полей

### 5. **Трекинг стоимости**
```typescript
costManager.recordOperation({
  operation: 'next_step_decision',
  model,
  inputTokens,
  outputTokens,
});
```
- ✅ Записывает использование токенов
- ✅ Использует дешевую модель (gpt-4o-mini)
- ✅ Адаптивный выбор модели через costManager

---

## ❌ Что метод НЕ ЗАКРЫВАЕТ (проблемы)

### 1. **Игнорирование полей из AI ответа**

**Проблема:** AI возвращает больше данных, чем используется:

```typescript
// AI возвращает (из промпта):
{
  "decision": "continue|stop|...",
  "reason": "...",
  "progress": 0-100,        // ❌ НЕ используется
  "goalAchieved": true/false, // ❌ НЕ используется
  "riskLevel": "low|medium|high", // ❌ НЕ используется
  "blockingSignals": [...], // ❌ НЕ используется
  "retryStrategy": "...",   // ❌ НЕ используется
  "nextTarget": {...}       // ❌ НЕ используется
}

// Но код использует только:
const decision: NextStepDecision = {
  action: parsed.decision || 'stop',
  reason: parsed.reason || 'No reason provided',
  confidence: 0.8,  // ❌ Хардкод, игнорирует AI confidence
};
```

**Последствия:**
- AI тратит токены на генерацию неиспользуемых данных
- Теряется полезная информация (progress, riskLevel, retryStrategy)
- Confidence всегда 0.8, игнорируя AI оценку

### 2. **Нет использования `nextActions` из решения**

**Проблема:** `NextStepDecision` имеет поле `nextActions?: DynamicAction[]`, но:
- AI не просят генерировать действия
- Поле никогда не заполняется
- `handleDecision` не использует это поле

**Последствие:** Нет возможности AI сразу предложить конкретные действия для `continue`/`retry`

### 3. **Нет обработки `retry` стратегии**

**Проблема:** AI может вернуть `retry` с `retryStrategy`, но:
```typescript
case 'retry':
  logger.info('[MAIN_LOOP] Retrying...');
  return { shouldContinue: true }; // ❌ Просто продолжает, не применяет стратегию
```

**Последствие:**
- `retryStrategy` игнорируется
- Нет реализации стратегий: `wait`, `reload`, `navigate_back`, `choose_alternative_target`

### 4. **Нет детекции циклов**

**Проблема:** Метод не проверяет:
- Повторяющиеся URL
- Повторяющиеся действия
- Зацикливание на одной странице

**Последствие:** Тест может зациклиться, даже если AI вернет `continue`

**Решение есть в коде:** `CycleDetectionResult` в типах, но не используется в `decideNextStep`

### 5. **Нет проверки достижения цели**

**Проблема:**
- AI может вернуть `goalAchieved: true`, но код не проверяет
- Нет логики для остановки при достижении цели
- `action: 'stop'` может быть по другим причинам

**Последствие:** Тест может продолжить после достижения цели

### 6. **Нет использования `expectedPage`**

**Проблема:** `NextStepDecision` имеет `expectedPage?: PageType`, но:
- Не заполняется из AI ответа
- Не используется для валидации после навигации

### 7. **Нет обработки `blockingSignals`**

**Проблема:** AI может вернуть `blockingSignals: ["captcha", "2fa", ...]`, но:
- Не используется для принятия решений
- Не передается в `handleDecision`
- Нет специальной обработки блокеров

### 8. **Нет использования `riskLevel`**

**Проблема:** AI оценивает риск, но:
- Не используется для принятия решений
- Нет логики "высокий риск → wait_for_user"
- Нет эскалации при высоком риске

### 9. **Нет проверки таймаутов**

**Проблема:** Метод не учитывает:
- Время выполнения теста
- `maxDuration` из конфига
- Долгие операции

**Последствие:** Тест может превысить `maxDuration`, даже если AI вернет `continue`

### 10. **Нет проверки успешности последних действий**

**Проблема:** Метод не анализирует:
- Процент успешных действий
- Последние N действий (все ли провалились)
- Паттерны ошибок

**Последствие:** Тест может продолжать при 100% провале действий

### 11. **Нет использования `nextTarget`**

**Проблема:** AI может предложить `nextTarget` с описанием следующего шага, но:
- Не используется для генерации действий
- Не передается в следующий цикл
- Теряется контекст

### 12. **Нет проверки состояния страницы**

**Проблема:** Метод не проверяет:
- Загрузилась ли страница полностью
- Есть ли ошибки на странице (404, 500)
- Есть ли модалки/оверлеи
- Есть ли валидационные ошибки

**Последствие:** Может принять решение на основе неполной информации

### 13. **Нет использования `progress`**

**Проблема:** AI может вернуть `progress: 0-100`, но:
- Не используется для логирования
- Не передается в события
- Не влияет на решения

### 14. **Хардкод confidence**

**Проблема:**
```typescript
confidence: 0.8,  // ❌ Всегда 0.8, игнорирует AI
```

**Должно быть:**
```typescript
confidence: parsed.confidence ?? 0.8,  // Использовать AI оценку
```

### 15. **Нет проверки контекста страницы**

**Проблема:** Метод не использует:
- `context.dom` (структура DOM)
- `context.vision` (визуальный анализ)
- `context.errors` (ошибки на странице)

**Последствие:** Решение принимается без полного контекста страницы

---

## 🔍 Детальный анализ промпта

### Что передается в AI:

✅ **Передается:**
- Goal (цель теста)
- History summary (последние 3 действия)
- Visited pages (список страниц)
- Errors (список ошибок)
- Current page type

❌ **НЕ передается:**
- DOM структура
- Vision analysis (элементы на странице)
- Последние action results (успешность)
- Текущий URL
- Время выполнения теста
- Количество успешных/провальных действий
- Состояние форм (заполнены ли)
- Наличие модалок/оверлеев

### Что AI просят вернуть:

✅ **Просят:**
- decision (continue/stop/wait_for_user/retry/skip)
- reason
- progress (0-100)
- goalAchieved
- riskLevel
- blockingSignals
- retryStrategy
- nextTarget

❌ **Используется только:**
- decision
- reason

---

## 🐛 Потенциальные баги

### 1. **Memory leak в промпте**

Если ошибок много, они все передаются в промпт:
```typescript
errors: state.errors.map(e => e.message)
```
Может привести к переполнению токенов.

### 2. **Нет лимита на visitedPages**

```typescript
visitedPages: state.visitedPages.map(v => `${v.pageType} (${v.url})`)
```
При длинном тесте может быть очень длинный список.

### 3. **Нет обработки пустого ответа**

```typescript
if (!content) {
  throw new Error('Empty response from Next Step Decision');
}
```
Бросает ошибку, но fallback может быть не оптимальным.

### 4. **Нет валидации decision.action**

```typescript
action: parsed.decision || 'stop',
```
Если AI вернет невалидное значение, используется 'stop', что может быть неверно.

---

## 💡 Рекомендации по улучшению

### 1. **Использовать все поля из AI ответа**

```typescript
const decision: NextStepDecision = {
  action: parsed.decision || 'stop',
  reason: parsed.reason || 'No reason provided',
  confidence: parsed.confidence ?? 0.8,  // ✅ Использовать AI оценку
  nextActions: parsed.nextActions,  // ✅ Если AI предложил
  expectedPage: parsed.nextTarget?.type === 'page' ? parsed.nextTarget.description : undefined,
};
```

### 2. **Добавить проверку циклов**

```typescript
// Перед AI вызовом
const cycleDetection = this.detectCycles(state, context);
if (cycleDetection.cycleDetected) {
  return {
    action: 'skip',
    reason: cycleDetection.suggestion,
    confidence: 1.0,
  };
}
```

### 3. **Добавить проверку достижения цели**

```typescript
if (parsed.goalAchieved === true) {
  return {
    action: 'stop',
    reason: 'Goal achieved',
    confidence: parsed.confidence ?? 1.0,
  };
}
```

### 4. **Использовать blockingSignals**

```typescript
if (parsed.blockingSignals?.includes('captcha') ||
    parsed.blockingSignals?.includes('2fa')) {
  return {
    action: 'wait_for_user',
    reason: `Blocked by: ${parsed.blockingSignals.join(', ')}`,
    confidence: 1.0,
  };
}
```

### 5. **Использовать riskLevel**

```typescript
if (parsed.riskLevel === 'high') {
  return {
    action: 'wait_for_user',
    reason: `High risk action: ${parsed.reason}`,
    confidence: parsed.confidence ?? 0.9,
  };
}
```

### 6. **Добавить проверку таймаутов**

```typescript
const elapsed = Date.now() - state.startTime;
if (elapsed >= state.maxDuration) {
  return {
    action: 'stop',
    reason: 'Max duration reached',
    confidence: 1.0,
  };
}
```

### 7. **Добавить проверку успешности действий**

```typescript
const recentActions = state.completedActions.slice(-5);
const allFailed = recentActions.length > 0 &&
                  recentActions.every(a => !a.success);
if (allFailed) {
  return {
    action: 'skip',
    reason: 'All recent actions failed, trying different approach',
    confidence: 0.9,
  };
}
```

### 8. **Расширить контекст для AI**

Добавить в промпт:
- DOM структура (краткая)
- Vision elements (критичные)
- Последние action results
- Текущий URL
- Время выполнения

### 9. **Использовать retryStrategy**

```typescript
if (decision.action === 'retry' && parsed.retryStrategy) {
  // Применить стратегию
  switch (parsed.retryStrategy) {
    case 'wait':
      await page.waitForTimeout(2000);
      break;
    case 'reload':
      await page.reload();
      break;
    // ...
  }
}
```

### 10. **Добавить лимиты на размер промпта**

```typescript
const maxErrors = 10;
const errors = state.errors.slice(-maxErrors).map(e => e.message);

const maxPages = 20;
const visitedPages = state.visitedPages.slice(-maxPages).map(...);
```

---

## 📊 Статистика использования

**Вызывается из:**
- `MainLoopService.execute` (4 раза в разных местах)
- После каждого цикла: analyze → generate → execute → **decideNextStep**

**Частота:** Один раз на итерацию главного цикла

**Стоимость:** ~$0.0001-0.0002 за вызов (gpt-4o-mini, ~400 input + 100 output tokens)

---

## 🎯 Выводы

### Сильные стороны:
1. ✅ Есть бюджетный контроль
2. ✅ Есть fallback при ошибках
3. ✅ Использует дешевую модель
4. ✅ Валидация ответа AI

### Слабые стороны:
1. ❌ Игнорирует 80% данных от AI
2. ❌ Нет проверки циклов
3. ❌ Нет проверки достижения цели
4. ❌ Нет использования retryStrategy
5. ❌ Нет проверки таймаутов
6. ❌ Нет проверки успешности действий
7. ❌ Неполный контекст для AI

### Приоритет улучшений:
1. **КРИТИЧНО:** Использовать `goalAchieved` для остановки
2. **ВЫСОКИЙ:** Добавить проверку циклов
3. **ВЫСОКИЙ:** Использовать `confidence` от AI
4. **СРЕДНИЙ:** Использовать `retryStrategy`
5. **СРЕДНИЙ:** Использовать `blockingSignals` и `riskLevel`
6. **НИЗКИЙ:** Расширить контекст для AI
7. **НИЗКИЙ:** Использовать `progress` и `nextTarget`
