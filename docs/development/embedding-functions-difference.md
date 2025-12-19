# 🔍 Разница между generateEmbedding и generateEmbeddings

**Дата:** Декабрь 2024
**Файл:** `src/services/ai/embedding.service.ts`

---

## 📊 Основные различия

### `generateEmbedding` (единственное число)

**Сигнатура:**
```typescript
export async function generateEmbedding(text: string): Promise<number[]>
```

**Что делает:**
- Генерирует embedding для **одного текста**
- Принимает: `string` (один текст)
- Возвращает: `number[]` (один вектор, 1536 dimensions)

**Использование:**
```typescript
const embedding = await generateEmbedding("Hello world");
// → [0.123, -0.456, 0.789, ...] (1536 чисел)
```

**OpenAI API вызов:**
```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: cleanedText,  // ← Один текст
  dimensions: 1536,
});
const embedding = response.data[0].embedding;  // ← Первый (и единственный) результат
```

---

### `generateEmbeddings` (множественное число)

**Сигнатура:**
```typescript
export async function generateEmbeddings(texts: string[]): Promise<number[][]>
```

**Что делает:**
- Генерирует embeddings для **нескольких текстов за раз** (batch)
- Принимает: `string[]` (массив текстов)
- Возвращает: `number[][]` (массив векторов, каждый 1536 dimensions)

**Использование:**
```typescript
const embeddings = await generateEmbeddings(["Hello", "World", "Test"]);
// → [
//     [0.123, -0.456, ...],  // embedding для "Hello"
//     [0.789, -0.012, ...],  // embedding для "World"
//     [0.345, -0.678, ...]   // embedding для "Test"
//   ]
```

**OpenAI API вызов:**
```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: cleanedTexts,  // ← Массив текстов
  dimensions: 1536,
});
const embeddings = response.data.map((item) => item.embedding);  // ← Все результаты
```

---

## 🎯 Ключевые различия

| Параметр | `generateEmbedding` | `generateEmbeddings` |
|----------|---------------------|---------------------|
| **Вход** | `string` (один текст) | `string[]` (массив текстов) |
| **Выход** | `number[]` (один вектор) | `number[][]` (массив векторов) |
| **API вызовы** | 1 вызов на 1 текст | 1 вызов на N текстов |
| **Производительность** | Медленнее (много вызовов) | Быстрее (batch обработка) |
| **Лимит** | Нет лимита на количество | Максимум 100 текстов |
| **Использование** | Для одного текста | Для множества текстов |

---

## 💡 Когда использовать что?

### Используй `generateEmbedding` когда:

1. **Один текст за раз**
   ```typescript
   // Поиск в истории чата
   const queryEmbedding = await generateEmbedding(userMessage);
   ```

2. **Интерактивные запросы** (пользователь отправляет сообщение)
   ```typescript
   // В searchChatHistory
   const queryEmbedding = await generateEmbedding(queryText);
   ```

3. **Обработка по требованию** (не batch)
   ```typescript
   // В embedChatMessage
   const embedding = await generateEmbedding(truncatedContent);
   ```

---

### Используй `generateEmbeddings` когда:

1. **Множество текстов одновременно**
   ```typescript
   // Обработка Knowledge Base
   const embeddings = await generateEmbeddings(chunks);
   ```

2. **Batch обработка** (загрузка данных)
   ```typescript
   // При создании глобальной KB
   const embeddings = await generateEmbeddings(texts);
   ```

3. **Оптимизация производительности** (меньше API вызовов)
   ```typescript
   // Вместо 100 вызовов generateEmbedding
   // Один вызов generateEmbeddings с 100 текстами
   ```

---

## ⚡ Производительность

### Пример: 100 текстов

**С `generateEmbedding` (100 вызовов):**
```typescript
const embeddings = [];
for (const text of texts) {
  const embedding = await generateEmbedding(text);  // 100 API вызовов
  embeddings.push(embedding);
}
// Время: ~10 секунд (100ms × 100)
// API вызовов: 100
```

**С `generateEmbeddings` (1 вызов):**
```typescript
const embeddings = await generateEmbeddings(texts);  // 1 API вызов
// Время: ~200ms
// API вызовов: 1
```

**Ускорение:** ~50x быстрее! ✅

---

## 🔒 Ограничения

### `generateEmbedding`
- ✅ Нет ограничений на количество вызовов
- ⚠️ Медленнее при большом количестве текстов
- ⚠️ Больше API вызовов = больше стоимость (если есть rate limits)

### `generateEmbeddings`
- ✅ Быстрее для batch обработки
- ✅ Меньше API вызовов
- ⚠️ **Лимит: максимум 100 текстов** (`MAX_BATCH_SIZE = 100`)
- ⚠️ Если больше 100 → нужно разбить на батчи

---

## 📝 Примеры использования в коде

### `generateEmbedding` используется в:

1. **`searchChatHistory`** (chat-embeddings.service.ts)
   ```typescript
   const queryEmbedding = await generateEmbedding(queryText);
   ```

2. **`embedChatMessage`** (chat-embeddings.service.ts)
   ```typescript
   const embedding = await generateEmbedding(truncatedContent);
   ```

### `generateEmbeddings` используется в:

1. **`uploadGlobalKB`** (kb.service.ts)
   ```typescript
   const embeddings = await generateEmbeddings(chunks.map((c) => c.content));
   ```

2. **`build-global-kb.ts`** (скрипт для создания KB)
   ```typescript
   const embeddings = await generateEmbeddings(texts);
   ```

---

## 🎯 Рекомендации

### Для chat embeddings:
- ✅ Используй `generateEmbedding` (один запрос пользователя за раз)

### Для Knowledge Base:
- ✅ Используй `generateEmbeddings` (batch обработка при загрузке)

### Для больших объемов (>100):
```typescript
// Разбить на батчи по 100
const batches = [];
for (let i = 0; i < texts.length; i += 100) {
  batches.push(texts.slice(i, i + 100));
}

const allEmbeddings = [];
for (const batch of batches) {
  const embeddings = await generateEmbeddings(batch);
  allEmbeddings.push(...embeddings);
}
```

---

## ✅ Итог

**`generateEmbedding`:**
- Один текст → один вектор
- Для интерактивных запросов
- Нет лимита на количество вызовов

**`generateEmbeddings`:**
- Множество текстов → множество векторов
- Для batch обработки
- Лимит: 100 текстов за раз
- **50x быстрее** для больших объемов

**Выбор зависит от контекста!** 🎯
