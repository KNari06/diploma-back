# 🔍 Аудит функций getTestPlan и getLatestPendingTestPlan

**Дата:** Декабрь 2024
**Файл:** `src/services/testing/plans/exploration-cache.service.ts`

---

## ✅ Что работает хорошо

### 1. Валидация входных параметров
- ✅ Обе функции проверяют UUID формат
- ✅ `getTestPlan` проверяет оба параметра (planId и userId)
- ✅ `getLatestPendingTestPlan` проверяет userId

### 2. Обработка ошибок
- ✅ Try-catch блоки
- ✅ Правильная обработка PGRST116 (record not found)
- ✅ Логирование ошибок

### 3. Проверка expires_at
- ✅ `getTestPlan` проверяет expires_at и обновляет статус
- ✅ `getLatestPendingTestPlan` фильтрует по `expires_at > NOW()` в SQL

---

## ⚠️ Найденные проблемы

### 🔴 КРИТИЧЕСКИЕ

#### 1. `getLatestPendingTestPlan`: Нет проверки expires_at после получения

**Проблема:**
```typescript
.gt('expires_at', new Date().toISOString())  // Фильтр в SQL
// Но что если expires_at = NULL?
```

**Риски:**
- Если `expires_at` = `NULL` → SQL фильтр `.gt()` не сработает
- Может вернуть план с `expires_at = NULL` (не истекший, но и не валидный)

**Исправление:**
```typescript
// После получения данных
if (data.expires_at && new Date(data.expires_at) <= new Date()) {
  logger.warn('[GET_LATEST_PENDING] Plan expired', { planId: data.id });
  return null;
}
```

---

#### 2. `getLatestPendingTestPlan`: Неполный возврат TestPlan

**Проблема:**
```typescript
return {
  id: data.id,
  status: data.status,
  // ... основные поля
  // ❌ НЕТ: notes, intelligentMode, estimatedPages, estimatedCost
};
```

**Сравнение с `getTestPlan`:**
```typescript
return {
  // ... все поля
  notes: data.notes || null,  // ✅ Есть
  intelligentMode: data.intelligent_mode || false,  // ✅ Есть
  estimatedPages: data.estimated_pages,  // ✅ Есть
  estimatedCost: data.estimated_cost,  // ✅ Есть
};
```

**Риски:**
- Несоответствие интерфейса TestPlan
- Могут быть ошибки TypeScript, если поля обязательные

**Исправление:**
```typescript
return {
  // ... все поля как в getTestPlan
  notes: data.notes || null,
  intelligentMode: data.intelligent_mode || false,
  estimatedPages: data.estimated_pages,
  estimatedCost: data.estimated_cost,
};
```

---

#### 3. `getLatestPendingTestPlan`: Нет проверки статуса после получения

**Проблема:**
```typescript
.eq('status', 'pending_confirmation')  // Фильтр в SQL
// Но что если статус изменился между запросом и получением?
```

**Риски:**
- Race condition: статус может измениться между SQL запросом и возвратом
- Лучше проверить еще раз перед возвратом

**Исправление:**
```typescript
if (data.status !== 'pending_confirmation') {
  logger.warn('[GET_LATEST_PENDING] Plan status changed', {
    planId: data.id,
    status: data.status,
  });
  return null;
}
```

---

### 🟡 ВАЖНЫЕ

#### 4. `getTestPlan`: Нет проверки статуса

**Проблема:**
```typescript
// ❌ Нет проверки, что план в статусе 'pending_confirmation'
// Может вернуть план со статусом 'confirmed' или 'rejected'
```

**Риски:**
- Может вернуть уже подтвержденный/отклоненный план
- В контексте `findPendingTestPlan` это может быть проблемой

**Исправление:**
```typescript
// Если используется для поиска pending планов, добавить проверку
if (data.status !== 'pending_confirmation') {
  logger.info('[GET_TEST_PLAN] Plan is not pending', {
    planId,
    status: data.status,
  });
  return null; // Или вернуть план, но логировать
}
```

**НО:** Это зависит от контекста использования. Если `getTestPlan` используется для получения любого плана (не только pending), то проверка не нужна.

---

