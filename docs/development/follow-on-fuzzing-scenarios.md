# Follow-On Fuzzing Scenarios - Intelligent Iterative Testing

## Overview

Система follow-on сценариев позволяет AI генератору создавать **целевые эксплойты** на основе найденных уязвимостей в начальном этапе fuzzing-тестирования.

---

## Архитектура

### 2-фазный подход к fuzzing

```
┌─────────────────────────────────────────────────────────────────┐
│                    API Fuzzing Flow                             │
└─────────────────────────────────────────────────────────────────┘

PHASE 1: Initial Fuzzing (Broad Coverage)
──────────────────────────────────────────
┌─────────────────┐
│ Happy Path Test │ (Success)
└────────┬────────┘
         │
         ▼
┌──────────────────────────────┐
│ Generate Initial Scenarios   │ ← GPT generates 10-15 scenarios
│ - Authentication             │   covering ALL categories:
│ - Authorization              │   • Auth/Authz
│ - Method validation          │   • Input validation
│ - Payload validation         │   • Security (SQL, XSS)
│ - Security tests             │   • Performance
│ - Rate limiting              │   • Rate limiting
│ - Performance                │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ Execute Scenarios (Phase 1)  │
│ - Concurrency: 5 parallel    │
│ - Timeout: 5s per scenario   │
│ - Progress: 73% → 85%        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ Analyze Results              │
│ - Identify issues            │
│ - Calculate severity         │
│ - Security score             │
└──────────┬───────────────────┘
           │
           ├─────────────── No critical/high issues? ──→ DONE ✅
           │                                               Return initial report
           │
           └─── Critical/High issues found? ────┐
                                                 │
PHASE 2: Follow-On Fuzzing (Targeted Deep Dive) │
────────────────────────────────────────────────┤
                                                 ▼
                 ┌────────────────────────────────────────┐
                 │ Filter Critical/High Severity Issues   │
                 │ - severity: "critical" or "high"       │
                 │ - Min required: 1+ issue               │
                 └────────────┬───────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────────────────────┐
                 │ Generate Follow-On Scenarios           │ ← GPT generates 5-10 TARGETED
                 │ - Based on found vulnerabilities       │   scenarios to exploit deeper:
                 │ - Deeper exploitation                  │   • If SQL works → try UNION
                 │ - Combined attacks                     │   • If XSS works → try DOM-XSS
                 │ - Advanced payloads                    │   • If auth bypass → privilege esc
                 │ - Encoding variations                  │   • Combine multiple vulns
                 └────────────┬───────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────────────────────┐
                 │ Execute Follow-On Scenarios            │
                 │ - Concurrency: 5 parallel              │
                 │ - Timeout: 5s per scenario             │
                 │ - Progress: 87% → 97%                  │
                 └────────────┬───────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────────────────────┐
                 │ Merge Reports                          │
                 │ - Combine scenarios (dedupe)           │
                 │ - Combine issues (dedupe)              │
                 │ - Recalculate security score           │
                 │ - Add metadata (phases info)           │
                 └────────────┬───────────────────────────┘
                              │
                              ▼
                           DONE ✅
                   Return comprehensive report
                   (Initial + Follow-On results)
```

---

## Когда запускается Follow-On?

### Триггеры:

1. **Критичность**: Найдены `critical` или `high` severity issues
2. **Количество**: Минимум 1+ критичная проблема (настраивается)
3. **Таймаут**: Общий таймаут fuzzing не истек
4. **Abort signal**: Процесс не был прерван

### Пример:

```typescript
// Initial phase нашел:
const criticalIssues = [
  {
    type: 'authentication',
    severity: 'critical',
    description: 'Endpoint returns 200 without auth',
  },
  {
    type: 'security',
    severity: 'high',
    description: 'SQL injection detected',
  },
];

// → Триггер follow-on! ✅
```

---

## Генерация Follow-On сценариев

### Как AI генерирует умные сценарии:

