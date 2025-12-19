# Обработка истекших тест-планов

## Обзор

Когда пользователь пытается запустить истекший тест-план, система предлагает выбор:
- Создать новый план (рекомендуется)
- Запустить старый план (с продлением срока)

## Поведение

### 1. Обнаружение истекшего плана

При попытке approval истекшего плана:

```typescript
if (pendingPlan.expiresAt && new Date(pendingPlan.expiresAt) <= new Date()) {
  // Рассчитать, сколько времени прошло
  const expiredHoursAgo = Math.floor(
    (Date.now() - new Date(pendingPlan.expiresAt).getTime()) / (1000 * 60 * 60)
  );

  // Предложить выбор
  await saveAndRespond(chatSessionId, res, message, expiredMessage);
}
```

### 2. Сообщение пользователю

```
⚠️ Этот тест-план истек 5 часов назад.

**URL:** https://example.com
**Scope:** Test login functionality

**Варианты:**
1️⃣ Создать новый план (рекомендуется)
2️⃣ Запустить старый план (может быть устаревшим)

Ответьте **"новый"** или **"старый"**
```

### 3. Обработка выбора пользователя

#### Вариант A: Запустить старый план

**Триггеры:** "старый", "old", "запустить"

**Действия:**
1. Продление срока на 3 дня
2. Восстановление статуса `pending_confirmation`
3. Запуск плана

```typescript
if (messageLower.includes('старый') || messageLower.includes('old') || messageLower.includes('запустить')) {
  // Продлить expiry на 3 дня
  await supabaseAdmin
    .from('test_plans')
    .update({
      expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      status: 'pending_confirmation',
    })
    .eq('id', pendingPlan.id);

  // Запустить план
  await executeApprovedTestPlan(...);
}
```

#### Вариант B: Создать новый план

**Триггеры:** "новый", "new", "создать"

**Действия:**
1. Пометить старый план как `expired`
2. Продолжить с созданием нового плана

```typescript
if (messageLower.includes('новый') || messageLower.includes('new') || messageLower.includes('создать')) {
  // Пометить старый как expired
  await supabaseAdmin
    .from('test_plans')
    .update({ status: 'expired' })
    .eq('id', pendingPlan.id);

  // Ответить пользователю
  await saveAndRespond(chatSessionId, res, message,
    'Понял, создаю новый тест-план. Пожалуйста, опишите, что вы хотите протестировать.'
  );
}
```

## Логика проверки последнего AI сообщения

Система проверяет два случая:

1. **Тест-план требует approval:**
   - `metadata.requiresApproval === true`
   - `metadata.testPlan` существует
   - `metadata.conversationId` существует

2. **Предложение выбора истекшего плана:**
   - Контент содержит `'⚠️ Этот тест-план истек'`

```typescript
let lastAiMessageWasTestPlan = false;
let lastAiMessageWasExpiredChoice = false;

if (lastAiMessage?.metadata) {
  lastAiMessageWasTestPlan =
    lastAiMessage.metadata.requiresApproval === true ||
    !!lastAiMessage.metadata.testPlan ||
    !!lastAiMessage.metadata.conversationId;
}

if (lastAiMessage?.content?.includes('⚠️ Этот тест-план истек')) {
  lastAiMessageWasExpiredChoice = true;
}

// Продолжить только если одно из условий выполнено
if (!lastAiMessageWasTestPlan && !lastAiMessageWasExpiredChoice) {
  return false; // Не обрабатывать approval
}
```

## Форматирование времени

```typescript
const expiredMessage = expiredHoursAgo < 24
  ? `${expiredHoursAgo} ${expiredHoursAgo === 1 ? 'час' : expiredHoursAgo < 5 ? 'часа' : 'часов'} назад`
  : `${Math.floor(expiredHoursAgo / 24)} ${Math.floor(expiredHoursAgo / 24) === 1 ? 'день' : 'дня'} назад`;
```

**Примеры:**
- 1 час назад
- 3 часа назад
- 5 часов назад
- 1 день назад
- 2 дня назад

## Логирование

### При обнаружении истекшего плана:
```typescript
logger.info('[APPROVAL_CHECK] Plan expired, offering choice', {
  planId: pendingPlan.id,
  expiresAt: pendingPlan.expiresAt,
  expiredHoursAgo,
});
```

### При выборе запустить старый:
```typescript
logger.info('[APPROVAL_CHECK] User chose to run expired plan', {
  planId: pendingPlan.id,
  userMessage: message,
});

logger.info('[APPROVAL_CHECK] Expired plan renewed', { planId: pendingPlan.id });
```

### При выборе создать новый:
```typescript
logger.info('[APPROVAL_CHECK] User chose to create new plan', {
  planId: pendingPlan.id,
  userMessage: message,
});
```

## Преимущества

1. **Гибкость:** Пользователь сам решает, что делать
2. **Безопасность:** Предупреждение об устаревшем плане
3. **UX:** Понятное объяснение с вариантами
4. **Автоматизация:** Продление срока при запуске старого плана

## Недостатки

1. Дополнительный шаг для пользователя
2. Нужно правильно интерпретировать ответ

## Альтернативы

- Всегда создавать новый план (текущее поведение без фикса)
- Всегда разрешать запуск с предупреждением (Вариант 1)
- Автоматически продлевать срок при активности (более сложная логика)

## Тестирование

### Сценарий 1: Запуск старого плана
```
User: "yes"
AI: "⚠️ Этот тест-план истек 2 часа назад. Варианты: 1️⃣ Новый 2️⃣ Старый"
User: "старый"
AI: [запускает план]
```

### Сценарий 2: Создание нового плана
```
User: "yes"
AI: "⚠️ Этот тест-план истек 1 день назад. Варианты: 1️⃣ Новый 2️⃣ Старый"
User: "новый"
AI: "Понял, создаю новый тест-план. Пожалуйста, опишите..."
```

### Сценарий 3: Неясный ответ
```
User: "yes"
AI: "⚠️ Этот тест-план истек 5 часов назад. Варианты: 1️⃣ Новый 2️⃣ Старый"
User: "maybe later"
AI: [показывает выбор еще раз или просит уточнить]
```
