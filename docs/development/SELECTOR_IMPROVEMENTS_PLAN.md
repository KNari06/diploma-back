# План улучшений системы селекторов

## 📋 Обзор

План улучшений системы селекторов для устранения проблем с парсингом, обработкой edge-cases, и повышения надежности ИИ-тестирования.

---

## 🎯 Приоритеты

### **P0 (Критично - немедленно)**
- Улучшение парсинга селекторов (regex, contextual locators)
- Исправление self-healing с dry-run валидацией
- Обработка множественных совпадений

### **P1 (Высокий - в течение недели)**
- Поддержка frames/shadow DOM
- Улучшение логирования и метрик
- Transient cache для производительности

### **P2 (Средний - в течение месяца)**
- Unit/Integration тесты
- Security improvements (masking sensitive data)
- UI интеграция для отображения метрик

---

## 📝 Детальный план задач

### **Фаза 1: Улучшение парсинга селекторов (P0)**

#### Задача 1.1: Улучшить `getLocator()` для поддержки regex-литералов
**Файлы:** `src/agent/command-executor.ts`, `src/agent/intelligent-test-orchestrator.ts`

**Что делать:**
- [ ] Добавить парсинг regex-литералов: `text=/Sign in/i`, `role=button[name=/Sign in/i]`
- [ ] Поддержать `exact: true/false` для `getByText()`
- [ ] Обработать экранирование кавычек и спецсимволов
- [ ] Добавить валидацию regex перед использованием

**Пример реализации:**
```typescript
// Handle text with regex: text=/Sign in/i
const textRegexMatch = selector.match(/^text\s*=\s*\/(.+)\/([gimsuy]*)$/i);
if (textRegexMatch) {
  const pattern = new RegExp(textRegexMatch[1], textRegexMatch[2]);
  return this.page.getByText(pattern);
}

// Handle text with exact match: text="Login" (exact) vs text=Login (fuzzy)
const textMatch = selector.match(/^text\s*=\s*(.+)$/i);
if (textMatch) {
  let payload = textMatch[1].trim().replace(/^["']|["']$/g, '');
  // Check if should be exact (quoted) or fuzzy
  const isExact = selector.includes('"') || selector.includes("'");
  return this.page.getByText(payload, { exact: isExact });
}
```

**Оценка:** 4-6 часов

---

#### Задача 1.2: Поддержка contextual locators
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] Определять contextual locators (содержат `>>` или `:has-text()`, `:has()`)
- [ ] Передавать их напрямую в `page.locator()` без парсинга
- [ ] Добавить валидацию синтаксиса

**Пример:**
```typescript
// Detect contextual locators
const isContextual = selector.includes('>>') ||
                     selector.includes(':has-text(') ||
                     selector.includes(':has(') ||
                     selector.includes(':scope');

if (isContextual) {
  // Pass directly to locator - Playwright supports these
  return this.page.locator(selector);
}
```

**Оценка:** 2-3 часа

---

#### Задача 1.3: Улучшить парсинг XPath
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] Надежно определять XPath: `^\/{1,2}` или `^xpath=`
- [ ] Не путать с CSS содержащим `/` в атрибутах
- [ ] Поддержать `xpath=` префикс

**Пример:**
```typescript
// XPath detection - more reliable
const isXPath = selector.trim().match(/^(xpath\s*=\s*)?\/{1,2}/);
if (isXPath) {
  const xpath = selector.startsWith('xpath=')
    ? selector.slice(6).trim()
    : selector.trim();
  return this.page.locator(`xpath=${xpath}`);
}
```

**Оценка:** 1-2 часа

---

### **Фаза 2: Обработка множественных совпадений (P0)**

#### Задача 2.1: Логика для множественных элементов
**Файлы:** `src/agent/command-executor.ts`, `src/agent/intelligent-test-orchestrator.ts`

**Что делать:**
- [ ] При `count() > 1` использовать `locator.first()` для большинства случаев
- [ ] Логировать предупреждение при ambiguous селекторах
- [ ] Добавить опцию `preferFirst: true` по умолчанию
- [ ] Возвращать информацию о количестве совпадений в логах