```typescript
// IntelligentApiFuzzerService.generateFollowOnScenarios()

// INPUT:
{
  baseRequest: { method: 'GET', url: 'https://api.example.com/users' },
  previousResults: {
    scenarios: [...], // Результаты Phase 1
    issues: [...],    // Найденные проблемы
  },
  criticalIssues: [
    {
      type: 'security',
      severity: 'critical',
      description: 'SQL injection in query parameter',
      evidence: 'Status: 200, Body: {"users": [...]}',
    },
  ],
}

// GPT PROMPT CONTEXT:
- API endpoint details
- Critical issues found (с evidence)
- Failed initial scenarios
- Instruction to generate 5-10 TARGETED exploits

// OUTPUT:
[
  {
    id: 'followon_sql_union',
    type: 'security',
    description: '[FOLLOW-ON] UNION-based SQL injection to extract data',
    request: {
      method: 'GET',
      url: "https://api.example.com/users?id=1' UNION SELECT username,password FROM users--",
    },
    expectedStatus: 400,
    basedOnIssue: 'SQL injection vulnerability found in initial testing',
  },
  {
    id: 'followon_sql_time_based',
    type: 'security',
    description: '[FOLLOW-ON] Time-based blind SQL injection',
    request: {
      method: 'GET',
      url: "https://api.example.com/users?id=1' AND SLEEP(5)--",
    },
    expectedStatus: 400,
    basedOnIssue: 'SQL injection vulnerability found in initial testing',
  },
  // ... еще 3-8 сценариев
]
```

### Интеллектуальная логика:

1. **Глубина эксплуатации**:
   - Initial: `SQL Injection → Basic payload (' OR '1'='1)`
   - Follow-On: `UNION attacks, time-based blind, encoding bypasses`

2. **Комбинирование атак**:
   - Initial: `Auth bypass (no token)`
   - Follow-On: `Auth bypass + privilege escalation (admin endpoint access)`

3. **Вариации payload**:
   - Initial: `XSS → <script>alert(1)</script>`
   - Follow-On: `DOM-based XSS, reflected XSS, encoded XSS (&#60;script&#62;)`

4. **Edge cases**:
   - Initial: `Malformed JSON → {invalid}`
   - Follow-On: `Extreme payloads (10MB JSON, deeply nested objects, circular refs)`

---

## Валидация и безопасность

### Проверки в `generateFollowOnScenarios`:

```typescript
// VALIDATION #1: Input validation
✓ baseRequest is object
✓ baseRequest.url is valid URL
✓ baseRequest.method is non-empty string

// VALIDATION #2: Issues exist
✓ foundIssues is array with length > 0

// VALIDATION #3: Severity filter
✓ Only 'critical' or 'high' severity issues trigger follow-on
✓ Min 1+ critical issue required (FUZZING_CONFIG.FOLLOW_ON.MIN_CRITICAL_ISSUES)

// VALIDATION #4: Previous results structure
✓ previousResults.scenarios is array
✓ previousResults.issues is array

// VALIDATION #5: GPT response validation
✓ Response has 'scenarios' array
✓ Retry logic (max 2 retries) if invalid response

// VALIDATION #6: Scenario count
✓ Min 3 scenarios expected (FUZZING_CONFIG.FOLLOW_ON.MIN_SCENARIOS)
✓ Max 10 scenarios allowed (FUZZING_CONFIG.FOLLOW_ON.MAX_SCENARIOS)

// NORMALIZATION:
✓ Each scenario has all required fields
✓ Invalid scenarios filtered out (null check)
✓ ID prefix: 'followon_'
✓ Description prefix: '[FOLLOW-ON]'
```

### Конфигурация (FUZZING_CONFIG.FOLLOW_ON):

```typescript
{
  MAX_SCENARIOS: 10,          // Макс. сценариев для генерации
  MIN_SCENARIOS: 3,           // Мин. ожидаемых от GPT
  MIN_CRITICAL_ISSUES: 1,     // Мин. критичных проблем для триггера
  ALLOWED_SEVERITIES: ['critical', 'high'], // Разрешенные severity
  MAX_RETRIES: 2,             // Макс. попыток при ошибке GPT
}
```

