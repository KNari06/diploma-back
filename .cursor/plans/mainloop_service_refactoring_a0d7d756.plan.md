---
name: MainLoop Service Refactoring
overview: Глубокий анализ и рефакторинг MainLoopService для улучшения читаемости, уменьшения дублирования кода и упрощения поддержки. Выделение повторяющейся логики в отдельные методы и сервисы.
todos:
  - id: create-iteration-guard
    content: Создать IterationGuardService для централизованных проверок (cancellation, limits, about:blank)
    status: pending
  - id: create-navigation-helper
    content: Создать NavigationHelper для унификации логики goBack/goto
    status: pending
  - id: create-decision-handlers
    content: Создать DecisionHandlers для обработки всех типов решений (stop/wait_for_user/skip/retry/continue)
    status: pending
  - id: create-page-state-checker
    content: Создать PageStateChecker для проверок состояния страницы (empty/cycles/patterns)
    status: pending
  - id: create-clarification-helper
    content: Вынести clarification логику в ClarificationHelper (detectMissingDataType, buildClarificationQuestion)
    status: pending
  - id: create-error-recovery
    content: Создать ErrorRecoveryService для централизованной обработки ошибок
    status: pending
  - id: refactor-execute-method
    content: "Разбить execute() на smaller methods: executeIteration(), processPageAnalysis(), processActionGeneration(), processActionExecution(), processDecision()"
    status: pending
  - id: remove-code-duplication
    content: "Убрать дублирование: использовать новые helper сервисы, кэшировать pageContext"
    status: pending
  - id: improve-error-handling
    content: "Улучшить обработку ошибок: структурированные error objects, лучший контекст"
    status: pending
  - id: add-caching
    content: Добавить кэширование для AdaptiveConfigService.analyzePageContext() на время итерации
    status: pending
  - id: test-refactoring
    content: "Протестировать рефакторинг: убедиться что поведение не изменилось"
    status: pending
---

# MainLoop Service Refactoring Plan

## Текущее состояние

**Файл:** `src/agent/main-loop.service.ts` (709 строк)

**Проблемы:**

1. Метод `execute()` слишком длинный (640+ строк) - нарушает Single Responsibility Principle
2. Дублирование кода в нескольких местах
3. Сложная вложенность условий
4. Повторяющиеся паттерны обработки
5. Методы clarification логики смешаны с основной логикой

## Анализ структуры

### Текущий flow в execute():

```
1. Инициализация (iteration++, getState)
2. Проверка cancellation (строка 110)
3. Проверка limits (строка 121)
4. STEP 1: Analyze page (строка 144)
   - Проверка about:blank (строка 148)
   - Добавление page node в graph (строка 162)
   - Проверка cancellation после анализа (строка 192)
5. STEP 1.5: Empty pages detection (строка 200)
   - Логика goBack/goto (строка 252-273)
6. STEP 2: Cycle detection (строка 283)
   - Логика goBack/goto (строка 310-318)
7. STEP 2.5: Pattern detection (строка 321)
8. STEP 3: Generate actions (строка 356)
   - Обработка empty actions (строка 359)
9. STEP 4: Execute actions (строка 387)
10. STEP 5: Record visit (строка 399)
11. STEP 6: Decide next step (строка 416)
    - Switch statement с 5 cases (строка 436)
    - wait_for_user: сложная логика clarification (строка 442-506)
    - skip: логика goBack/goto (строка 508-532)
12. Проверка cancellation после итерации (строка 546)
13. Error handling (строка 554)
```

### Зависимости:

- `SafetyGuard` - проверка лимитов
- `StateTracker` - детекция циклов, запись визитов
- `ActionPatternDetector` - детекция проблемных паттернов
- `ContextualActionGenerator` - генерация действий и решений
- `AdaptiveConfigService` - адаптивные конфигурации
- `ClarificationService` - запросы уточнений (динамический require)

## План рефакторинга

### Этап 1: Выделение проверок в отдельные методы

**1.1. Создать IterationGuardService**

- Файл: `src/agent/utils/iteration-guard.service.ts`
- Методы:
                                                                                                                                - `checkCancellation()` - централизованная проверка
                                                                                                                                - `checkLimits()` - обертка над SafetyGuard
                                                                                                                                - `checkAboutBlank()` - проверка about:blank URL
                                                                                                                                - `shouldStopIteration()` - комбинированная проверка всех guard'ов

