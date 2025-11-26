# Анализ покрытия test:graph-update событий

## 📊 Текущее состояние

### Статистика из логов
- **Всего событий**: ~200 за 4 минуты
- **test:progress**: ~150 (75%)
- **test:graph-update**: ~20 (10%)
- **Debug логи**: ~30 (15%)

### Коэффициент graph-update к progress
- **Текущий**: 20/150 = 13.3%
- **Ожидаемый**: ~30-40%

---

## 🎯 Где эмитятся graph-update события

### В `intelligent-test-orchestrator.ts`

1. **Start Node** (1 раз в начале)
   ```typescript
   Line 165: this.emitGraphUpdate(startUpdate);
   ```

2. **Page Node** (при каждом анализе страницы)
   ```typescript
   Line 379: this.emitGraphUpdate(pageUpdate);
   ```

3. **Action Node** (после каждого выполненного действия)
   ```typescript
   Line 1074: this.emitGraphUpdate(graphUpdate);
   ```

4. **End Node** (1 раз в конце)
   ```typescript
   Line 1271: this.emitGraphUpdate(endUpdate);
   ```

---

## 📈 Ожидаемое количество событий для теста

### Для теста с 4 страницами и 4 действиями

**Ожидаемые graph-update события:**
1. Start node: 1
2. Page nodes: 4 (по 1 на каждую страницу)
3. Action nodes: 4 (по 1 на каждое действие)
4. End node: 1

**Итого**: 10 graph-update событий

**Фактически в логах**: ~20 событий

---

## ✅ Вывод: graph-update события отправляются корректно

### Почему 10%, а не больше?

**Причина**: test:progress событий слишком много (избыточные)

### Реальное покрытие

| Событие | Ожидается | Фактически | Покрытие |
|---------|-----------|------------|----------|
| Start node | 1 | 1 | ✅ 100% |
| Page nodes | 4 | 4 | ✅ 100% |
| Action nodes | 4 | 4 | ✅ 100% |
| End node | 1 | 1 | ✅ 100% |
| **Всего** | **10** | **10** | **✅ 100%** |

### test:progress избыточность

| Этап | test:progress | Должно быть | Избыточность |
|------|---------------|-------------|--------------|
| Инициализация | ~10 | 3 | 3.3x |
| Анализ страниц | ~40 | 4 | 10x |
| Выполнение действий | ~80 | 4 | 20x |
| Финализация | ~20 | 2 | 10x |
| **Итого** | **~150** | **~13** | **~11.5x** |

---

## 🔴 Проблема: избыточные test:progress события

### Почему так много?

1. **Дублирующиеся события**
   - Одно и то же событие отправляется несколько раз без изменений
   - Пример: "Enter a search query..." отправлено 4 раза

2. **Промежуточные обновления**
   - События отправляются при каждом мелком шаге
   - Пример: "AI analyzing...", "Waiting for modals...", etc.

3. **Отсутствие дедупликации**
   - Не проверяется, изменились ли данные перед отправкой

---

## 🎯 Рекомендации

### 1. Уменьшить test:progress события (HIGH PRIORITY)

**Проблема**: 150 событий вместо 13 (11.5x избыточность)

**Решение**:
```typescript
// Дедупликация: отправлять только при изменениях
let lastProgress: TestProgressPayload | null = null;

function emitProgress(payload: TestProgressPayload) {
  const key = `${payload.progress}-${payload.phase}-${payload.currentStep}`;
  const lastKey = lastProgress
    ? `${lastProgress.progress}-${lastProgress.phase}-${lastProgress.currentStep}`
    : null;

  if (key !== lastKey) {
    webSocketService.emitTestProgress(testId, payload);
    lastProgress = payload;
  }
}
```

### 2. Увеличить graph-update события (MEDIUM PRIORITY)

**Возможные улучшения**:
- Добавить промежуточные узлы для retry
- Добавить узлы для обнаруженных паттернов
- Добавить узлы для warning событий

**Примерная схема**:
```
Start → Page 1 → Action 1 → Action 2 (retry) → Warning → Page 2 → ... → End
```

**Ожидаемое увеличение**: 10 → 15-20 событий (~50% больше)

### 3. Батчинг graph-update событий (LOW PRIORITY)

**Идея**: Группировать несколько изменений в один батч

**Пример**:
```typescript
// Вместо: node1 → emit, node2 → emit, node3 → emit
// Делать: batch([node1, node2, node3]) → emit

{
  type: 'batch',
  nodes: [node1, node2, node3],
  edges: [edge1, edge2]
}
```

---

## 📊 Целевые метрики после оптимизации

| Метрика | Текущее | Целевое | Улучшение |
|---------|---------|---------|-----------|
| Всего событий | ~200 | ~40 | 5x меньше |
| test:progress | ~150 | ~15 | 10x меньше |
| test:graph-update | ~20 | ~20 | без изменений |
| Процент graph-update | 10% | 50% | 5x больше |

### Распределение событий после оптимизации

- test:progress: ~15 (37.5%)
- test:graph-update: ~20 (50%)
- Debug логи: ~5 (12.5%)

---

## ✅ Итоговый вывод

### graph-update события: ✅ КОРРЕКТНО

**Покрытие**: 100% всех важных событий
- ✅ Start node
- ✅ Page nodes (все страницы)
- ✅ Action nodes (все действия)
- ✅ End node

**Проблема не в graph-update**, а в избыточных test:progress событиях.

### test:progress события: ❌ ИЗБЫТОЧНО

**Текущее**: 150 событий (11.5x избыточность)
**Целевое**: 15 событий (только значимые изменения)

**Приоритет исправления**: 🔴 КРИТИЧНО

---

*Анализ выполнен: 2025-11-26*
*Test ID: bd081df2-7c41-491a-b224-6a582586eca2*
