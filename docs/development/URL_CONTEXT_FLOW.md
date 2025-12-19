# URL Context & Scope Strategy Flow

## Логическая цепочка (end-to-end)

```
1. User Request → handlePlatformTest
   ↓
2. Parse user answers (URL, scope, credentials)
   ↓
3. Autonomous Exploration
   ↓
4. URL Context Analysis (AI) ← NEW
   ↓
5. Scope Strategy (hardcoded + URL context) ← ENHANCED
   ↓
6. Enhanced Context Builder
   ↓
7. Test Plan Generation (AI with full context)
   ↓
8. User Confirmation
   ↓
9. Test Execution
```

## Детальный поток (Step 4-7)

### Step 4: URL Context Analysis (AI)

**Функция:** `analyzeUrlContext(url)`
**Расположение:** `autonomous-orchestrator.service.ts:35-108`
**Промпт:** `buildUrlAnalysisPrompt()` в `ai/prompts/test-plan-prompts.ts`

**Вход:**

```typescript
url: "https://myapp.com/admin/users?page=2";
```

**AI анализ:**

```typescript
{
  insights: ["Admin interface detected", "User management page"],
  warnings: ["Requires authentication", "Data may change between test runs"],
  recommendations: ["Test role-based access control", "Verify CRUD operations", "Test pagination"]
}
```

**Стоимость:** ~$0.0001-0.0002
**Модель:** GPT-4o-mini
**Время:** ~500-1000ms

---

### Step 5: Scope Strategy (hardcoded + URL context)

**Функция:** `getScopeStrategy(scope, urlContext)`
**Расположение:** `autonomous-orchestrator.service.ts:115-211`

**Вход:**

```typescript
scope: "full"
urlContext: {
  insights: ["Admin interface detected", "User management page"],
  warnings: ["Requires authentication"],
  recommendations: ["Test role-based access control", "Verify CRUD operations", "Test pagination"]
}
```

**Процесс:**

1. Получить базовую стратегию из hardcoded (scope='full'):

   ```typescript
   {
     description: "Comprehensive site-wide testing",
     estimatedDuration: "10-15 minutes",
     focusAreas: [
       "All major user journeys",
       "Navigation across sections",
       "Responsive design (desktop/mobile)",
       // ... 6 more
     ],
     testTypes: ["functional", "visual", "accessibility", "performance", "integration", "smoke"]
   }
   ```

2. Адаптировать с URL context (добавить топ-3 рекомендации):
   ```typescript
   {
     ...baseStrategy,
     focusAreas: [
       // Базовые (9 items)
       "All major user journeys",
       "Navigation across sections",
       // ...
       // + URL-специфичные (3 items)
       "Test role-based access control",
       "Verify CRUD operations",
       "Test pagination"
     ] // Итого: 12 уникальных пунктов
   }
   ```

**Выход:**

```typescript
{
  description: "Comprehensive site-wide testing",
  estimatedDuration: "10-15 minutes",
  focusAreas: [
    "All major user journeys",
    "Navigation across sections",
    "Responsive design (desktop/mobile)",
    "Accessibility compliance",
    "Performance on key pages",
    "Cross-browser compatibility",
    "Core platform functionality",
    "Integration points",
    "Platform stability",
    "Test role-based access control",      // ← NEW от URL context
    "Verify CRUD operations",              // ← NEW от URL context
    "Test pagination"                      // ← NEW от URL context
  ],
  testTypes: ["functional", "visual", "accessibility", "performance", "integration", "smoke"]
}
```

**Стоимость:** $0 (hardcoded с адаптацией)
**Время:** <1ms

---

### Step 6: Enhanced Context Builder

**Расположение:** `autonomous-orchestrator.service.ts:489-505`

**Процесс:**

```typescript
const enhancedContext = {
  message: userMessage,
  scope: "full",
  additionalInfo: {
    ...parsedAnswers.additionalInfo,
    // Из URL context
    urlInsights: ["Admin interface detected", "User management page"],
    urlWarnings: [
      "Requires authentication",
      "Data may change between test runs",
    ],
    recommendations: [
      "Test role-based access control",
      "Verify CRUD operations",
      "Test pagination",
    ],
    // Из scope strategy
    scopeDescription: "Comprehensive site-wide testing",
    focusAreas: [
      "All major user journeys",
      // ... 11 more (включая 3 от URL context)
    ],
    testTypes: [
      "functional",
      "visual",
      "accessibility",
      "performance",
      "integration",
      "smoke",
    ],
    estimatedDuration: "10-15 minutes",
  },
};
```

---

### Step 7: Test Plan Generation (AI with full context)

**Функция:** `generateTestPlan(exploration, enhancedContext)`
**Расположение:** `test-plan-generator.service.ts:416-521`
**Промпт:** `buildTestPlanPrompt(exploration, enhancedContext)`
**Промпт расположение:** `ai/prompts/test-plan-prompts.ts:201-327`