**1.2. Создать NavigationHelper**

- Файл: `src/agent/utils/navigation-helper.service.ts`
- Методы:
                                                                                                                                - `navigateBackOrToStart()` - унифицированная логика goBack → goto(startUrl)
                                                                                                                                - `recoverFromAboutBlank()` - восстановление из about:blank

**1.3. Вынести DecisionHandlers**

- Файл: `src/agent/utils/decision-handlers.service.ts`
- Методы:
                                                                                                                                - `handleStopDecision()` - обработка stop
                                                                                                                                - `handleWaitForUserDecision()` - обработка wait_for_user (вся логика clarification)
                                                                                                                                - `handleSkipDecision()` - обработка skip (с navigation)
                                                                                                                                - `handleRetryDecision()` - обработка retry
                                                                                                                                - `handleContinueDecision()` - обработка continue

### Этап 2: Выделение проверок состояния страницы

**2.1. Создать PageStateChecker**

- Файл: `src/agent/utils/page-state-checker.service.ts`
- Методы:
                                                                                                                                - `checkEmptyPage()` - проверка пустой страницы
                                                                                                                                - `checkCycles()` - проверка циклов (обертка над StateTracker)
                                                                                                                                - `checkPatterns()` - проверка паттернов (обертка над ActionPatternDetector)
                                                                                                                                - `shouldSkipActionGeneration()` - комбинированная проверка

**2.2. Упростить логику empty pages**

- Вынести в `handleEmptyPage()` метод
- Убрать дублирование с skip decision

### Этап 3: Рефакторинг clarification логики

**3.1. Вынести в ClarificationHelper**

- Файл: `src/agent/utils/clarification-helper.service.ts`
- Методы:
                                                                                                                                - `detectMissingDataType()` - из MainLoopService
                                                                                                                                - `buildClarificationQuestion()` - из MainLoopService
                                                                                                                                - `requestClarification()` - обертка над ClarificationService

**3.2. Убрать динамический require**

- Заменить `require('./utils/clarification.service')` на нормальный import

### Этап 4: Упрощение основного цикла

**4.1. Разбить execute() на этапы**

- `executeIteration()` - одна итерация цикла
- `processPageAnalysis()` - обработка анализа страницы
- `processActionGeneration()` - обработка генерации действий
- `processActionExecution()` - обработка выполнения действий
- `processDecision()` - обработка решения

**4.2. Создать IterationContext**

- Объект для передачи контекста между методами
- Включает: state, context, pageContext, iteration, etc.

### Этап 5: Улучшение error handling

**5.1. Создать ErrorRecoveryService**

- Файл: `src/agent/utils/error-recovery.service.ts`
- Методы:
                                                                                                                                - `handleIterationError()` - централизованная обработка ошибок
                                                                                                                                - `checkInfiniteLoop()` - проверка бесконечных циклов
                                                                                                                                - `shouldStopOnErrors()` - решение остановиться при ошибках

**5.2. Улучшить логирование ошибок**

- Структурированные error objects
- Контекст ошибки (iteration, state, action)

### Этап 6: Оптимизация производительности

**6.1. Кэширование pageContext**

- `AdaptiveConfigService.analyzePageContext()` вызывается много раз
- Кэшировать результат на время итерации

**6.2. Оптимизация проверок**

- Объединить проверки empty/cycle/pattern в один проход
- Использовать early returns

## Детальный план изменений

### Файл 1: `src/agent/utils/iteration-guard.service.ts` (новый)

```typescript
export class IterationGuardService {
  static async checkCancellation(checkFn: () => Promise<boolean>): Promise<boolean>
  static checkLimits(state: TestState, config: SafetyConfig): SafetyCheckResult
  static checkAboutBlank(url: string): boolean
  static async shouldStopIteration(...): Promise<{ shouldStop: boolean; reason?: string }>
}
```

### Файл 2: `src/agent/utils/navigation-helper.service.ts` (новый)