---

## Объединение отчетов (mergeFuzzingReports)

### Что объединяется:

```typescript
// Initial Report:
{
  scenarios: [10 scenarios],
  issues: [3 critical, 2 high],
  summary: { totalTests: 10, passed: 7, failed: 3 },
  securityScore: 5.0,
}

// Follow-On Report:
{
  scenarios: [7 scenarios],
  issues: [2 critical, 1 high], // Новые проблемы найдены
  summary: { totalTests: 7, passed: 4, failed: 3 },
  securityScore: 4.0,
}

// Merged Report:
{
  scenarios: [17 scenarios],      // Deduplicated by ID
  issues: [5 critical, 3 high],   // Deduplicated by type+description
  summary: {
    totalTests: 17,               // Sum
    passed: 11,                   // Sum
    failed: 6,                    // Sum
    duration: 15000,              // Sum (ms)
  },
  securityScore: 2.0,             // Recalculated: 10 - (5*3 + 3*2) = -11 → 0 (clamped)
  metadata: {
    hadFollowOn: true,
    initialPhase: { tests: 10, issues: 5 },
    followOnPhase: { tests: 7, issues: 3 },
  },
}
```

### Дедупликация:

- **Scenarios**: По уникальному `id`
- **Issues**: По комбинации `type + description`
- **Recommendations**: По уникальности текста

---

## Прогресс-репортинг

### Progress updates (emitProcessingStep):

```
70%  → 🔍 Generating initial security scenarios...
73%  → 🎯 Testing 12 initial security scenarios...
73%  → 🔒 Testing security [Phase 1] (1/12)...
75%  → 🔒 Testing security [Phase 1] (3/12)...
...
85%  → ⚠️ 3 critical issue(s) found! Generating targeted exploits...
87%  → 🎯 Testing 7 follow-on scenarios...
87%  → 🔥 Deep exploit testing [Phase 2] (1/7)...
90%  → 🔥 Deep exploit testing [Phase 2] (3/7)...
...
97%  → 🔥 Deep exploit testing [Phase 2] (7/7)...
100% → ✅ Security analysis complete! Found 8 issue(s) across 2 phases
```

---

## Примеры Follow-On сценариев

### Пример 1: SQL Injection → Deeper Exploitation

```typescript
// Initial Phase нашел:
{
  type: 'security',
  description: 'SQL injection in query parameter',
  evidence: 'URL: /users?id=1\' OR \'1\'=\'1 returned 200 with user data',
}

// Follow-On генерирует:
[
  {
    id: 'followon_sql_union',
    description: '[FOLLOW-ON] UNION-based SQL to extract passwords',
    request: {
      url: "/users?id=1' UNION SELECT username,password FROM users--",
    },
  },
  {
    id: 'followon_sql_time_based',
    description: '[FOLLOW-ON] Time-based blind SQL injection',
    request: {
      url: "/users?id=1' AND IF(1=1, SLEEP(5), 0)--",
    },
  },
  {
    id: 'followon_sql_encoding',
    description: '[FOLLOW-ON] SQL injection with URL encoding bypass',
    request: {
      url: "/users?id=1%27%20OR%20%271%27%3D%271",
    },
  },
]
```

### Пример 2: Auth Bypass → Privilege Escalation

```typescript
// Initial Phase нашел:
{
  type: 'authentication',
  description: 'Endpoint accessible without auth',
  evidence: 'No Authorization header returned 200',
}

// Follow-On генерирует:
[
  {
    id: 'followon_auth_admin',
    description: '[FOLLOW-ON] Access admin endpoint without auth',
    request: {
      url: '/admin/users',
      headers: {}, // No auth
    },
  },
  {
    id: 'followon_auth_jwt_none',
    description: '[FOLLOW-ON] JWT with "alg: none" bypass',
    request: {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJ1c2VyIjoiYWRtaW4ifQ.',
      },
    },
  },
]
```

