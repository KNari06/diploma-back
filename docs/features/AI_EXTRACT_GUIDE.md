# AI Extract: Structured Data Extraction

**Дата:** 2024-11-27
**Статус:** ✅ Ready for production

---

## 🎯 Что это?

**AI Extract** - система извлечения структурированных данных из HTML/DOM с использованием GPT и JSON schema валидации. Аналог функциональности Momentic.

### Возможности:

1. ✅ **JSON Schema валидация** - определяете структуру, AI извлекает данные
2. ✅ **Auto-mode detection** - автоматический выбор HTML или text
3. ✅ **Few-shot examples** - примеры для улучшения точности
4. ✅ **Helper methods** - готовые методы для таблиц, списков, прайсинга
5. ✅ **Confidence scores** - оценка уверенности в извлечении

---

## 📋 Основное использование

### 1. **Базовый пример: Извлечение прайсинга**

```typescript
import { AIExtractService } from '@/services/ai-extract';

// Определяем структуру данных
const schema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      price: { type: 'number' },
      features: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['plan', 'price']
  }
};

// Извлекаем данные
const result = await AIExtractService.extract(page, {
  selector: '.pricing-table',
  schema,
  mode: 'html', // или 'text' или 'auto'
  instructions: 'Extract all pricing plans with features'
});

if (result.success) {
  console.log('Extracted data:', result.data);
  // [
  //   { plan: 'Basic', price: 9.99, features: ['Feature 1', 'Feature 2'] },
  //   { plan: 'Pro', price: 29.99, features: ['Feature 1', 'Feature 2', 'Feature 3'] }
  // ]

  console.log('Confidence:', result.confidence); // 0.9
  console.log('Tokens used:', result.metadata.tokensUsed);
}
```

---

### 2. **Использование в тестах (CommandExecutor)**

```typescript
// В Playwright команде
const command: PlaywrightCommand = {
  action: 'extract',
  selector: 'table.pricing',
  extract: {
    name: 'pricingData',
    useAI: true, // ✅ Включаем AI extraction
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          plan: { type: 'string' },
          price: { type: 'number' },
          currency: { type: 'string' }
        }
      }
    },
    mode: 'html',
    instructions: 'Extract pricing information'
  }
};

// CommandExecutor автоматически использует AI Extract
const result = await executor.executeCommand(command);

// Данные сохраняются в extractedData Map
const pricing = executor.getExtractedData().get('pricingData');
```

---

### 3. **DynamicAction (Intelligent Testing)**

```typescript
// AI генерирует actions с AI extract
const action: DynamicAction = {
  action: 'extract',
  selector: 'section.products',
  description: 'Extract product catalog',
  extract: {
    name: 'products',
    useAI: true,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'number' },
          inStock: { type: 'boolean' },
          imageUrl: { type: 'string' }
        },
        required: ['name', 'price']
      }
    },
    mode: 'html'
  }
};
```

---

## 🛠️ Helper Methods

### 1. **extractTable() - Таблицы**

```typescript
// С заголовками
const result = await AIExtractService.extractTable(
  page,
  'table.users',
  { hasHeader: true }
);

// Без заголовков (указываем колонки)
const result = await AIExtractService.extractTable(
  page,
  'table.data',
  { columns: ['Name', 'Age', 'Email'] }
);

// Result:
// [
//   { Name: 'John', Age: 25, Email: 'john@example.com' },
//   { Name: 'Jane', Age: 30, Email: 'jane@example.com' }
// ]
```

---

### 2. **extractList() - Списки**

```typescript
// Простой список строк
const result = await AIExtractService.extractList(
  page,
  'ul.features'
);

// Result: ['Feature 1', 'Feature 2', 'Feature 3']

// Список объектов
const result = await AIExtractService.extractList(
  page,
  'ul.products',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      price: { type: 'number' }
    }
  }
);

// Result: [
//   { name: 'Product 1', price: 19.99 },
//   { name: 'Product 2', price: 29.99 }
// ]
```

---

### 3. **extractPricing() - Прайсинг**