```typescript
export class NavigationHelper {
  static async navigateBackOrToStart(
    page: Page,
    startUrl: string,
    state: TestState,
    config: IntelligentTestConfig
  ): Promise<{ success: boolean; newUrl: string }>
  
  static async recoverFromAboutBlank(
    page: Page,
    startUrl: string,
    state: TestState
  ): Promise<boolean>
}
```

### Файл 3: `src/agent/utils/decision-handlers.service.ts` (новый)

```typescript
export class DecisionHandlers {
  static handleStop(decision: NextStepDecision, ...): { continueLoop: boolean }
  static async handleWaitForUser(decision: NextStepDecision, ...): Promise<{ continueLoop: boolean }>
  static async handleSkip(decision: NextStepDecision, ...): Promise<{ continueLoop: boolean }>
  static handleRetry(decision: NextStepDecision, ...): { continueLoop: boolean }
  static handleContinue(decision: NextStepDecision, ...): { continueLoop: boolean }
}
```

### Файл 4: `src/agent/utils/page-state-checker.service.ts` (новый)

```typescript
export class PageStateChecker {
  static checkEmptyPage(context: PageContext): { isEmpty: boolean; elementsCount: number }
  static checkCycles(state: TestState, url: string): CycleDetectionResult
  static checkPatterns(state: TestState): PatternDetectionResult
  static shouldSkipActionGeneration(...): { shouldSkip: boolean; reason?: string }
}
```

### Файл 5: `src/agent/utils/clarification-helper.service.ts` (новый)

```typescript
export class ClarificationHelper {
  static detectMissingDataType(reason: string, context: PageContext): ClarificationType | null
  static buildClarificationQuestion(type: ClarificationType, reason: string, context: PageContext): string
  static async requestClarification(...): Promise<string | null>
}
```

### Файл 6: `src/agent/utils/error-recovery.service.ts` (новый)

```typescript
export class ErrorRecoveryService {
  static handleIterationError(error: Error, state: TestState, ...): { shouldStop: boolean; shouldContinue: boolean }
  static checkInfiniteLoop(errors: Error[], config: IntelligentTestConfig): { detected: boolean; reason?: string }
  static shouldStopOnErrors(state: TestState, config: IntelligentTestConfig): boolean
}
```

### Файл 7: `src/agent/main-loop.service.ts` (рефакторинг)

**Изменения:**

1. Упростить `execute()` - оставить только координацию
2. Вынести логику в методы:

                                                                                                                                                                                                - `executeIteration()` - одна итерация
                                                                                                                                                                                                - `processPageAnalysis()` - анализ страницы
                                                                                                                                                                                                - `processActionGeneration()` - генерация действий
                                                                                                                                                                                                - `processActionExecution()` - выполнение действий
                                                                                                                                                                                                - `processDecision()` - обработка решения

3. Убрать дублирование:

                                                                                                                                                                                                - Использовать `IterationGuardService` для всех проверок
                                                                                                                                                                                                - Использовать `NavigationHelper` для навигации
                                                                                                                                                                                                - Использовать `DecisionHandlers` для решений

4. Улучшить читаемость:

                                                                                                                                                                                                - Убрать глубокую вложенность
                                                                                                                                                                                                - Использовать early returns
                                                                                                                                                                                                - Добавить комментарии к сложным участкам

## Ожидаемые улучшения

1. **Читаемость**: Метод `execute()` сократится с 640 до ~150 строк
2. **Тестируемость**: Каждый компонент можно тестировать отдельно
3. **Поддерживаемость**: Изменения в одной области не затрагивают другие
4. **Переиспользование**: Helper'ы можно использовать в других местах
5. **Производительность**: Кэширование pageContext уменьшит вычисления

## Риски и митигация

1. **Риск**: Изменение поведения при рефакторинге

                                                                                                                                                                                                - **Митигация**: Сохранить все существующие проверки, добавить тесты

2. **Риск**: Увеличение количества файлов

                                                                                                                                                                                                - **Митигация**: Логическая группировка в utils/

3. **Риск**: Breaking changes в зависимостях

                                                                                                                                                                                                - **Митигация**: Сохранить интерфейс MainLoopDependencies без изменений

## Порядок выполнения

1. Создать helper сервисы (IterationGuard, NavigationHelper, etc.)
2. Рефакторить MainLoopService пошагово
3. Тестировать