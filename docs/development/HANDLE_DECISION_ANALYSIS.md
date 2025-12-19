# Анализ метода handleDecision - Покрытие кейсов

## ✅ Покрытые кейсы

### 1. `stop` - ✅ Полностью покрыт

- **Логика**: Останавливает цикл
- **Возвращает**: `{ shouldContinue: false }`
- **Проблемы**: Нет

### 2. `wait_for_user` - ⚠️ Частично покрыт

- **Логика**:
  - Определяет тип clarification
  - Запрашивает у пользователя
  - Продолжает если получил ответ
  - Останавливает если нет ответа
- **Edge cases**:
  - ✅ Есть clarificationType + testId + userId → запрашивает
  - ✅ Нет clarificationType/testId/userId → останавливается с логированием
  - ✅ Ошибка при запросе → останавливается
  - ✅ Пустой ответ → останавливается
- **Проблемы**:
  - ⚠️ Нет обработки случая, когда `ClarificationService` не загружается (require может упасть)
  - ⚠️ Нет валидации `decision.reason` (может быть undefined/null)
  - ⚠️ Нет обработки timeout при запросе clarification

### 3. `skip` - ⚠️ Частично покрыт

- **Логика**:
  - Пытается goBack
  - Если не получилось → goto startUrl
  - Если оба не получились → останавливается
- **Edge cases**:
  - ✅ goBack успешен → продолжает
  - ✅ goBack неуспешен, goto успешен → продолжает
  - ✅ Оба неуспешны → останавливается
- **Проблемы**:
  - ⚠️ Нет проверки, что `config.startUrl` валиден
  - ⚠️ Нет проверки, что `page` не null/undefined
  - ⚠️ Дублирование логики: такая же логика есть в строках 252-275 (обработка empty pages)
  - ⚠️ Нет обработки случая, когда `getState()` возвращает невалидное состояние

### 4. `retry` - ✅ Полностью покрыт

- **Логика**: Продолжает цикл
- **Возвращает**: `{ shouldContinue: true }`
- **Проблемы**: Нет

### 5. `continue` - ✅ Полностью покрыт

- **Логика**: Продолжает цикл
- **Возвращает**: `{ shouldContinue: true }`
- **Проблемы**: Нет

### 6. `default` (неизвестное значение) - ✅ Покрыт

- **Логика**: Продолжает цикл (fail-safe)
- **Возвращает**: `{ shouldContinue: true }`
- **Проблемы**:
  - ⚠️ Может быть лучше логировать warning при неизвестном значении

## ❌ Непокрытые кейсы и проблемы

### 1. Валидация входных данных

```typescript
// НЕТ проверки:
- decision может быть null/undefined
- decision.action может быть невалидным значением
- context может быть null/undefined
- page может быть null/undefined
- config может быть null/undefined
- getState может быть null/undefined
```

### 2. Обработка ошибок

```typescript
// НЕТ обработки:
- Ошибка в detectMissingDataType()
- Ошибка в buildClarificationQuestion()
- Ошибка в AdaptiveConfigService.analyzePageContext()
- Ошибка в AdaptiveConfigService.getTimeout()
```

### 3. Edge cases для wait_for_user

```typescript
// НЕТ обработки:
- ClarificationService.requestClarification() может вернуть пустую строку (считается как false)
- Timeout при запросе clarification (нет явного timeout)
- Пользователь отменил запрос clarification
```

### 4. Edge cases для skip

```typescript
// НЕТ обработки:
- config.startUrl может быть пустым/невалидным
- page может быть закрыт/недоступен
- getState() может вернуть состояние, где нет истории навигации
```

### 5. Дублирование логики

- Логика `skip` дублируется в строках 252-275 (обработка empty pages)
- Можно вынести в отдельный метод `handleSkipNavigation()`

## 🔧 Рекомендации по улучшению

### 1. Добавить валидацию входных данных