```typescript
// Автоматическое извлечение прайсинга
const result = await AIExtractService.extractPricing(
  page,
  'section.pricing'
);

// Result:
// [
//   {
//     name: 'Basic',
//     price: 9.99,
//     currency: '$',
//     period: 'monthly',
//     features: ['10 GB Storage', '100 API Calls', 'Email Support']
//   },
//   {
//     name: 'Pro',
//     price: 29.99,
//     currency: '$',
//     period: 'monthly',
//     features: ['100 GB Storage', 'Unlimited API Calls', 'Priority Support']
//   }
// ]
```

---

## 📚 Продвинутые примеры

### 1. **Few-shot examples для сложных случаев**

```typescript
const result = await AIExtractService.extract(page, {
  selector: '.custom-pricing',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        tier: { type: 'string' },
        monthlyPrice: { type: 'number' },
        annualPrice: { type: 'number' }
      }
    }
  },
  mode: 'html',
  // ✅ Примеры для AI
  examples: [
    {
      input: '<div>Pro: $29/mo or $290/year</div>',
      output: {
        tier: 'Pro',
        monthlyPrice: 29,
        annualPrice: 290
      }
    }
  ],
  instructions: 'Extract both monthly and annual pricing'
});
```

---

### 2. **Комплексная структура (nested objects)**

```typescript
const schema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'number' },
          specs: {
            type: 'object',
            properties: {
              cpu: { type: 'string' },
              ram: { type: 'string' },
              storage: { type: 'string' }
            }
          }
        }
      }
    }
  }
};

const result = await AIExtractService.extract(page, {
  selector: '#product-catalog',
  schema,
  mode: 'html'
});

// Result:
// {
//   company: 'Tech Corp',
//   products: [
//     {
//       name: 'Laptop Pro',
//       price: 1299,
//       specs: { cpu: 'M2', ram: '16GB', storage: '512GB SSD' }
//     }
//   ]
// }
```

---

### 3. **Error handling & validation**

```typescript
const result = await AIExtractService.extract(page, {
  selector: '.data-section',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        value: { type: 'number' }
      },
      required: ['id', 'value'] // ✅ Required fields
    }
  }
});

if (!result.success) {
  console.error('Extraction failed:', result.error);
  // Handle error
}

if (result.confidence < 0.7) {
  console.warn('Low confidence extraction:', result.confidence);
  // Maybe retry or manual review
}

// Check metadata
console.log('Duration:', result.metadata.duration, 'ms');
console.log('Tokens used:', result.metadata.tokensUsed);
console.log('Model:', result.metadata.model); // 'gpt-4o-mini'
```

---

## 🔧 Режимы извлечения

### 1. **HTML mode** (для структурированного контента)

```typescript
mode: 'html'
```

**Когда использовать:**
- Таблицы (`<table>`)
- Списки (`<ul>`, `<ol>`)
- Формы (`<form>`)
- Сложные структуры (`<section>`, `<article>`)

**Пример:**
```html
<table class="pricing">
  <tr><th>Plan</th><th>Price</th></tr>
  <tr><td>Basic</td><td>$9.99</td></tr>
  <tr><td>Pro</td><td>$29.99</td></tr>
</table>
```

---

### 2. **Text mode** (для простого текста)

```typescript
mode: 'text'
```

**Когда использовать:**
- Параграфы
- Заголовки
- Простые блоки текста
- Когда HTML структура не важна

**Пример:**
```html
<div class="summary">
Total users: 1,234
Active today: 567
Revenue: $12,345
</div>
```

---

### 3. **Auto mode** (автоопределение)

```typescript
mode: 'auto' // или не указывать вообще
```

**Логика:**
- Если `<table>`, `<ul>`, `<ol>`, `<form>`, `<section>`, `<article>` → **HTML mode**
- Иначе → **Text mode**

---

## 📊 Типы данных

### Поддерживаемые типы:

```typescript
// String
{ type: 'string' }

// Number (автоматически парсит "$29.99" → 29.99)
{ type: 'number' }

// Boolean (инферит из "Yes" → true, "No" → false)
{ type: 'boolean' }

// Array
{
  type: 'array',
  items: { type: 'string' } // или любой другой тип
}

// Object
{
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' }
  },
  required: ['name'] // Опционально: обязательные поля
}
```

---

## ⚡ Performance & Cost

### Скорость:

