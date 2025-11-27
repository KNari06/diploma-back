# shouldUseVision(): Как система понимает нужен ли Vision AI?

**Дата:** 2024-11-27
**Файл:** `src/agent/intelligent-page-analyzer.ts`

---

## ❓ Вопрос

> Как ты узнаешь что Vision AI (<5 elements) не нужен?

---

## 💡 Ответ

Vision AI **не вызывается вслепую**. Сначала делается **DOM analysis** (быстрый, 0.5 сек), а потом на основе результатов DOM решается: нужен Vision или нет.

---

## 🔍 Как это работает?

### Шаг 1: DOM Analysis (всегда выполняется)

```typescript
// src/agent/intelligent-page-analyzer.ts:88-93

const [modalCheckResult, domAnalysis] = await Promise.all([
  this.quickModalCheck(page), // Fast check
  this.analyzeDOMFull(page),   // ← СНАЧАЛА анализируем DOM (0.5 sec)
]);
```

**Что получаем:**
```typescript
domAnalysis = {
  forms: [...],         // Массив форм
  buttons: [...],       // Массив кнопок
  inputs: [...],        // Массив input полей
  links: [...],         // Массив ссылок
  modals: [...],        // Модальные окна (если найдены)
}
```

---

### Шаг 2: Решение - нужен ли Vision?

```typescript
// src/agent/intelligent-page-analyzer.ts:120-122

const shouldUseVisionResult = mode === 'full' ||
  (mode === 'balanced' && await this.shouldUseVision(domAnalysis));
  //                               ↑ Используем результаты DOM analysis
```

**Логика:**
- Если mode = `'full'` → Vision **всегда**
- Если mode = `'balanced'` → проверяем через `shouldUseVision(domAnalysis)`
- Если mode = `'fast'` → Vision **никогда**

---

### Шаг 3: shouldUseVision() - умное решение

```typescript
// src/agent/intelligent-page-analyzer.ts:1271-1296

private static async shouldUseVision(domAnalysis: DOMAnalysis): Promise<boolean> {
  // 1️⃣ Считаем TOTAL interactive elements
  const totalInteractiveElements =
    domAnalysis.forms.length +       // Формы
    domAnalysis.buttons.length +     // Кнопки
    domAnalysis.inputs.length +      // Input поля
    domAnalysis.links.length;        // Ссылки

  // 2️⃣ Если МАЛО элементов (<5) → Vision НЕ НУЖЕН!
  if (totalInteractiveElements < 5) {
    logger.debug('[INTELLIGENT_ANALYZER] Skipping Vision for simple page', {
      totalInteractiveElements
    });
    return false;  // ✅ Пропускаем Vision (экономия 11-12 сек)
  }

  // 3️⃣ Если элементов много → проверяем сложность
  const hasComplexForms = domAnalysis.forms.length > 1;      // Много форм?
  const hasManyButtons = domAnalysis.buttons.length > 10;    // Много кнопок?
  const hasModals = (domAnalysis.modals?.length || 0) > 0;   // Есть модалы?

  // 4️⃣ Vision нужен ТОЛЬКО для сложных страниц
  return hasComplexForms || hasManyButtons || hasModals;
}
```

---

## 📊 Примеры работы

### Пример 1: Простая страница (Vision НЕ НУЖЕН)

**Страница:**
```html
<h1>Contact Us</h1>
<form>
  <input name="email" />
  <input name="message" />
  <button>Send</button>
</form>
```

**DOM Analysis:**
```typescript
domAnalysis = {
  forms: [1 форма],
  buttons: [1 кнопка],
  inputs: [2 input'а],
  links: []
}

totalInteractiveElements = 1 + 1 + 2 + 0 = 4  // ❌ < 5
```

**Решение:**
```typescript
shouldUseVision(domAnalysis)
→ totalInteractiveElements = 4 < 5
→ return false  // ✅ Пропускаем Vision AI (экономия 11-12 сек!)
```

**Результат:**
- DOM analysis: 0.5 сек ✅
- Vision AI: пропущен ⏭️
- **Итого: 0.5 сек** (вместо 12 сек)

---

### Пример 2: Сложная страница (Vision НУЖЕН)

**Страница:**
```html
<header>
  <button>Login</button>
  <button>Sign Up</button>
  <button>Menu</button>
</header>

<div id="cookie-banner">
  <p>We use cookies</p>
  <button>Accept</button>
  <button>Decline</button>
</div>

<form id="search">
  <input name="query" />
  <button>Search</button>
</form>

<main>
  <a href="/product1">Product 1</a>
  <a href="/product2">Product 2</a>
  <a href="/product3">Product 3</a>
  <!-- ... 20+ links -->
</main>

<form id="newsletter">
  <input name="email" />
  <button>Subscribe</button>
</form>
```

**DOM Analysis:**
```typescript
domAnalysis = {
  forms: [search form, newsletter form],  // 2 формы
  buttons: [Login, Sign Up, Menu, Accept, Decline, Search, Subscribe],  // 7 кнопок
  inputs: [query, email],  // 2 input'а
  links: [20+ ссылок],
  modals: [{ type: 'cookie_banner', ... }]  // Модалка найдена
}

totalInteractiveElements = 2 + 7 + 2 + 20 = 31  // ✅ > 5
```

