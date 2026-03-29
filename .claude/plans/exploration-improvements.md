# Exploration v2 Improvements Plan

## Цель
Сделать exploration реально рабочим — чтобы агент понимал контекст продукта, находил все тестируемые flows и показывал прогресс в реальном времени.

---

## Phase 1: Контекст продукта (без этого агент слепой)

### 1.1 Product Context Collector
**Файл:** `survey-agent.ts` → метод `collectProductContext(page)`

Перед Cartographer AI, собрать контекст страницы:
- `document.title`
- `meta[name="description"]`
- `<h1>` текст
- `<nav>` элементы (все ссылки из навигации)
- URL pattern (`/login`, `/dashboard`, `/cart` → тип приложения)
- Текст на кнопках (Login, Sign Up, Buy, Contact)

Передать в Cartographer prompt как `PRODUCT CONTEXT` секцию.

### 1.2 DOM-based Navigation Fallback
**Файл:** `survey-agent.ts`

Если Cartographer не вернул navigationLinks — **автоматически** собрать из DOM:
```typescript
const navLinks = await page.$$eval('nav a, header a, [role="navigation"] a', links =>
  links.map(a => ({ url: a.href, text: a.textContent.trim() }))
    .filter(l => l.url && !l.url.startsWith('javascript:'))
);
```
Это гарантирует что BFS **всегда** получит навигацию, даже если AI fail.

### 1.3 Full-page Screenshot
**Файл:** `survey-agent.ts` → `captureScreenshot()`

Сейчас: `page.screenshot({ fullPage: false })` → видит только viewport.
Изменить: `page.screenshot({ fullPage: true })` → видит всю страницу.
Если fullPage слишком большой (>2MB) — делать 2 screenshot: viewport + scrolled.

### 1.4 Credential Detection в Cartographer Prompt
**Файл:** `cartographer-prompts.ts`

Добавить в system prompt:
```
CREDENTIAL DETECTION:
- Look for test credentials displayed on the page (e.g., "Username: student", "Password: test123")
- Look for demo/test account information
- Report any found credentials in authDetection.testCredentials field
```

---

## Phase 2: Data Flow Fixes (фронт показывает пустоту)

### 2.1 Phase в каждом WebSocket Event
**Файл:** `exploration-engine.ts`, `survey-agent.ts`, `flow-runner.ts`

Каждый `emitProgress()` должен содержать `phase: string`. Сейчас не все events имеют phase → фронт не обновляет состояние.

### 2.2 Flow Step Events
**Файл:** `flow-runner.ts`

Добавить emit `flow_step` при каждом шаге TestPipeline. Сейчас emit-ятся только `flow_started` и `flow_completed`. Нужно подписаться на pipeline progress callback:
```typescript
pipeline.onStepCompleted = (step) => {
  this.emitProgress('flow_step', { flowId, step });
};
```

### 2.3 HTTP Fallback Endpoint
**Файл:** `exploration.route.ts` → `GET /api/v1/explorations/:id`

Если юзер перезагрузил страницу — live WebSocket data потеряны. Нужен endpoint который возвращает текущее состояние exploration из БД:
- status (running/completed/failed)
- pages discovered
- flows + их статусы
- coverage score

**Фронт:** `ExplorationLive.jsx` → useEffect при mount → fetch текущее состояние.

### 2.4 Frontend Store Init Race Condition
**Файл:** `useExplorationSocket.js`

Проблема: exploration может завершиться быстрее чем фронт подписывается на WebSocket.
Fix: после navigate на `/explorations/:id` — сразу fetch состояние через HTTP, потом слушать WebSocket для обновлений.

---

## Phase 3: Качество Discovery (агент находит мало)

### 3.1 Улучшить SnapshotCollector для Exploration
**Файл:** `survey-agent.ts` → `collectSnapshot()`

