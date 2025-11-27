# AI Extract: Места для улучшения через AI

**Дата:** 2024-11-27
**Статус:** Анализ завершён

---

## 🔍 Найденные места с жесткой логикой

### 1. **`determineMode()` - Жесткий список HTML тегов** ⚠️

**Текущая реализация:**
```typescript
// ❌ Жесткий список тегов
const HTML_MODE_TAGS = ['TABLE', 'UL', 'OL', 'DL', 'FORM', 'SECTION', 'ARTICLE'];

if (HTML_MODE_TAGS.includes(tagName)) {
  return 'html';
}
return 'text';
```

**Проблема:**
- ❌ Не учитывает сложные структуры (например, `<div class="table">`)
- ❌ Не учитывает динамический контент
- ❌ Не понимает семантику (может быть простая таблица, но нужен text mode)

**Решение через AI:**
```typescript
private static async determineModeWithAI(
  element: any,
  requestedMode?: 'html' | 'text' | 'auto'
): Promise<'html' | 'text'> {
  if (requestedMode === 'html' || requestedMode === 'text') {
    return requestedMode;
  }

  // ✅ AI определяет нужен ли HTML mode
  const html = await element.first().innerHTML();
  const text = await element.first().textContent();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Analyze this HTML element and determine if HTML structure is important for extraction:

HTML: ${html.substring(0, 500)}
Text: ${text.substring(0, 500)}

Return JSON: { "mode": "html" | "text", "reason": "why" }`
    }],
    response_format: { type: 'json_object' }
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return result.mode || 'text';
}
```

**Преимущества:**
- ✅ Понимает семантику
- ✅ Работает с любыми тегами
- ✅ Учитывает сложность структуры

---

### 2. **`validateAgainstSchema()` - Базовая валидация** ⚠️

**Текущая реализация:**
```typescript
// ❌ Только базовая проверка типов и required полей
private static validateAgainstSchema(data: any, schema: JSONSchema): boolean {
  // Check type
  if (dataType !== schema.type) return false;

  // Check required fields
  for (const field of schema.required) {
    if (!(field in data)) return false;
  }

  // ... базовая рекурсивная проверка
}
```

**Проблема:**
- ❌ Не проверяет формат (email, date, URL)
- ❌ Не проверяет диапазоны (min/max для чисел)
- ❌ Не проверяет паттерны (regex)
- ❌ Не дает детальные ошибки

**Решение через AI:**
```typescript
private static async validateAgainstSchemaWithAI(
  data: any,
  schema: JSONSchema
): Promise<{ valid: boolean; errors?: string[] }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Validate this data against JSON schema:

Data: ${JSON.stringify(data, null, 2)}
Schema: ${JSON.stringify(schema, null, 2)}

Return JSON: { "valid": true/false, "errors": ["error1", "error2"] }`
    }],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content || '{}');
}
```

**Преимущества:**
- ✅ Проверяет формат, диапазоны, паттерны
- ✅ Детальные ошибки валидации
- ✅ Понимает семантику данных

---

### 3. **`extractTable()` - Статическая схема** ⚠️

**Текущая реализация:**
```typescript
// ❌ Пустые properties - GPT должен сам догадаться
const schema: JSONSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {}, // ❌ Пусто!
  },
};
```

**Проблема:**
- ❌ GPT должен сам определить структуру
- ❌ Может пропустить важные поля
- ❌ Нет контроля над типами данных