**Пример:**
```typescript
private async getLocatorWithCount(selector: string) {
  const locator = this.getLocator(selector);
  const count = await locator.count();

  if (count > 1) {
    logger.warn('[SELECTOR] Multiple elements found', {
      selector,
      count,
      using: 'first()',
    });
    return { locator: locator.first(), count, isAmbiguous: true };
  }

  return { locator, count, isAmbiguous: false };
}
```

**Оценка:** 3-4 часа

---

### **Фаза 3: Улучшение Self-Healing (P0)**

#### Задача 3.1: Dry-run валидация перед auto-apply
**Файлы:** `src/services/ai-selector/self-healing.service.ts`, `src/agent/command-executor.ts`

**Что делать:**
- [ ] В `testSelector()` использовать `getLocator()` вместо `page.locator()`
- [ ] Проверять `count() === 1` и `isVisible()` перед auto-apply
- [ ] Добавить таймаут для dry-run (2-3 секунды)
- [ ] Если dry-run не проходит, пробовать fallback селекторы

**Пример:**
```typescript
private static async testSelector(page: Page, selector: string): Promise<{
  works: boolean;
  count: number;
  isVisible: boolean;
  error?: string;
}> {
  try {
    // Use getLocator helper (needs to be accessible)
    const locator = this.getLocatorForPage(page, selector);
    const count = await locator.count();

    if (count === 0) {
      return { works: false, count: 0, isVisible: false, error: 'No elements found' };
    }

    const isVisible = await locator.first().isVisible({ timeout: 2000 });

    return {
      works: count === 1 && isVisible,
      count,
      isVisible,
    };
  } catch (error) {
    return {
      works: false,
      count: 0,
      isVisible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

**Оценка:** 4-5 часов

---

#### Задача 3.2: Multi-fallback перебор
**Файлы:** `src/services/ai-selector/self-healing.service.ts`

**Что делать:**
- [ ] Использовать `fallbackSelectors` из `AISelectorEngine.resolve()`
- [ ] Перебирать fallback селекторы по приоритету
- [ ] Останавливаться на первом рабочем
- [ ] Логировать все попытки

**Пример:**
```typescript
// In healSelector()
const resolveResult = await AISelectorEngine.resolve({...});

// Try primary selector first
let candidateSelector = resolveResult.selectedNode?.primarySelector;
let candidates = [candidateSelector, ...resolveResult.fallbackSelectors.map(s => s.selector)];