```typescript
private static async handleDecision(params: {
  decision: NextStepDecision;
  // ...
}): Promise<{ shouldContinue: boolean }> {
  // Валидация
  if (!params || !params.decision) {
    logger.error('[MAIN_LOOP] Invalid decision parameter');
    return { shouldContinue: false };
  }

  if (!params.context || !params.page || !params.config || !params.getState) {
    logger.error('[MAIN_LOOP] Missing required parameters');
    return { shouldContinue: false };
  }

  const { decision, context, page, config, getState, testId, userId, emitEvent } = params;

  // Валидация action
  const validActions = ['continue', 'stop', 'wait_for_user', 'retry', 'skip'];
  if (!validActions.includes(decision.action)) {
    logger.warn('[MAIN_LOOP] Unknown decision action', { action: decision.action });
    return { shouldContinue: true }; // Fail-safe: continue
  }

  // ...
}
```

### 2. Улучшить обработку wait_for_user

```typescript
case 'wait_for_user': {
  // Валидация reason
  const reason = decision.reason || 'Unknown reason';

  // Валидация testId/userId
  if (!testId || !userId) {
    logger.warn('[MAIN_LOOP] Cannot request clarification - missing testId or userId');
    emitEvent('test_warning', { message: `Waiting for user: ${reason}` });
    return { shouldContinue: false };
  }

  // Безопасная загрузка ClarificationService
  let ClarificationService;
  try {
    ClarificationService = require('./utils/clarification.service').ClarificationService;
  } catch (requireError) {
    logger.error('[MAIN_LOOP] Failed to load ClarificationService', { error: requireError });
    return { shouldContinue: false };
  }

  // ...
}
```

### 3. Улучшить обработку skip

```typescript
case 'skip': {
  // Валидация startUrl
  if (!config.startUrl || typeof config.startUrl !== 'string' || !config.startUrl.trim()) {
    logger.error('[MAIN_LOOP] Invalid startUrl in config');
    return { shouldContinue: false };
  }

  // Вынести в отдельный метод для переиспользования
  return await this.handleSkipNavigation(page, config, getState);
}
```

### 4. Вынести дублирующуюся логику

```typescript
private static async handleSkipNavigation(
  page: Page,
  config: IntelligentTestConfig,
  getState: () => TestState
): Promise<{ shouldContinue: boolean }> {
  // Логика навигации при skip
}
```

### 5. Добавить обработку ошибок

```typescript
try {
  const clarificationType = MainLoopService.detectMissingDataType(
    decision.reason,
    context
  );
} catch (error) {
  logger.error("[MAIN_LOOP] Failed to detect missing data type", { error });
  // Fallback: generic clarification
}
```

## 📊 Оценка покрытия

| Кейс                  | Покрытие | Проблемы                                    |
| --------------------- | -------- | ------------------------------------------- |
| `stop`                | 100%     | Нет                                         |
| `wait_for_user`       | 80%      | Нет валидации, нет обработки ошибок require |
| `skip`                | 75%      | Дублирование, нет валидации startUrl        |
| `retry`               | 100%     | Нет                                         |
| `continue`            | 100%     | Нет                                         |
| `default`             | 90%      | Нет warning при неизвестном значении        |
| **Валидация входных** | 0%       | Критично                                    |
| **Обработка ошибок**  | 30%      | Важно                                       |

**Общая оценка: 70% покрытие**

## ✅ Что хорошо

1. Все основные кейсы обработаны
2. Есть default case для безопасности
3. Логирование присутствует
4. Логика понятна и читаема

## ❌ Что нужно улучшить

1. **Критично**: Добавить валидацию входных данных
2. **Важно**: Улучшить обработку ошибок
3. **Важно**: Убрать дублирование логики skip
4. **Желательно**: Добавить warning при неизвестных значениях
5. **Желательно**: Вынести общую логику навигации в отдельный метод