**Решение:**
```typescript
shouldUseVision(domAnalysis)
→ totalInteractiveElements = 31 >= 5  // ✅ Много элементов
→ hasComplexForms = (2 > 1) = true    // ✅ Несколько форм
→ hasManyButtons = (7 > 10) = false
→ hasModals = (1 > 0) = true          // ✅ Есть модалка
→ return true  // ✅ Vision AI нужен!
```

**Результат:**
- DOM analysis: 0.5 сек ✅
- Vision AI: 11-12 сек ✅ (нужен для понимания cookie banner + приоритета кнопок)
- **Итого: 12 сек**

---

## 🎯 Когда Vision пропускается vs используется

| Условие | Vision? | Почему |
|---------|---------|---------|
| totalInteractive < 5 | ❌ НЕТ | Простая страница, DOM достаточно |
| totalInteractive >= 5 && forms > 1 | ✅ ДА | Несколько форм - нужно понять priority |
| totalInteractive >= 5 && buttons > 10 | ✅ ДА | Много кнопок - нужно понять primary CTA |
| totalInteractive >= 5 && modals > 0 | ✅ ДА | Модалки - Vision видит их лучше |
| totalInteractive >= 5 && simple | ❌ НЕТ | Много элементов, но все простые |

---

## 🔄 Flow диаграмма

```
┌──────────────────────────────────────┐
│ Page loaded                          │
└──────────────────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│ DOM Analysis (0.5 sec)               │
│ - Extract buttons, inputs, forms     │
│ - Extract links, modals              │
└──────────────────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│ shouldUseVision(domAnalysis)?        │
└──────────────────────────────────────┘
              ↓
      ┌───────┴───────┐
      ↓               ↓
    ❌ NO           ✅ YES
  (<5 elem)      (complex)
      ↓               ↓
┌───────────┐   ┌────────────────┐
│ Skip      │   │ Vision AI      │
│ Vision AI │   │ (11-12 sec)    │
└───────────┘   └────────────────┘
      ↓               ↓
┌──────────────────────────────────────┐
│ Return PageContext                   │
└──────────────────────────────────────┘
```

---

## 📈 Performance Impact

### Сценарий A: 100 простых страниц (<5 elements)

**БЕЗ оптимизации:**
- 100 pages × 12 sec = **1200 секунд (20 минут)**

**С оптимизацией (shouldUseVision):**
- 100 pages × 0.5 sec = **50 секунд**

**Экономия: 1150 секунд (19 минут)** 🚀

---

### Сценарий B: 100 сложных страниц (>10 elements)

**БЕЗ оптимизации:**
- 100 pages × 12 sec = **1200 секунд**

**С оптимизацией:**
- 100 pages × 12 sec = **1200 секунд** (Vision нужен)

**Экономия: 0 секунд** (но это правильно, Vision здесь нужен)

---

### Сценарий C: 50/50 (50 простых + 50 сложных)

**БЕЗ оптимизации:**
- 100 pages × 12 sec = **1200 секунд**

**С оптимизацией:**
- 50 simple × 0.5 sec = 25 сек
- 50 complex × 12 sec = 600 сек
- **Итого: 625 секунд**

**Экономия: 575 секунд (9.5 минут)** 🚀

---

## 💡 Ключевые моменты

### 1. DOM Analysis - ВСЕГДА первым

```typescript
// СНАЧАЛА
const domAnalysis = await this.analyzeDOMFull(page);  // 0.5 sec

// ПОТОМ решение
const needVision = await this.shouldUseVision(domAnalysis);
```

**Почему:** DOM быстрый (0.5 сек) и даёт нам всю нужную информацию для решения.

---

### 2. Порог <5 элементов - эмпирический

```typescript
if (totalInteractiveElements < 5) {
  return false;  // Vision не нужен
}
```

**Почему 5?**
- Простые формы: обычно 2-4 элемента (email, password, submit)
- Contact forms: 3-5 элементов
- Простые CTA: 1-3 кнопки

Если <5 → Vision не даст значимого улучшения, но заберёт 11-12 сек.

---

### 3. Дополнительные критерии сложности

```typescript
const hasComplexForms = domAnalysis.forms.length > 1;     // Несколько форм
const hasManyButtons = domAnalysis.buttons.length > 10;   // Много кнопок
const hasModals = (domAnalysis.modals?.length || 0) > 0;  // Модалки
```

**Почему:**
- Несколько форм → нужно понять какая главная (Vision видит layout)
- Много кнопок → нужно понять Primary vs Secondary (Vision видит цвет/размер)
- Модалки → Vision видит их лучше чем DOM (особенно dynamic inject)

---

## ✅ Итог

### Как система узнаёт что Vision не нужен?

1. **Сначала DOM analysis** (0.5 сек) - извлекает все элементы
2. **Считает элементы** - `forms + buttons + inputs + links`
3. **Если < 5** → Vision не нужен (простая страница)
4. **Если >= 5** → проверяет сложность:
   - Несколько форм? → Vision нужен
   - Много кнопок (>10)? → Vision нужен
   - Есть модалки? → Vision нужен
   - Иначе → Vision не нужен

**Результат:** Экономия 11-12 сек на простых страницах + умное использование Vision только там где он нужен.

---

**Дата:** 2024-11-27
**Автор:** AI Assistant