---

## Преимущества Follow-On подхода

### 1. **Целевая эксплуатация** 🎯
   - Фокус на найденных уязвимостях
   - Глубокий анализ конкретных проблем
   - Не тратим время на тесты, которые точно пройдут

### 2. **Адаптивность** 🧠
   - AI учитывает контекст (что сработало, что нет)
   - Генерирует вариации успешных атак
   - Комбинирует multiple vulnerabilities

### 3. **Эффективность** ⚡
   - Broad coverage (Phase 1) → Targeted deep dive (Phase 2)
   - Экономия ресурсов (follow-on только при критичных проблемах)
   - Timeout-защита на каждом этапе

### 4. **Детальность** 📊
   - Метаданные о фазах (initial vs follow-on)
   - Связь сценариев с найденными проблемами (`basedOnIssue`)
   - Полная история эксплуатации

---

## Конфигурация и настройки

### Файл: `src/services/testing/api/fuzzing/fuzzing-config.ts`

```typescript
export const FUZZING_CONFIG = {
  // Timeouts
  OUTER_TIMEOUT: 30000,        // 30s для всех фаз
  SCENARIO_TIMEOUT: 5000,      // 5s на сценарий

  // Concurrency
  MAX_CONCURRENT_REQUESTS: 5,  // Параллельные запросы

  // Follow-on settings
  FOLLOW_ON: {
    MAX_SCENARIOS: 10,          // Макс. follow-on сценариев
    MIN_SCENARIOS: 3,           // Мин. ожидаемых от GPT
    MIN_CRITICAL_ISSUES: 1,     // Триггер: мин. critical issues
    ALLOWED_SEVERITIES: ['critical', 'high'],
    MAX_RETRIES: 2,             // Retry логика для GPT
  },
};
```

---

## Логирование

### Ключевые логи:

```bash
# Phase 1: Initial
[API_FUZZING] Starting intelligent fuzzing
[API_FUZZER] Generating fuzzing scenarios
[API_FUZZER] Generated fuzzing scenarios (count: 12)
[FUZZING_EXECUTOR] Starting fuzzing execution
[API_FUZZING] Initial fuzzing completed (issuesFound: 5)

# Phase 2: Follow-On (if triggered)
[API_FUZZING] Critical issues found, generating follow-on scenarios (criticalCount: 3)
[API_FUZZER] Generating follow-on scenarios (criticalIssuesCount: 3)
[API_FUZZER] Generated follow-on scenarios successfully (count: 7, retries: 0)
[FUZZING_EXECUTOR] Starting fuzzing execution (scenarioCount: 7)
[API_FUZZING] Follow-on fuzzing completed (newIssuesFound: 2)

# Merge
[API_FUZZING] Merging fuzzing reports (initialTests: 12, followOnTests: 7)
[API_FUZZING] Reports merged successfully (totalTests: 19, totalIssues: 7)
[API_FUZZING] Fuzzing completed (all phases, hadFollowOn: true)
```

---

## Возможные улучшения (Future)

1. **3-фазный подход**:
   - Phase 1: Broad coverage
   - Phase 2: Targeted exploits
   - Phase 3: Ultra-deep (если Phase 2 нашел новые critical)

2. **ML-based приоритизация**:
   - AI учится на успешных exploits
   - Предсказывает наиболее вероятные уязвимости

3. **Кастомные payload templates**:
   - User-defined attack patterns
   - Industry-specific exploits (e.g., OWASP Top 10 focused)

4. **Интеграция с CVE databases**:
   - Автоматическое сопоставление с известными уязвимостями

---

## Заключение

Follow-on сценарии превращают fuzzing из "shotgun approach" в **интеллектуальный, адаптивный процесс**:

- ✅ Находим больше уязвимостей
- ✅ Углубляемся в критичные проблемы
- ✅ Экономим ресурсы (целевое тестирование)
- ✅ Предоставляем детальные отчеты с контекстом

**Результат**: Более качественное и эффективное security testing! 🔒🚀