for (const candidate of candidates) {
  if (!candidate) continue;

  const testResult = await this.testSelector(page, candidate);
  if (testResult.works) {
    return {
      success: true,
      newSelector: candidate,
      // ...
    };
  }
}
```

**Оценка:** 3-4 часа

---

#### Задача 3.3: Исправить использование healed селекторов
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] В `executeWithSelfHealing()` использовать `getLocator()` для healed селектора
- [ ] Не использовать `page.locator()` напрямую
- [ ] Поддерживать все форматы (text=, role=, label=)

**Текущая проблема:**
```typescript
// ❌ Неправильно - не использует getLocator()
await this.page.locator(healingResult.newSelector).click({
  timeout: context.timeout || 30000,
});
```

**Исправление:**
```typescript
// ✅ Правильно - использует getLocator()
const healedLocator = this.getLocator(healingResult.newSelector);
await healedLocator.waitFor({ state: 'visible', timeout: context.timeout || 30000 });
await healedLocator.click({ timeout: context.timeout || 30000 });
```

**Оценка:** 1-2 часа

---

### **Фаза 4: Frames и Shadow DOM (P1)**

#### Задача 4.1: Поддержка iframes
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] Определять, находится ли элемент в iframe
- [ ] Получать frame по селектору или индексу
- [ ] Использовать `frame.getByText()` вместо `page.getByText()`
- [ ] Добавить опцию `frameSelector` в команды

**Пример:**
```typescript
private async getLocatorInFrame(selector: string, frameSelector?: string) {
  if (frameSelector) {
    const frame = this.page.frame({ url: frameSelector }) ||
                  this.page.frameLocator(frameSelector).first();
    return this.getLocatorForFrame(frame, selector);
  }
  return this.getLocator(selector);
}
```

**Оценка:** 6-8 часов

---

#### Задача 4.2: Поддержка Shadow DOM
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] Использовать `locator()` с `pierce` опцией для shadow DOM
- [ ] Определять shadow DOM элементы
- [ ] Добавить fallback на обычный locator если pierce не работает

**Пример:**
```typescript
// Shadow DOM support
if (selector.includes('::shadow') || selector.includes('::part')) {
  // Use pierce option
  return this.page.locator(selector).locator('..').first();
}
```

**Оценка:** 4-6 часов

---

### **Фаза 5: Логирование и метрики (P1)**

#### Задача 5.1: Улучшить логирование селекторов
**Файлы:** `src/agent/command-executor.ts`, `src/services/ai-selector/self-healing.service.ts`

**Что делать:**
- [ ] Логировать какой метод использован: `getByRole`, `getByText`, `getByLabel`, `locator`
- [ ] Логировать `count`, `isVisible`, `isActionable`
- [ ] Добавить метрики: success rate per method, false-positive rate
- [ ] Структурированные логи для анализа

**Пример:**
```typescript
logger.info('[SELECTOR] Locator resolved', {
  selector,
  method: 'getByRole', // or 'getByText', 'locator', etc.
  count,
  isVisible,
  isActionable,
  duration: Date.now() - startTime,
});
```

**Оценка:** 3-4 часа

---

#### Задача 5.2: Метрики healing
**Файлы:** `src/services/ai-selector/self-healing.service.ts`

**Что делать:**
- [ ] Отслеживать success rate по методам (getByRole vs getByText vs CSS)
- [ ] Отслеживать false-positive rate (applied but later failing)
- [ ] Сохранять метрики в БД или файл
- [ ] Экспортировать в UI для анализа

**Оценка:** 4-5 часов

---

#### Задача 5.3: UI интеграция
**Файлы:** `src/api/` (новый endpoint)

**Что делать:**
- [ ] Создать endpoint для метрик селекторов
- [ ] Показывать почему селектор был пропущен (3 fails)
- [ ] Показывать fallback кандидаты
- [ ] Визуализация success rate по типам селекторов

**Оценка:** 6-8 часов

---

### **Фаза 6: Производительность (P1)**

#### Задача 6.1: Transient cache
**Файлы:** `src/agent/command-executor.ts`

**Что делать:**
- [ ] Кэшировать результаты `count()` и `isVisible()` в рамках одного run
- [ ] Ключ: `selector + url + domHash`
- [ ] Инвалидация при изменении DOM
- [ ] Не кэшировать across runs

**Пример:**
```typescript
private selectorCache = new Map<string, {
  count: number;
  isVisible: boolean;
  timestamp: number;
  domHash: string;
}>();