Использовать `SnapshotCollector.collect()` из lite mode (DRY) вместо кастомного сбора. SnapshotCollector уже делает:
- Progressive scroll
- Interactive element detection
- Form detection
- Accessibility tree

### 3.2 Cartographer Prompt — Visual Analysis
**Файл:** `cartographer-prompts.ts`

Добавить в system prompt:
```
VISUAL ANALYSIS (from screenshot):
- Identify navigation bar/menu structure visually
- Spot interactive buttons, forms, CTAs by their visual appearance
- Detect sidebar navigation, footer links
- Notice modal triggers, dropdown menus, search bars
- Pay attention to visual hierarchy — large prominent buttons are high priority
```

### 3.3 Scout → передать knownPages и все pageInsights
**Файл:** `flow-runner.ts` line ~1151

Сейчас: `knownPages: []` (пустой, TODO).
Fix: передать `blackboard.tree.getAllVisitedUrls()` и полный `pageInsights` map.

### 3.4 Strategist Prompt — Condensed Summary
**Файл:** `strategist-prompts.ts`

Для сайтов с 20+ страницами — не передавать все insights verbatim. Агрегировать:
```
Pages summary:
- 3 auth pages (login, signup, forgot-password)
- 5 product pages (catalog, detail x3, cart)
- 2 content pages (about, contact)
Total entry points: 24
```

---

## Phase 4: Reliability (fallback маскирует ошибки)

### 4.1 Honest Fallback — показывать ошибку, не маскировать
**Файл:** `cartographer.ts`, `strategist.ts`, `sentinel.ts`

Если AI call failed:
- Emit WebSocket event `agent_error` с описанием (не молча)
- Sentinel fallback: `continueExploring: coverageScore < 75` (не always false)
- Cartographer fallback: собирать entry points из DOM (buttons, forms, links) вместо пустого результата
- НЕ показывать "100% coverage" когда AI unavailable

### 4.2 Retry с Backoff для AI Calls
**Файл:** все agents

Если 429 rate limit → wait 3s → retry 1 раз. Сейчас — сразу fallback.

### 4.3 Budget Atomic Deduction
**Файл:** `flow-runner.ts`

Deduct budget ПЕРЕД стартом flow, не после. Иначе 5 concurrent flows все проходят budget check одновременно.

### 4.4 Login Mutex
**Файл:** `flow-runner.ts`

Concurrent flows не должны логиниться одновременно. Добавить promise-based mutex:
```typescript
private loginPromise: Promise<void> | null = null;

async ensureLogin(context) {
  if (this.loginPromise) return this.loginPromise;
  this.loginPromise = this.performLogin(context);
  return this.loginPromise;
}
```

---

## Phase 5: Frontend Polish

### 5.1 i18n — все exploration тексты
Проверить что все hardcoded строки заменены на `t('exploration.*')`.

### 5.2 Empty State при AI Failure
Если exploration завершился с 0 results и были AI errors → показывать:
"Exploration не смог проанализировать сайт. Проверьте подключение к AI."

Не "100% coverage, 0 pages".

### 5.3 History Item → Open Results
Клик по завершённому exploration в History → открывать ExplorationResults (через HTTP fallback endpoint).

---

## Порядок реализации

1. **Phase 1** (контекст) — 1.1, 1.2, 1.3, 1.4
2. **Phase 4.1** (honest fallback) — без этого тестирование бесполезно
3. **Phase 2** (data flow) — 2.1, 2.2, 2.3, 2.4
4. **Phase 3** (quality) — 3.1, 3.2, 3.3, 3.4
5. **Phase 4** (reliability) — 4.2, 4.3, 4.4
6. **Phase 5** (frontend) — 5.1, 5.2, 5.3

## Что НЕ менять
- 4-фазная архитектура — правильная
- BFS для survey — правильный подход
- TestPipeline reuse — правильно (DRY)
- JSONL tracing — правильно
- Shared Blackboard — правильно