**Улучшенный промпт включает:**

```
USER REQUEST:
"Test admin panel functionality"

SCOPE:
full

TESTING SCOPE GUIDANCE:
Strategy: Comprehensive site-wide testing
Estimated Duration: 10-15 minutes
Focus Areas:
  - All major user journeys
  - Navigation across sections
  - Responsive design (desktop/mobile)
  - Accessibility compliance
  - Performance on key pages
  - Cross-browser compatibility
  - Core platform functionality
  - Integration points
  - Platform stability
  - Test role-based access control        ← NEW
  - Verify CRUD operations                ← NEW
  - Test pagination                       ← NEW
Test Types: functional, visual, accessibility, performance, integration, smoke

URL CONTEXT ANALYSIS:
Insights:
  - Admin interface detected
  - User management page
Warnings:
  ⚠️ Requires authentication
  ⚠️ Data may change between test runs
Recommendations:
  ✅ Test role-based access control
  ✅ Verify CRUD operations
  ✅ Test pagination

PAGE INFORMATION:
- URL: https://myapp.com/admin/users?page=2
- Title: Admin - Users

... (DOM analysis, visual analysis, etc.)
```

**AI генерирует тест-план с учетом:**

1. Базовых областей тестирования (scope strategy)
2. URL-специфичных рекомендаций (URL context)
3. Предупреждений (URL warnings)
4. Фактического DOM анализа

**Результат:** более точный и релевантный тест-план

---

## Преимущества новой архитектуры

### 1. Гибридный подход (Hardcoded + AI)

- **Hardcoded scope strategy** - быстро, бесплатно, предсказуемо
- **AI URL analysis** - адаптивно, контекстно, точно

### 2. Многоуровневая адаптация

```
Scope (full) → Base Strategy (9 focus areas)
    ↓
URL Context (AI) → +3 URL-specific areas
    ↓
Combined Strategy (12 unique areas)
    ↓
Test Plan (AI) → Tailored to actual page
```

### 3. Стоимость

- URL Context Analysis: ~$0.0002
- Scope Strategy: $0
- Test Plan Generation: ~$0.005
- **Итого:** ~$0.0052 (на 0.0002 дороже, но качество выше)

### 4. Время

- URL Context: +500-1000ms
- Scope Strategy: <1ms (адаптация)
- **Итого:** +500-1000ms на весь flow (приемлемо)

---

## Пример: различие для разных URL

### URL 1: E-commerce checkout

```typescript
url: "https://shop.com/checkout"

urlContext: {
  insights: ["E-commerce checkout flow", "Payment processing"],
  recommendations: ["Test payment validation", "Verify cart calculations", "Test shipping options"]
}

scopeStrategy (full): {
  focusAreas: [
    ...base 9 areas,
    "Test payment validation",
    "Verify cart calculations",
    "Test shipping options"
  ]
}
```

### URL 2: Admin dashboard

```typescript
url: "https://app.com/admin"

urlContext: {
  insights: ["Admin dashboard", "Management interface"],
  recommendations: ["Test role-based access", "Verify CRUD operations", "Test data filtering"]
}

scopeStrategy (full): {
  focusAreas: [
    ...base 9 areas,
    "Test role-based access",
    "Verify CRUD operations",
    "Test data filtering"
  ]
}
```

**→ Одинаковый scope, но разные фокусы благодаря URL context**

---

## Файлы изменений

### 1. `autonomous-orchestrator.service.ts`

- `analyzeUrlContext()` - AI анализ URL
- `getScopeStrategy(scope, urlContext)` - адаптация стратегии
- `enhancedContext` - сборка контекста для AI

### 2. `ai/prompts/test-plan-prompts.ts`

- `buildUrlAnalysisPrompt()` - промпт для URL анализа
- `buildUrlAnalysisSystemPrompt()` - system prompt
- `buildTestPlanPrompt()` - улучшен с `scopeGuidance` и `urlContextSection`

### 3. `ai/prompts/index.ts`

- Экспорт `buildUrlAnalysisPrompt` и `buildUrlAnalysisSystemPrompt`

---

## Мониторинг и отладка

### Логи URL Context

```typescript
logger.info("[URL_ANALYSIS] AI analysis completed", {
  url: "https://myapp.com/admin/users?page=2",
  insights: 2,
  warnings: 2,
  recommendations: 3,
  tokens: 450,
});
```

### Логи Scope Strategy

```typescript
logger.info("[AUTONOMOUS] Context analysis completed", {
  insights: 2,
  warnings: 2,
  scope: "full",
  strategy: "Comprehensive site-wide testing",
  focusAreasCount: 12, // 9 base + 3 from URL
});
```

### Логи Test Plan

```typescript
logger.info("Test plan generated (intelligent mode)", {
  planId: "uuid",
  stepsCount: 15,
  commandsCount: 15,
});
```