| Режим | Скорость | Tokens |
|-------|----------|--------|
| **Text (simple)** | 1-2 сек | ~500 |
| **HTML (table)** | 2-4 сек | ~1000 |
| **HTML (complex)** | 3-5 сек | ~2000 |

### Стоимость (gpt-4o-mini):

- Input: $0.150 / 1M tokens
- Output: $0.600 / 1M tokens
- **Средняя стоимость:** ~$0.001 на extraction

### Оптимизация:

```typescript
// ✅ Ограничение контента до 10K символов
const content = element.innerHTML().substring(0, 10000);

// ✅ Используем gpt-4o-mini (быстрее + дешевле)
model: 'gpt-4o-mini'

// ✅ Low temperature для детерминизма
temperature: 0.1
```

---

## 🔍 Сравнение с традиционным extract

### Традиционный extract:

```typescript
// Только простые данные
extract: {
  name: 'price',
  property: 'text' // или 'innerHTML' или 'value'
}

// Result: "$29.99" (string)
```

### AI Extract:

```typescript
// Структурированные данные с валидацией
extract: {
  name: 'pricing',
  useAI: true,
  schema: {
    type: 'object',
    properties: {
      price: { type: 'number' },
      currency: { type: 'string' }
    }
  }
}

// Result: { price: 29.99, currency: '$' } (validated object)
```

---

## 🎯 Use Cases

### 1. **E-commerce: Product Catalog**

```typescript
await AIExtractService.extract(page, {
  selector: '#products',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'number' },
        rating: { type: 'number' },
        inStock: { type: 'boolean' },
        imageUrl: { type: 'string' }
      }
    }
  }
});
```

---

### 2. **Finance: Stock Prices**

```typescript
await AIExtractService.extract(page, {
  selector: '.stock-data',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        price: { type: 'number' },
        change: { type: 'number' },
        percentChange: { type: 'number' }
      }
    }
  }
});
```

---

### 3. **SaaS: Feature Comparison**

```typescript
await AIExtractService.extractTable(page, 'table.comparison', {
  hasHeader: true
});
// Автоматически извлечёт все features и планы
```

---

## ✅ Best Practices

### 1. **Используйте required fields**

```typescript
schema: {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' }
  },
  required: ['id', 'name'] // ✅ Email опционален
}
```

---

### 2. **Добавляйте descriptions**

```typescript
schema: {
  type: 'object',
  properties: {
    price: {
      type: 'number',
      description: 'Price in USD (e.g., 29.99)' // ✅ Помогает AI
    }
  }
}
```

---

### 3. **Используйте few-shot для сложных форматов**

```typescript
examples: [
  {
    input: 'Pro Plan - $29/month (billed annually: $290)',
    output: {
      plan: 'Pro',
      monthlyPrice: 29,
      annualPrice: 290
    }
  }
]
```

---

### 4. **Проверяйте confidence**

```typescript
if (result.confidence < 0.7) {
  // Retry or manual review
  logger.warn('Low confidence extraction', { confidence: result.confidence });
}
```

---

## 🚀 Integration with Intelligent Testing

### AI может генерировать extract actions автоматически:

```typescript
// GPT-4o анализирует страницу и генерирует:
{
  action: 'extract',
  selector: 'table.pricing',
  description: 'Extract pricing table for validation',
  extract: {
    name: 'pricingData',
    useAI: true,
    schema: {
      // AI автоматически генерирует schema на основе страницы!
      type: 'array',
      items: {
        type: 'object',
        properties: {
          plan: { type: 'string' },
          price: { type: 'number' }
        }
      }
    },
    mode: 'html'
  }
}
```

---

## 📝 Summary

| Feature | Supported | Notes |
|---------|-----------|-------|
| **JSON Schema** | ✅ | Full support |
| **Auto-mode** | ✅ | HTML vs Text |
| **Few-shot** | ✅ | Examples for accuracy |
| **Helper methods** | ✅ | Table, List, Pricing |
| **Confidence** | ✅ | 0.0-1.0 score |
| **Validation** | ✅ | Basic schema validation |
| **Error handling** | ✅ | Graceful fallback |
| **Performance** | ✅ | 1-5 sec, ~$0.001/extract |

---

**Готово!** AI Extract полностью интегрирован и готов к использованию! 🎉

---

**Дата:** 2024-11-27
**Версия:** 1.0.0