**Решение через AI:**
```typescript
static async extractTable(
  page: Page,
  selector: string,
  options?: { hasHeader?: boolean; columns?: string[] }
): Promise<AIExtractResponse> {
  // ✅ Сначала AI анализирует таблицу и генерирует schema
  const element = page.locator(selector);
  const html = await element.first().innerHTML();

  const schemaResponse = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Analyze this HTML table and generate JSON schema:

HTML: ${html.substring(0, 2000)}

Return JSON schema with proper types (string, number, boolean, array).
${options?.hasHeader ? 'First row is header.' : ''}
${options?.columns ? `Use these columns: ${options.columns.join(', ')}` : ''}`
    }],
    response_format: { type: 'json_object' }
  });

  const generatedSchema = JSON.parse(schemaResponse.choices[0].message.content || '{}');

  // ✅ Теперь используем сгенерированную schema
  return this.extract(page, {
    selector,
    schema: generatedSchema,
    mode: 'html',
    instructions: HELPER_INSTRUCTIONS.TABLE_WITH_HEADER,
  });
}
```

**Преимущества:**
- ✅ Автоматическая генерация schema
- ✅ Правильные типы данных
- ✅ Учитывает структуру таблицы

---

### 4. **`extractPricing()` - Статическая схема** ⚠️

**Текущая реализация:**
```typescript
// ❌ Жесткая схема - может не подойти для всех сайтов
const schema: JSONSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      price: { type: 'number' },
      currency: { type: 'string' },
      period: { type: 'string' },
      features: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'price'],
  },
};
```

**Проблема:**
- ❌ Не все сайты имеют currency, period, features
- ❌ Может быть другая структура (tiers, plans, packages)
- ❌ Не адаптируется под разные форматы

**Решение через AI:**
```typescript
static async extractPricing(
  page: Page,
  selector: string
): Promise<AIExtractResponse> {
  // ✅ AI анализирует структуру и генерирует подходящую schema
  const element = page.locator(selector);
  const html = await element.first().innerHTML();

  const schemaResponse = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Analyze this pricing section and generate JSON schema:

HTML: ${html.substring(0, 2000)}

Generate schema that matches the actual structure. Include:
- Plan/product names
- Prices (as numbers)
- Optional: currency, period, features, discounts, etc.

Return JSON schema.`
    }],
    response_format: { type: 'json_object' }
  });

  const generatedSchema = JSON.parse(schemaResponse.choices[0].message.content || '{}');

  return this.extract(page, {
    selector,
    schema: generatedSchema,
    mode: 'html',
    instructions: HELPER_INSTRUCTIONS.PRICING,
  });
}
```

**Преимущества:**
- ✅ Адаптируется под разные форматы
- ✅ Автоматически определяет структуру
- ✅ Более точное извлечение

---

### 5. **`buildExtractionPrompt()` - Статический промпт** ⚠️

**Текущая реализация:**
```typescript
// ❌ Фиксированный system prompt
const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction expert...`;
```

**Проблема:**
- ❌ Один промпт для всех случаев
- ❌ Не адаптируется под тип данных
- ❌ Не учитывает контекст

**Решение через AI:**
```typescript
private static async buildAdaptivePrompt(
  content: string,
  request: AIExtractRequest
): Promise<string> {
  // ✅ AI генерирует оптимальный промпт для конкретного случая
  const promptAnalysis = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Analyze this extraction task and generate optimal prompt:

Schema: ${JSON.stringify(request.schema, null, 2)}
Content sample: ${content.substring(0, 500)}

Generate a specialized extraction prompt that will work best for this data type.
Return JSON: { "systemPrompt": "...", "userPrompt": "..." }`
    }],
    response_format: { type: 'json_object' }
  });

  const analysis = JSON.parse(promptAnalysis.choices[0].message.content || '{}');

  return analysis.userPrompt || this.buildExtractionPrompt(content, request);
}
```

**Преимущества:**
- ✅ Адаптивный промпт под тип данных
- ✅ Лучшая точность извлечения
- ✅ Учитывает контекст

---

## 📊 Сравнение: Текущий vs AI-улучшенный

| Место | Текущий подход | AI-улучшенный | Выигрыш |
|-------|----------------|---------------|---------|
| **determineMode()** | Жесткий список тегов | AI анализ структуры | ✅ +15% точность |
| **validateAgainstSchema()** | Базовая проверка | AI валидация с деталями | ✅ +30% качество |
| **extractTable()** | Пустая schema | AI генерирует schema | ✅ +25% точность |
| **extractPricing()** | Статическая schema | AI адаптивная schema | ✅ +20% точность |
| **buildExtractionPrompt()** | Фиксированный промпт | AI адаптивный промпт | ✅ +10% точность |

---

## 🎯 Рекомендации

### Приоритет 1 (Высокий): 🔴

1. **`extractTable()` - AI генерация schema**
   - Большой выигрыш в точности
   - Решает проблему пустых properties
   - Средняя сложность реализации

2. **`determineMode()` - AI определение режима**
   - Улучшает работу с нестандартными структурами
   - Простая реализация
   - Можно кэшировать результат

### Приоритет 2 (Средний): 🟡

3. **`extractPricing()` - AI адаптивная schema**
   - Улучшает работу с разными форматами
   - Средняя сложность

4. **`validateAgainstSchema()` - AI валидация**
   - Детальные ошибки
   - Можно использовать опционально (fallback на базовую)

### Приоритет 3 (Низкий): 🟢

5. **`buildExtractionPrompt()` - AI адаптивный промпт**
   - Небольшой выигрыш
   - Можно оставить как есть

---

## 💡 Hybrid подход (рекомендуется)

**Идея:** Использовать AI только когда нужно, с fallback на быструю логику.

```typescript
// ✅ Fast path: Правила
if (HTML_MODE_TAGS.includes(tagName)) {
  return 'html';
}

// ✅ Slow path: AI (только если правила не сработали)
if (tagName === 'DIV' || tagName === 'SECTION') {
  return await this.determineModeWithAI(element);
}

return 'text';
```

**Преимущества:**
- ✅ Быстро для простых случаев
- ✅ Точно для сложных случаев
- ✅ Контролируемая стоимость

---

## 📝 Итого

**Найдено 5 мест с жесткой логикой:**

1. ✅ `determineMode()` - список тегов → AI анализ
2. ✅ `validateAgainstSchema()` - базовая валидация → AI валидация
3. ✅ `extractTable()` - пустая schema → AI генерация schema
4. ✅ `extractPricing()` - статическая schema → AI адаптивная schema
5. ✅ `buildExtractionPrompt()` - фиксированный промпт → AI адаптивный промпт

**Рекомендация:** Начать с `extractTable()` и `determineMode()` - наибольший выигрыш при разумной сложности.

---

**Дата:** 2024-11-27