#### 5. Обе функции: Нет обработки NULL значений в массивах

**Проблема:**
```typescript
steps: data.steps || [],  // ✅ Хорошо
// Но что если data.steps = null в БД?
```

**Риски:**
- Если в БД `steps = NULL`, то `data.steps || []` вернет `[]` ✅
- Но лучше явно проверить

**Текущее решение:** Уже правильно (`|| []` обрабатывает `null`)

---

#### 6. `getLatestPendingTestPlan`: Нет обработки ошибки при `maybeSingle()`

**Проблема:**
```typescript
const { data, error } = await query.maybeSingle();

if (error || !data) {
  // ❌ Не различает "нет данных" и "ошибка БД"
  return null;
}
```

**Риски:**
- Ошибка БД и "нет данных" обрабатываются одинаково
- Сложнее отлаживать проблемы

**Исправление:**
```typescript
if (error) {
  if (error.code === 'PGRST116') {
    // Record not found - это нормально
    logger.info('[GET_LATEST_PENDING] No pending plan found', { userId });
    return null;
  }
  // Другая ошибка
  logger.error('[GET_LATEST_PENDING] Database error', { error, userId });
  return null;
}

if (!data) {
  logger.info('[GET_LATEST_PENDING] No pending plan found', { userId });
  return null;
}
```

---

### 🟢 МЕЛКИЕ

#### 7. Обе функции: Нет логирования при отсутствии данных

**Проблема:**
```typescript
if (error || !data) {
  logger.info('[PENDING_PLAN] No pending test plan found', { userId });
  // ✅ Есть логирование
}
```

**Текущее решение:** Уже есть логирование ✅

---

#### 8. `getTestPlan`: Дублирование проверки expires_at

**Проблема:**
```typescript
// В getTestPlan
if (data.expires_at && new Date(data.expires_at) <= new Date()) {
  return null;
}

// В findPendingTestPlan (chat.controller.ts)
if (planByConversation && planByConversation.expiresAt) {
  if (new Date(planByConversation.expiresAt) <= new Date()) {
    validPlanByConversation = null;
  }
}
```

**Эффект:**
- Двойная проверка (избыточно, но безопасно)
- Можно убрать из `findPendingTestPlan`, так как `getTestPlan` уже проверяет

---

## 📊 Сравнение функций

| Параметр | `getTestPlan` | `getLatestPendingTestPlan` |
|----------|---------------|---------------------------|
| **Валидация UUID** | ✅ Оба параметра | ✅ userId |
| **Проверка expires_at** | ✅ После получения | ✅ В SQL + нужно после |
| **Проверка статуса** | ❌ Нет | ✅ В SQL + нужно после |
| **Полный TestPlan** | ✅ Все поля | ❌ Неполный |
| **Обработка ошибок** | ✅ Детальная | 🟡 Базовая |
| **Обновление статуса** | ✅ При истечении | ❌ Нет |

---

## 🔧 Рекомендации по исправлению

### Приоритет 1 (КРИТИЧЕСКИЕ)

1. ✅ Добавить проверку `expires_at` после получения в `getLatestPendingTestPlan`
2. ✅ Добавить все поля TestPlan в `getLatestPendingTestPlan`
3. ✅ Добавить проверку статуса после получения в `getLatestPendingTestPlan`

### Приоритет 2 (ВАЖНЫЕ)

4. ✅ Улучшить обработку ошибок в `getLatestPendingTestPlan` (различать PGRST116 и другие)
5. ⚠️ Рассмотреть проверку статуса в `getTestPlan` (зависит от контекста)

---

## 📝 Итоговая оценка

**getTestPlan:**
- Безопасность: 🟢 ХОРОШАЯ
- Надежность: 🟢 ХОРОШАЯ
- Полнота данных: 🟢 ХОРОШАЯ

**getLatestPendingTestPlan:**
- Безопасность: 🟡 СРЕДНЯЯ (нет проверки expires_at после получения)
- Надежность: 🟡 СРЕДНЯЯ (неполный TestPlan)
- Полнота данных: 🟡 СРЕДНЯЯ (не все поля)

**Общая оценка:** 🟡 ТРЕБУЕТСЯ ДОРАБОТКА