private async getCachedOrFresh(selector: string, url: string, domHash: string) {
  const key = `${selector}:${url}:${domHash}`;
  const cached = this.selectorCache.get(key);

  if (cached && Date.now() - cached.timestamp < 5000) {
    return cached;
  }

  // Fresh check
  const locator = this.getLocator(selector);
  const result = {
    count: await locator.count(),
    isVisible: await locator.first().isVisible(),
    timestamp: Date.now(),
    domHash,
  };

  this.selectorCache.set(key, result);
  return result;
}
```

**Оценка:** 4-5 часов

---

### **Фаза 7: Тестирование (P2)**

#### Задача 7.1: Unit тесты для парсинга
**Файлы:** `src/agent/__tests__/command-executor.test.ts` (новый)

**Что тестировать:**
- [ ] `normalizeSelector()`: все форматы (getByText, getByRole, getByLabel)
- [ ] `getLocator()`: text=, role=, label=, CSS, XPath
- [ ] Regex литералы: `/Sign in/i`
- [ ] Contextual locators: `h1:has-text("X") >> button`
- [ ] Edge cases: экранирование, пустые строки, null

**Оценка:** 8-10 часов

---

#### Задача 7.2: Integration тесты
**Файлы:** `src/agent/__tests__/selector-integration.test.ts` (новый)

**Что тестировать:**
- [ ] Multiple matches: что происходит при count() > 1
- [ ] 0 matches: правильная обработка ошибок
- [ ] Element in iframe: работает ли frame.getByText()
- [ ] Shadow DOM: работает ли pierce
- [ ] Healing flow: mock SelfHealingService, проверка dry-run

**Оценка:** 10-12 часов

---

#### Задача 7.3: Concurrency тесты
**Файлы:** `src/agent/__tests__/selector-concurrency.test.ts` (новый)

**Что тестировать:**
- [ ] Multiple parallel healing attempts для одного селектора
- [ ] Проверка lock/skip behavior
- [ ] Race conditions в кэше

**Оценка:** 4-6 часов

---

### **Фаза 8: Security (P2)**

#### Задача 8.1: Masking sensitive data
**Файлы:** `src/agent/command-executor.ts`, `src/utils/logger.ts`

**Что делать:**
- [ ] Не логировать raw `innerText` если содержит sensitive patterns (email, phone, SSN)
- [ ] Маскировать в логах: `test@example.com` → `t***@e***.com`
- [ ] Добавить опцию `maskSensitiveData: true` по умолчанию

**Оценка:** 3-4 часа

---

## 📊 Итоговая оценка времени

| Фаза | Задачи | Часы | Приоритет |
|------|--------|------|-----------|
| Фаза 1 | Парсинг селекторов | 7-11 | P0 |
| Фаза 2 | Множественные совпадения | 3-4 | P0 |
| Фаза 3 | Self-Healing | 8-11 | P0 |
| Фаза 4 | Frames/Shadow DOM | 10-14 | P1 |
| Фаза 5 | Логирование/Метрики | 13-17 | P1 |
| Фаза 6 | Производительность | 4-5 | P1 |
| Фаза 7 | Тестирование | 22-28 | P2 |
| Фаза 8 | Security | 3-4 | P2 |
| **ИТОГО** | | **70-94 часа** | |

---

## 🚀 План выполнения (по неделям)

### **Неделя 1: P0 задачи (Критично)**
- День 1-2: Фаза 1 (Парсинг селекторов)
- День 3: Фаза 2 (Множественные совпадения)
- День 4-5: Фаза 3 (Self-Healing)

**Результат:** Система селекторов работает надежно, нет зацикливания

---

### **Неделя 2: P1 задачи (Высокий приоритет)**
- День 1-2: Фаза 4 (Frames/Shadow DOM)
- День 3-4: Фаза 5 (Логирование/Метрики)
- День 5: Фаза 6 (Производительность)

**Результат:** Поддержка edge-cases, улучшенная наблюдаемость

---

### **Неделя 3-4: P2 задачи (Средний приоритет)**
- Неделя 3: Фаза 7 (Тестирование)
- Неделя 4: Фаза 8 (Security) + финальная полировка

**Результат:** Полное покрытие тестами, production-ready

---

## ✅ Критерии успеха

1. **Парсинг:** Все форматы селекторов (regex, contextual, XPath) работают корректно
2. **Healing:** Dry-run валидация предотвращает false-positives
3. **Множественные совпадения:** Правильная обработка с логированием
4. **Frames/Shadow DOM:** Поддержка работает стабильно
5. **Метрики:** Success rate > 90% для healed селекторов
6. **Тесты:** Coverage > 80% для selector-related кода
7. **Производительность:** Кэш снижает DOM queries на 50%+

---

## 🔄 Следующие шаги

1. **Сейчас:** Начать с Фазы 1 (Парсинг селекторов) - самая критичная
2. **Параллельно:** Можно начать Фазу 7 (Тесты) для уже существующего кода
3. **После P0:** Перейти к P1 задачам
4. **Финализация:** P2 задачи и документация

---

## 📝 Примечания

- Все изменения должны быть обратно совместимы
- Добавлять feature flags для новых возможностей
- Документировать все новые форматы селекторов
- Обновить промпты для AI, чтобы генерировать правильные форматы
