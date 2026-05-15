# Mobile Test Orchestration — Implementation Plan

> Статус: draft v1 после обсуждения с командой
> Scope: Android mobile tests (iOS — отдельный трек)
> Связанные документы: [mobile-test-orchestration-design.html](mobile-test-orchestration-design.html) — design exploration

---

## TL;DR

Идём короткой итерацией. Никаких новых таблиц, никаких новых абстракций. Используем то что уже работает в коде + добавляем три точечные вещи: UX для existing scenarios, AI fingerprint cache, опциональный sequence flag. Параллелизм — после фикса race в runner.

**Что НЕ делаем:**
- ❌ Hybrid Test Suite с новой таблицей `test_suites` (overkill, 5-7 недель)
- ❌ Sequential chain без scenarios (cascade failure)
- ❌ User-authored validate steps (заменяется AI fingerprint)
- ❌ Autoscaling эмуляторов сейчас (нет данных + race condition блокирует)
- ❌ State snapshot через `adb backup` (тупик на iOS, медленно)
- ❌ Изменения в web-flow (`TestSuitesWeb.jsx` не трогаем)

---

## Контекст что уже работает

| Что | Где | Готовность |
|---|---|---|
| Backend `scenario_setup` adapter | `src/services/test-resource/adapters/scenario_setup.adapter.ts` | ✅ 100% |
| Recursive `use_setup` expansion | `src/services/test-resource/runtime/scenario-setup-expander.ts` | ✅ 100% |
| Mobile compiler prepends scenario steps | `src/services/test-resource/resource-step-compiler.service.ts:258-271` | ✅ 100% |
| `enrichBindingsWithDefaults` (test creation) | `src/services/test-resource/test-resource.service.ts:1327-1369` | ✅ 100% |
| `RunAsSplitButton` смонтирован в TestSuitesMobile | `apps/web/src/components/Home/TestSuitesMobile.jsx:13249` | ⚠️ Без `onManageSetups` |
| `RunAsSplitButton` сам поддерживает scenario picker | `apps/web/src/components/Home/RunAsSplitButton.jsx:493-545` | ✅ 100% |
| Embeddings pipeline | `src/services/ai/embeddings/` | ✅ 100% (для других целей) |
| `executed_resources` audit JSONB | `test_executions.executed_resources` column | ✅ 100% |
| `MAX_MOBILE_IN_FLIGHT` дефолт 1 | `src/services/testing/regression/regression-run.service.ts:2088-2091` | ✅ 100% (serial) |

**Главная проблема:** на пустом проекте у юзера нет точки входа для создания первого scenario (`onManageSetups` callback не передан в RunAsSplitButton). См. Phase 0.

---

## Фазы — порядок и причины

| Phase | Что | Срок | Зависит от | Команда |
|---|---|---|---|---|
| 0 | Mount `onManageSetups` + Setup Management Dialog | 2-3 дня | — | Frontend |
| 1 | UI: inline preview + extract + переименование Setup→Scenario | 1.5-2 недели | Phase 0 | Frontend |
| 2 | Telemetry: regression duration + idle time + cold-start rate | 1 неделя | — (параллельно) | Backend |
| 3 | Runner race fix (`MAX_IN_FLIGHT=2` стабильно) | 1-2 недели | — (параллельно, отдельная команда) | DevOps + Runner |
| 4 | Dynamic `MAX_IN_FLIGHT` cap по testCount | 2-3 дня | Phase 3 | Backend |
| 5 | AI screen fingerprint cache для scenario skip | 2-3 недели | Phase 1 | Backend + минимум Frontend |
| 6 | `sequence_group` flag (опционально, по telemetry) | 3-5 дней | Phase 2 (данные) | Backend + Frontend |
| 7+ | Burst pool / autoscale VM | conditional | Phase 2 + Phase 4 | DevOps |

**Можно параллелить:**
- Phase 0 → 1 (Frontend, последовательно)
- Phase 2 (Backend, фон)
- Phase 3 (DevOps, отдельный трек)

---

## Phase 0 — Mount `onManageSetups` (2-3 дня, Frontend)

### Зачем

Без этого на пустом проекте юзер не может создать первый scenario. RunAsSplitButton дропдаун покажет только Login и Environment, секцию Scenario не рендерит (`RunAsSplitButton.jsx:501` — `filteredSetups.length > 0 || !!onManageSetups`).

### Что делаем

**Файл:** `apps/web/src/components/Home/TestSuitesMobile.jsx:13249`

Передать `onManageSetups` callback:
```jsx
<RunAsSplitButton
  ...existing props...
  onManageSetups={() => setIsScenarioManagementOpen(true)}
/>
```

**Создать:** `apps/web/src/components/Home/MobileScenarioManagementDialog.jsx`

Минимальный компонент:
- List scenarios for current project + platform
- Each row: name, step count, "Edit" button, "Delete" button, "Set as default" toggle
- "+ New Scenario" button → закрывает диалог + открывает main editor в setup mode (`openEditorForSetup(null)`)
- Pattern reuse: посмотреть `SetupBlocksSection.jsx` (файл существует, был отключён в `/repository` — забрать оттуда list/delete логику)

**Service calls** (все существуют):
- `testResourceService.listByProject(projectId, { kind: 'scenario_setup', platform })`
- `testResourceService.remove(id, { reassignTo })`
- `testResourceService.setDefault({ workspaceId, projectId, kind, resourceId })`

### Verification

```bash
cd /Users/yerassylospanov/Desktop/qai-frontend/apps/web
npx eslint src/components/Home/TestSuitesMobile.jsx src/components/Home/MobileScenarioManagementDialog.jsx
```

Manual: на свежем проекте без scenarios — открыть test → caret menu → видна кнопка "Manage scenarios..." → клик → диалог → "+ New" → main editor в setup mode.

### Что НЕ делаем

- Не возвращаем `SetupBlocksSection` в tree `/repository` (убрали осознанно)
- Не строим отдельную `/scenarios` page

---

## Phase 1 — UI: inline preview + extract + переименование (1.5-2 недели, Frontend)

### Зачем

Юзер должен:
1. Видеть **что именно произойдёт перед его тестом** (mental model "первый/последний шаг" из обсуждения)
2. Уметь **извлечь** общий префикс из теста в новый scenario без копипасты
3. Не натыкаться на технический термин "Setup"

### Подфазы

#### 1.1 Переименование "Setup" → "Scenario" в UI (1 день)

**Только UI-строки**, backend не трогаем (`kind: scenario_setup` остаётся).

Файлы:
- `apps/web/src/i18n/locales/en.js` — все ключи в `testResources.scenarioSetup.*` обновить labels
- `apps/web/src/i18n/locales/ru.js` — то же, "Сценарий"
- `apps/web/src/i18n/locales/kk.js` — то же

**НЕ трогаем:**
- Имена JS/TS типов и переменных (`scenario_setup`, `setupBinding` — внутренние)
- DB schema
- API endpoints

**Verification:** grep по всем `t("testResources.scenarioSetup.*")` — все строки display'ятся как "Scenario" (en) / "Сценарий" (ru).

#### 1.2 Inline preview scenario в редакторе теста (4-5 дней)

**Файл:** `apps/web/src/components/Home/TestSuitesMobile.jsx`

Над первым шагом теста добавить collapsible панель:

```
┌─────────────────────────────────────────────────────┐
│ 📍 Starting state                                   │
│ ▸ Scenario "logged-in"  · 4 steps  · used by 12     │
│   tests · [Edit scenario]                           │
└─────────────────────────────────────────────────────┘
   (раскрывается на клик)
   ▾ Scenario "logged-in"  · 4 steps
     │ — Steps that play before this test —
     │ 1. tap "Login"
     │ 2. type email {{user.email}}
     │ 3. type password ********
     │ 4. tap "Submit"
     │
     │ — Validate (skip if state reached, AI-driven) —
     │ ⚙ Compared by screenshot fingerprint (Phase 5)
```

**Источник данных:**
- Из `editorResourceBindings` берём `scenario_setup` binding (уже загружается в state)
- По `binding.resource_id` подгрузить scenario через `testResourceService.get(id)` (новый или существующий endpoint, проверить)
- Cache локально, инвалидировать при `updateResourceBindings`

**Edge cases:**
- Несколько scenarios прибиндено (рекурсивный `use_setup`) — показать как дерево
- Scenario удалён но binding остался — показать warning "Scenario not found"
- Тест не сохранён (нет `intentTestCaseId`) — скрыть панель полностью

#### 1.3 Extract from test (3-4 дня)

В редакторе теста — кнопка "Extract first N steps to scenario":
- Юзер выделяет range шагов (drag в step list)
- Кнопка появляется в toolbar когда выделение существует
- Клик → модалка: имя scenario + preview выделенных шагов
- Подтверждение → backend создаёт scenario, удаляет выделенные шаги из теста, добавляет `resource_bindings: [{ kind: scenario_setup, resource_id: newId }]`

**Backend endpoint:**
- Проверить — есть ли `POST /test-resources` который принимает уже-готовые шаги
- Если нет — добавить тонкий wrapper в `src/api/test-resource/test-resource.controller.ts`

**Edge cases:**
- Выделение содержит шаги с `{{...}}` placeholders из других scenarios — нужна валидация на backend
- Выделение не contiguous (юзер выделил шаги 1, 3, 5) — запретить, только сплошной range

#### 1.4 ResourceBadges на test card (1 день)

Уже работает — проверить что после Phase 1.2/1.3 имя scenario обновляется live на карточке теста в дереве.

### Verification

- E2E: создать тест → extract → проверить что scenario создан + binding обновлён + preview панель показывает извлечённый scenario
- Manual: проверить что в i18n строках везде "Scenario" / "Сценарий"

---

## Phase 2 — Telemetry (1 неделя, Backend, параллельно)

### Зачем

Решения про autoscaling, sequence_group, AI fingerprint cache priority — все требуют данных. Сейчас мы оптимизируем на гипотезах.

### Scope clarification

- **Mobile-first**: новые колонки nullable. Mobile job заполняет; web/API jobs оставляют NULL до отдельного трека. Это документируется в migration comments.
- **No new endpoint в Phase 2**: данные пишем в БД, дашборд — ad-hoc SQL. Endpoint вынесен в "Phase 2.5 (optional)" ниже, делаем только если команда явно попросит.
- **Mobile job уже самый болевой**: web регрессии быстрые (storageState), их telemetry дешевле и менее критично.

### Точки замера (с file:line)

| Метрика | Где замерять | Источник данных |
|---|---|---|
| `app_setup_ms` | wrap-around `mobile-test-run.job.ts:471` `MobileAppPrepService.prepApp()` | `performance.now()` до/после |
| `scenario_steps_ms` | sum of `MobileStepResult.durationMs` для первых `compileResult.steps.length` шагов в `MobileRunStepsResponse.steps[]` | runner per-step timing |
| `test_steps_ms` | sum of `MobileStepResult.durationMs` для **остальных** шагов | runner per-step timing |
| `cold_start_used` | `sessionSource === 'cold'` в `mobile-test-run.job.ts:373` | local var |
| `session_claim_ms` | wrap-around try-pool→try-warmup→cold ladder (`mobile-test-run.job.ts:327-380`) | `performance.now()` до/после ladder |
| `scenario_step_count` | `compileResult.steps.length` | compile result |
| `test_step_count` | `intentSteps.length - compileResult.steps.length` | derive |
| `total_duration_ms` (regression_runs) | `completed_at - started_at` уже доступно, посчитаем при aggregation | DB |
| `total_app_setup_ms` (regression_runs) | SUM of `app_setup_ms` over `test_executions` of run | aggregation query |
| `total_scenario_ms` / `total_test_steps_ms` / `cold_start_count` | аналогично | aggregation query |
| `test_count` | COUNT of `test_executions` for run | aggregation query |

### Migration spec

**Файл:** `supabase-migrations/20260516_mobile_telemetry.sql`

```sql
-- ============================================================================
-- Phase 2: Mobile Regression Telemetry
-- ============================================================================
-- Purpose: Capture per-test and per-run wallclock breakdowns so we can
-- make data-driven decisions about parallelism (Phase 4), scenario
-- caching (Phase 5), and infrastructure scaling (Phase 7+).
--
-- All columns are NULLABLE on purpose:
--   - Web/API jobs leave them NULL (mobile-only telemetry in Phase 2).
--   - Legacy rows pre-migration are NULL.
--   - Reading code MUST coalesce(col, 0) or treat NULL as "unknown".
--
-- No DEFAULT 0 because "0 ms" is semantically distinct from "we don't
-- know" — aggregation queries must distinguish.
-- ============================================================================

-- ── test_executions: per-test breakdown ──────────────────────────────
ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS app_setup_ms      INTEGER NULL,
  ADD COLUMN IF NOT EXISTS scenario_steps_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS test_steps_ms    INTEGER NULL,
  ADD COLUMN IF NOT EXISTS session_claim_ms  INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cold_start_used   BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS scenario_step_count INTEGER NULL,
  ADD COLUMN IF NOT EXISTS test_step_count   INTEGER NULL;

COMMENT ON COLUMN test_executions.app_setup_ms IS
  'Phase 2 telemetry: pm clear + relaunch + APK install wallclock. NULL for non-mobile jobs.';
COMMENT ON COLUMN test_executions.scenario_steps_ms IS
  'Phase 2 telemetry: sum of MobileStepResult.durationMs for prepended scenario_setup steps. NULL if no scenario binding or non-mobile.';
COMMENT ON COLUMN test_executions.test_steps_ms IS
  'Phase 2 telemetry: sum of MobileStepResult.durationMs for user-authored test steps (everything after the scenario prefix). NULL for non-mobile.';
COMMENT ON COLUMN test_executions.session_claim_ms IS
  'Phase 2 telemetry: wallclock of the pool→warmup→cold claim ladder. Includes cold-start boot if it fell through. NULL for non-mobile.';
COMMENT ON COLUMN test_executions.cold_start_used IS
  'Phase 2 telemetry: TRUE if sessionSource === "cold" (no pool, no warmup). NULL for non-mobile.';
COMMENT ON COLUMN test_executions.scenario_step_count IS
  'Phase 2 telemetry: number of scenario steps prepended (= compileResult.steps.length). NULL for non-mobile or no scenario.';
COMMENT ON COLUMN test_executions.test_step_count IS
  'Phase 2 telemetry: number of user-authored test steps. NULL for non-mobile.';

-- Index for time-range queries (the most common admin-metrics use case).
-- WHERE clause keeps the index small — only mobile rows have these values.
CREATE INDEX IF NOT EXISTS idx_test_executions_telemetry_completed_at
  ON test_executions (completed_at DESC)
  WHERE app_setup_ms IS NOT NULL;

-- ── regression_runs: per-run aggregates ──────────────────────────────
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS test_count           INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_duration_ms    INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_app_setup_ms   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_scenario_ms    INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_test_steps_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cold_start_count     INTEGER NULL;

COMMENT ON COLUMN regression_runs.test_count IS
  'Phase 2 telemetry: COUNT of test_executions rows in this run.';
COMMENT ON COLUMN regression_runs.total_duration_ms IS
  'Phase 2 telemetry: completed_at - started_at in ms. Includes queueing.';
COMMENT ON COLUMN regression_runs.total_app_setup_ms IS
  'Phase 2 telemetry: SUM of test_executions.app_setup_ms for this run.';
COMMENT ON COLUMN regression_runs.total_scenario_ms IS
  'Phase 2 telemetry: SUM of test_executions.scenario_steps_ms for this run.';
COMMENT ON COLUMN regression_runs.total_test_steps_ms IS
  'Phase 2 telemetry: SUM of test_executions.test_steps_ms for this run.';
COMMENT ON COLUMN regression_runs.cold_start_count IS
  'Phase 2 telemetry: COUNT of test_executions with cold_start_used = TRUE.';

CREATE INDEX IF NOT EXISTS idx_regression_runs_completed_at_telemetry
  ON regression_runs (completed_at DESC)
  WHERE total_duration_ms IS NOT NULL;
```

**Backfill**: skip. Leave NULL for legacy rows. Aggregation queries `coalesce` or filter `WHERE total_duration_ms IS NOT NULL`.

**Rollout order**: migration first (additive, safe), then code. Old code ignores new columns; new code on old DB fails open (`logger.warn` + skip writes).

### Implementation — per-test capture

**File:** `src/jobs/mobile-test-run.job.ts`

#### 1. Top of handler (~line 213, near existing `sessionSource`)

```typescript
// Phase 2 telemetry — per-test wallclock. All defaults to null/0 so a
// failure path that exits early still writes a well-formed row. We
// commit these into test_executions in the existing finally block at
// :1491 (next to executed_resources persistence).
const tlm: {
  sessionClaimMs: number | null;
  appSetupMs: number | null;
  scenarioStepsMs: number | null;
  testStepsMs: number | null;
  coldStartUsed: boolean | null;
  scenarioStepCount: number | null;
  testStepCount: number | null;
} = {
  sessionClaimMs: null,
  appSetupMs: null,
  scenarioStepsMs: null,
  testStepsMs: null,
  coldStartUsed: null,
  scenarioStepCount: null,
  testStepCount: null,
};
```

#### 2. Wrap session claim ladder (`:327-380`)

```typescript
const sessionClaimT0 = performance.now();
try {
  // ... existing pool / warmup / cold ladder unchanged ...
} finally {
  tlm.sessionClaimMs = Math.round(performance.now() - sessionClaimT0);
  tlm.coldStartUsed = sessionSource === 'cold';
}
```

#### 3. Wrap prepApp (`:471`)

```typescript
const appSetupT0 = performance.now();
await MobileAppPrepService.prepApp({ /* existing args */ });
tlm.appSetupMs = Math.round(performance.now() - appSetupT0);
```

#### 4. After scenario compile (`:241`) — record counts before runSteps

```typescript
tlm.scenarioStepCount = compileResult.steps.length;
tlm.testStepCount = intentSteps.length - compileResult.steps.length;
```

#### 5. After runSteps returns — slice per-step durations

```typescript
const stepResults = runResult.steps || []; // MobileStepResult[]
const scenarioN = tlm.scenarioStepCount ?? 0;
tlm.scenarioStepsMs = sumStepDurations(stepResults.slice(0, scenarioN));
tlm.testStepsMs = sumStepDurations(stepResults.slice(scenarioN));

// helper at file bottom (or extract to mobile-test-run.helpers.ts):
function sumStepDurations(steps: MobileStepResult[]): number {
  return steps.reduce((acc, s) => acc + (typeof s.durationMs === 'number' ? s.durationMs : 0), 0);
}
```

#### 6. Write into test_executions (finally block ~:1491, next to `executed_resources`)

```typescript
// Phase 2: persist telemetry. Best-effort: any failure here MUST NOT
// fail the test (logger.warn + swallow). Job retry will re-emit.
try {
  await supabaseAdmin
    .from('test_executions')
    .update({
      app_setup_ms: tlm.appSetupMs,
      scenario_steps_ms: tlm.scenarioStepsMs,
      test_steps_ms: tlm.testStepsMs,
      session_claim_ms: tlm.sessionClaimMs,
      cold_start_used: tlm.coldStartUsed,
      scenario_step_count: tlm.scenarioStepCount,
      test_step_count: tlm.testStepCount,
    })
    .eq('id', testExecutionId);
} catch (err) {
  logger.warn('[MOBILE-TEST] Failed to persist telemetry — non-fatal', {
    testId, error: err instanceof Error ? err.message : String(err),
  });
}
```

**Retry semantics**: each attempt overwrites with the latest attempt's numbers. BullMQ delivers max 1 attempt currently (mobile-test-run.job: see config). If retries change — document the implication explicitly.

### Implementation — per-run aggregation

**File:** `src/services/testing/results/test-completion-handler.service.ts`

**Point:** inside `recomputeRunStatus()` at `:937` — RIGHT BEFORE the `.update({...})` call. This is the **single funnel** where every regression run is finalized — no other place sets `regression_runs.status = 'completed' | 'failed' | 'cancelled'`.

```typescript
// Phase 2 telemetry: aggregate per-test rows into per-run totals.
// We already have unifiedExecutions in scope (loaded above).
// All sums coalesce NULL → 0 so non-mobile rows just don't contribute.
//
// Why here and not in mobile-test-run.job:
//   - this handler runs for EVERY platform (web/mobile/api) so the
//     code path is reused
//   - it's the only ordering-safe point — finalisation is already
//     guarded by optimistic-lock `.in('status', ['running','pending'])`
const startedAtMs = run.started_at ? new Date(run.started_at).getTime() : null;
const completedAtMs = Date.now();
const totalDurationMs = startedAtMs ? Math.max(completedAtMs - startedAtMs, 0) : null;

// Re-fetch executions WITH telemetry columns (the earlier query at
// :840 only selects id/status/error_message/created_at to keep that
// hot path lean).
const { data: telemetryRows } = await supabaseAdmin
  .from('test_executions')
  .select('app_setup_ms, scenario_steps_ms, test_steps_ms, cold_start_used')
  .eq('run_id', run.id);

const tlmRows = telemetryRows ?? [];
const sumOrNull = (key: keyof typeof tlmRows[number]) => {
  const present = tlmRows.filter((r) => r[key] != null);
  if (present.length === 0) return null;          // pure-web run → leave NULL
  return present.reduce((acc, r) => acc + (r[key] as number), 0);
};

const aggregateUpdate = {
  test_count: tlmRows.length || null,
  total_duration_ms: totalDurationMs,
  total_app_setup_ms: sumOrNull('app_setup_ms'),
  total_scenario_ms: sumOrNull('scenario_steps_ms'),
  total_test_steps_ms: sumOrNull('test_steps_ms'),
  cold_start_count: tlmRows.filter((r) => r.cold_start_used === true).length || null,
};

// Merge into the existing .update payload at :937.
// (No separate UPDATE — single statement to avoid race with summary update.)
const { data: updatedRun, error: updateError } = await supabaseAdmin
  .from('regression_runs')
  .update({
    status: persistedStatus,
    summary,
    completed_at: new Date().toISOString(),
    ...aggregateUpdate,                            // ← Phase 2 additions
  })
  .eq('id', run.id)
  .in('status', ['running', 'pending'])
  .select('id')
  .maybeSingle();
```

**Idempotency**: optimistic-lock on `.in('status', ['running','pending'])` already prevents double-write. If a second completion handler races in, it's no-op'd by the lock — our telemetry doesn't double-count.

### Anti-goals (explicit)

- **No dashboard UI in Phase 2.** Data lives in DB. Team uses ad-hoc SQL.
- **No web/API instrumentation.** Web jobs leave the new columns NULL.
- **No new endpoint.** See Phase 2.5 below.
- **No backfill.** Pre-migration rows stay NULL forever.
- **No per-step persistence.** We aggregate at job level; per-step `MobileStepResult.durationMs` already exists in `executed_resources` shape if needed for forensics.

### Phase 2.5 (optional) — `/admin/regression-metrics` endpoint

**Only build if team asks.** Spec sketch:

- Route: `GET /admin/regression-metrics`
- Auth: existing admin middleware (`src/middleware/admin.ts` if exists; else **don't** build a new auth model in Phase 2.5 — defer to dedicated auth task)
- Query params: `from`, `to` (ISO dates), `bucket=daily|weekly`
- Response shape:
  ```json
  {
    "rangeFrom": "2026-05-01",
    "rangeTo":   "2026-05-15",
    "buckets": [
      { "date": "2026-05-14", "test_count_p50": 8, "test_count_p95": 35,
        "duration_p50_ms": 240000, "duration_p95_ms": 1450000,
        "cold_start_rate": 0.18 }
    ]
  }
  ```
- Cache: 60s in-memory or Redis (data is hourly-grade, not real-time)
- Rate limit: per-user 60/min (it's admin-only, low traffic)

### Tests

**File:** `src/jobs/__tests__/mobile-test-run-telemetry.test.ts` (new)

Cases:
1. Successful run with scenario → all timing fields populated, sum invariants hold (`scenario_steps_ms + test_steps_ms` ≈ runner-reported `durationMs`)
2. Successful run WITHOUT scenario → `scenario_steps_ms = 0`, `scenario_step_count = 0`, `test_steps_ms > 0`
3. prepApp throws → `app_setup_ms = null` (no false zero), test fails as expected
4. Telemetry DB write throws → job completes normally (warn logged, no throw)
5. Cold-start path → `cold_start_used = true`, `session_claim_ms > 0`
6. `sumStepDurations` unit: missing/non-number durations gracefully coalesce to 0

**File:** `src/services/testing/results/__tests__/test-completion-handler-aggregation.test.ts` (new or extend existing)

Cases:
1. Run with 3 mobile tests → all 6 aggregate columns populated, equal SUMs
2. Mixed mobile + web run → mobile sums correct, web rows ignored (NULL skipped)
3. Pure-web run → `test_count` populated, all `total_*_ms` columns NULL (sumOrNull semantics)
4. Race condition: two handlers complete same run → optimistic lock blocks second, no double-aggregate
5. Empty run (zero test_executions) → `test_count = null`, all aggregates NULL

### Documentation updates (mandatory same-PR)

1. **Root CLAUDE.md**: add row to `src/jobs/` line in the "Top-level map" table noting Phase 2 telemetry instrumentation. Append "Phase 2 telemetry" to the recent-baselines section.
2. **`src/jobs/` CLAUDE.md** (create if missing — folder has > 8 files, qualifies per folder-structure rule): include lifecycle of `mobile-test-run.job` with telemetry capture points.
3. **`src/services/test-resource/CLAUDE.md`** invariants list: add "Telemetry writes are best-effort — never throw from the test path." Reuses existing CLAUDE.md style.
4. **Memory:** add a 1-line entry pointing to a new `memory/phase_2_telemetry.md` with the column-list and rollout date.

### Code-quality rules to honour during implementation

Pulled from `.claude/rules/*` — applied to Phase 2 specifically:

- **No N+1**: aggregation query loads `test_executions` once per run (already done by existing `recomputeRunStatus`; we just `select` additional columns). DO NOT loop over executions and re-query per row.
- **Field verification**: every new column referenced in code MUST exist in `supabase-migrations/`. Migration ships in same PR as code.
- **Pre-commit**:
  ```bash
  npm run type-check
  npm run lint
  npx jest --testPathPattern="mobile-test-run-telemetry|test-completion-handler-aggregation" --no-coverage
  ```
- **No silent throws**: every catch around telemetry MUST `logger.warn` with structured context (`testId`, `runId`, error message).
- **No emoji in code/files** (per general.md).
- **Don't reformat unrelated lines** in `test-completion-handler.service.ts` or `mobile-test-run.job.ts` — surgical edits only.
- **DRY**: `sumStepDurations` lives once — either as a method inside `mobile-test-run.job.ts` (file-local) or extract to `src/jobs/helpers/telemetry.ts` if a second consumer materialises.

### Risk Analysis (Phase 2 specific)

| Risk | Mitigation |
|---|---|
| Telemetry DB write fails → job fails | All persistence wrapped in try/catch + `logger.warn`. **Never throws out of telemetry block.** |
| Wrong scenario/test split (e.g. scenario expander injects extra steps) | We use `compileResult.steps.length` AS RETURNED by the compiler — same source of truth as the prepend. If compiler changes shape, both `intentSteps` prepend and telemetry split move together. |
| `MobileStepResult.durationMs` missing on some runner versions | `sumStepDurations` coalesces missing → 0. Aggregate may underestimate; better than NaN. |
| Aggregation runs BEFORE all per-test rows landed | Existing `recomputeRunStatus` already handles "stuck" detection at `:853`. Our aggregation runs **after** that check — by then all rows are final. |
| Migration runs on running prod → ADD COLUMN locks | `ADD COLUMN ... NULL` in Postgres is metadata-only (instant). Safe to apply during prod traffic. |
| New columns leak PII | None of these columns hold strings or step content. Pure numeric/boolean. No leak. |
| `performance.now()` not available in node | Available since Node 8.5. Our Node version is 18+. Safe. |

### Verification (post-deploy)

1. Open prod DB:
   ```sql
   SELECT
     percentile_cont(0.50) WITHIN GROUP (ORDER BY total_duration_ms) AS p50_ms,
     percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms) AS p95_ms,
     AVG(cold_start_count::float / NULLIF(test_count,0)) AS cold_start_rate
   FROM regression_runs
   WHERE total_duration_ms IS NOT NULL
     AND completed_at > NOW() - INTERVAL '7 days';
   ```
2. Spot-check a single run:
   ```sql
   SELECT test_count, total_duration_ms, total_app_setup_ms,
          total_scenario_ms, total_test_steps_ms, cold_start_count
   FROM regression_runs
   WHERE id = '<some-run-id>';
   ```
   - `total_app_setup_ms + total_scenario_ms + total_test_steps_ms` should be **≤** `total_duration_ms` (difference = pool waits, queueing, network overhead). If it's GREATER — investigate.
3. After 2 weeks of data → revisit Phase 4/5/7 priorities based on real distribution.

---

## Phase 3 — Runner race fix (1-2 недели, DevOps + qait-mobile-runner)

### Зачем

Главный блокер для всего параллелизма. `MAX_IN_FLIGHT=2` сейчас роняет регрессии (см. комментарий в `regression-run.service.ts:2078-2087`).

### Где НЕ в этом репо

Этот трек **в `qait-mobile-runner`**, не `qai-backend`. Backend трогать не надо.

### Что предположительно фиксить

(По комментариям в коде backend'а — точная диагностика на стороне DevOps)

1. **Host ADB mutex** — сериализовать `pm`/`adb forward` команды между сессиями. Host ADB v28 single-threaded.
2. **Health-check перед claim** — `claimSession` должен убедиться что redroid реально готов к multi-user (текущий fail mode: `pm create-user failed: (no output)`)
3. **Upgrade host ADB v28 → v34+** — известно нестабилен с redroid 15
4. **Возможно: per-session ADB instance** вместо shared (radical fix, отдельный спринт)

### Verification

Stress test: запустить 10 регрессий по 20 тестов на проде с `MAX_IN_FLIGHT=2`. **0%** failures с причиной "Client aborted" / "socket dropped" / "pm create-user failed".

### Exit criteria

Когда стабильно — поднять `REGRESSION_MOBILE_MAX_CONCURRENCY=2` в prod env. Это unblock'ает Phase 4.

---

## Phase 4 — Dynamic `MAX_IN_FLIGHT` cap (2-3 дня, Backend)

> **Re-actualised May 2026** after Phase 2 (telemetry) + Phase 3 (host-ADB mutex) shipped. Replaces earlier draft (incorrect endpoint name, wrong PoolHealth shape, missed dead-method discovery).

### Prerequisites — verify before starting

This phase is **blocked** until DevOps confirms:

1. ✅ Phase 3 host-ADB mutex deployed to prod (branch `fix/host-adb-mutex` in `qait-mobile-runner` shipped)
2. ✅ Stress-tested `REGRESSION_MOBILE_MAX_CONCURRENCY=2` for 7 days with 0% `Client aborted` / `pm create-user failed` errors
3. ✅ (Optional) `POOL_CLAIM_READINESS_PROBE=true` enabled on prod runner

**If any are missing**: ship Phase 4 anyway but keep `envCap=1` in prod env. The code is harmless when capped at 1 (decision function returns 1 in serial mode).

### Зачем

Сейчас `MAX_MOBILE_IN_FLIGHT` парсится из `REGRESSION_MOBILE_MAX_CONCURRENCY` env var (`regression-run.service.ts:2088-2091`) **один раз** на регрессию. Это slow-rolling tunable:
- Под-нагрузка → operator вручную поднимает env → wait restart
- Над-нагрузка (pool exhausted, cold-starts) → нет автоматического back-off
- Маленькая регрессия (1 тест) → всё равно платит pool claim overhead

Phase 4 = заменить static parse на функцию которая учитывает: (a) operator's env cap (hard ceiling), (b) real-time pool capacity from runner, (c) test count.

### Что точно есть в коде (recon done May 14 2026)

| Что | Где | Состояние |
|---|---|---|
| Current cap calculation | `regression-run.service.ts:2088-2091` | `Math.max(1, parseInt(env, 10))` — static, no runtime input |
| In-flight gate | `regression-run.service.ts:2362` | `if (inFlight.size >= MAX_MOBILE_IN_FLIGHT) await Promise.race(inFlight)` |
| Runner client method | `mobile-runner-client.ts:162-170` | `getCapacity()` defined — **but never called anywhere** (dead method); returns full `PoolCapacity` shape |
| Runner endpoint | `qait-mobile-runner/src/api/routes/session.routes.ts:277` | `GET /api/sessions/capacity` — alive, returns `{ pool: { android: {total,idle,busy,resetting,broken}, ios: {...} } | null, adhoc: {...}, mode: 'pool'|'classic' }` |
| Phase 3 readiness probe | `qait-mobile-runner/src/runner/session-pool.ts:295` | `verifyReadiness()` — opt-in via `POOL_CLAIM_READINESS_PROBE`; affects how "idle" sessions behave at claim time but NOT the capacity counts |
| Phase 2 telemetry | `regression_runs.cold_start_count` / `test_executions.cold_start_used` | Available for **historical** decisions but not needed for Phase 4 MVP |

### Что меняется

**File:** `src/services/testing/regression/regression-run.service.ts`

#### 1. Replace line `2088-2091`

```typescript
const MAX_MOBILE_IN_FLIGHT = Math.max(
  1,
  parseInt(process.env.REGRESSION_MOBILE_MAX_CONCURRENCY || '1', 10),
);
```

with an `await`'d call to a new module-level decision function:

```typescript
const MAX_MOBILE_IN_FLIGHT = await decideMaxMobileInFlight({
  testCount: countMobileTests(levels),    // helper — sum mobile tests across all levels
  platform: dominantMobilePlatform(levels), // 'android' | 'ios' | 'mixed'
  runnerClient: mobileRunnerClient,
});
logger.info('[REGRESSION_RUN] Mobile concurrency decided', {
  runId, decided: MAX_MOBILE_IN_FLIGHT, /* + reason from decideMaxMobileInFlight */,
});
```

#### 2. New helper `decideMaxMobileInFlight`

**File:** `src/services/testing/regression/concurrency-decision.ts` (new — keep separate for testability without dragging in the full regression service)

```typescript
export interface ConcurrencyInput {
  testCount: number;
  platform: 'android' | 'ios' | 'mixed';
  runnerClient: MobileRunnerClient;
}

export interface ConcurrencyDecision {
  cap: number;
  reason: string;
  inputs: { envCap: number; poolIdle: number | null; testCount: number; platform: string };
}

export async function decideMaxMobileInFlight(input: ConcurrencyInput): Promise<ConcurrencyDecision> {
  const envCap = Math.max(1, parseInt(process.env.REGRESSION_MOBILE_MAX_CONCURRENCY || '1', 10));

  // Hard ceiling — operator's word is final.
  if (envCap <= 1) return mk(1, 'env-cap=1 (operator force-serial)', envCap, null, input);

  // Single test — overhead of parallelism is wasted.
  if (input.testCount <= 1) return mk(1, 'testCount<=1', envCap, null, input);

  // iOS-only regression — POOL_IOS_SIZE=0 in prod, no parallelism gains.
  if (input.platform === 'ios') return mk(1, 'platform=ios (no pool capacity)', envCap, null, input);

  // Probe runner for real-time capacity. 5s timeout (matches existing
  // getCapacity client timeout). On failure: fail SAFE — serial.
  let poolIdle: number | null = null;
  try {
    const cap = await input.runnerClient.getCapacity();
    if (cap?.pool?.android) {
      // For 'mixed' regressions we still cap by android pool — iOS
      // sessions cold-start regardless (no pool), so the bottleneck
      // is the android side.
      poolIdle = cap.pool.android.idle;
    }
  } catch (err) {
    logger.warn('[REGRESSION_RUN] getCapacity failed; falling back to serial', {
      error: err instanceof Error ? err.message : String(err),
    });
    return mk(1, 'getCapacity-failed', envCap, null, input);
  }

  if (poolIdle === null) {
    return mk(1, 'pool-disabled (runner in classic mode)', envCap, null, input);
  }
  if (poolIdle < 2) {
    return mk(1, `poolIdle=${poolIdle} (need >=2 for parallelism)`, envCap, poolIdle, input);
  }

  // Choose the cap. Tunable constants live behind env vars so DevOps
  // can adjust without a redeploy. Defaults match earlier draft:
  //   testCount 2-5  → up to 2
  //   testCount 6+   → up to 3
  const smallBatch = parseInt(process.env.REGRESSION_MOBILE_SMALL_BATCH_THRESHOLD || '5', 10);
  const smallCap   = parseInt(process.env.REGRESSION_MOBILE_SMALL_CAP || '2', 10);
  const largeCap   = parseInt(process.env.REGRESSION_MOBILE_LARGE_CAP || '3', 10);

  const desired = input.testCount <= smallBatch ? smallCap : largeCap;
  const cap = Math.min(envCap, poolIdle, desired);
  return mk(cap, `chosen min(envCap=${envCap}, poolIdle=${poolIdle}, desired=${desired})`, envCap, poolIdle, input);
}

function mk(cap: number, reason: string, envCap: number, poolIdle: number | null, input: ConcurrencyInput): ConcurrencyDecision {
  return { cap, reason, inputs: { envCap, poolIdle, testCount: input.testCount, platform: input.platform } };
}
```

#### 3. Two tiny helpers in `regression-run.service.ts`

```typescript
// Both pure, easy to unit-test inline.
function countMobileTests(levels: TestLevel[]): number {
  let n = 0;
  for (const lvl of levels) for (const tc of lvl) if (isMobilePlatform(tc.platform)) n += 1;
  return n;
}
function dominantMobilePlatform(levels: TestLevel[]): 'android' | 'ios' | 'mixed' {
  let android = 0, ios = 0;
  for (const lvl of levels) for (const tc of lvl) {
    if (tc.platform?.startsWith('mobile_android') || tc.platform === 'mobile_flutter') android += 1;
    if (tc.platform?.startsWith('mobile_ios')) ios += 1;
  }
  if (android > 0 && ios === 0) return 'android';
  if (ios > 0 && android === 0) return 'ios';
  return 'mixed';
}
```

#### 4. Logging shape

Single log line per regression run start:
```
[REGRESSION_RUN] Mobile concurrency decided cap=2 reason="chosen min(envCap=3, poolIdle=2, desired=2)" testCount=4 platform=android envCap=3 poolIdle=2
```

This lets ops grep `Mobile concurrency decided` across a day's logs and see the distribution of caps + reasons. **No new metric column needed** — Phase 2 already captures wallclock; cap decision lives in logs.

### Edge cases (explicit)

| Case | Behaviour |
|---|---|
| envCap=1 | Always 1. Hard floor. |
| testCount=0 (api-only regression) | `countMobileTests` returns 0 → `testCount<=1` branch → cap=1. Mobile gate never fires because no mobile tests dispatched. No-op. |
| `getCapacity` returns mode='classic' (pool disabled) | `cap.pool === null` → poolIdle=null → cap=1. Logged. |
| `getCapacity` times out (5s) | Catch → cap=1 + warn. Regression proceeds serially. NOT a failure. |
| `getCapacity` returns `pool.android.idle=0` (all busy) | poolIdle<2 → cap=1. Logged with reason. |
| Mixed Android + iOS run | platform='mixed' → uses android pool capacity (iOS cold-starts anyway). |
| Pool capacity changes mid-run | We snapshot at start. If user releases more capacity during run, we don't pick it up. **Documented as design** — recomputing per-test would race with other regressions on shared pool. |
| Decision function itself throws (programmer error) | Wrapper around the call: `try { ... } catch { use envCap }`. Decision never breaks the regression. |

### Tests

**File:** `src/services/testing/regression/__tests__/concurrency-decision.test.ts` (new)

Cases (unit, no network):
1. `envCap=1` → cap=1, reason mentions force-serial
2. `testCount=1` → cap=1, reason mentions single test
3. `platform=ios` → cap=1, reason mentions ios
4. `getCapacity` rejects → cap=1, reason `getCapacity-failed`
5. `cap.pool === null` (classic mode) → cap=1
6. `poolIdle=1` → cap=1 (need ≥2)
7. `poolIdle=3, testCount=4, envCap=3` → cap=2 (smallBatch path)
8. `poolIdle=3, testCount=20, envCap=3` → cap=3 (largeBatch path)
9. `poolIdle=10, envCap=2, testCount=20` → cap=2 (envCap is the tightest)
10. Env vars override `smallBatch`/`smallCap`/`largeCap` constants

Mock `MobileRunnerClient` via a fake with `getCapacity: vi.fn()` (no real HTTP).

**No integration test** — getting the live runner involved would re-test the runner. Phase 4 success criteria measured in prod via the new log line.

### Verification (post-deploy)

1. Bump `REGRESSION_MOBILE_MAX_CONCURRENCY=3` in backend prod env (after Phase 3 stress test passes).
2. Trigger a regression with 10 tests.
3. Check logs: `grep "Mobile concurrency decided" → expect cap=3`.
4. Check Phase 2 telemetry:
   ```sql
   SELECT id, total_duration_ms, test_count, cold_start_count
   FROM regression_runs
   WHERE completed_at > NOW() - INTERVAL '1 hour' AND test_count >= 10
   ORDER BY started_at DESC LIMIT 5;
   ```
   `total_duration_ms` should drop ~2-3x vs Phase 3 baseline.

### Anti-goals (explicit)

- **No periodic re-decision** within a single regression run. Snapshot-and-go.
- **No historical-data-driven cap** (e.g. "p95 cold-start rate this week >50% → cap=1"). That's Phase 4.5 if Phase 4 doesn't cover it.
- **No multi-regression coordination** (e.g. "two regressions running, split the pool"). Each run sees current `poolIdle` and decides independently. Two parallel regressions both see idle=3 in the worst case and both try to take 3 — runner pool claim ladder + Phase 3 mutex absorbs the contention.
- **No frontend changes.** This is pure backend.

### Documentation updates (same-PR)

- `CLAUDE.md` Mobile flow section: add 1-line note about the decision function in the dispatch pipeline.
- Memory: 1-line entry in `MEMORY.md` index pointing at `phase_4_dynamic_concurrency.md` (new — with the SQL recipe + log-line grep).

### Estimate

- Decision function + helpers: 3-4 hours
- Tests: 2-3 hours
- Docs + memory: 30 min
- Verify type-check + run tests: 30 min
- Self-review (audit): 1 hour

**Total: 1 working day**, not 2-3 as in the earlier draft — most of the heavy lifting (Phase 3 mutex, `getCapacity()` method, Phase 2 telemetry) is already in place.

---

## Phase 5 — AI screen fingerprint scenario cache (2-3 недели, Backend + Frontend)

### Зачем

После Phase 4 параллелизм даёт 2-3x. Но каждый тест всё ещё проигрывает scenario заново. На регрессии из 50 тестов с login 30s = 15 минут на одни логины.

### Идея

Перед запуском scenario:
1. Сделать screenshot текущего экрана device
2. Сравнить с screenshot'ом "правильного конечного state" сохранённым после прошлого успешного прогона scenario (в том же regression run)
3. Если похожесть > порога (например 90%) → **скип scenario steps**, тест стартует сразу с своих шагов
4. Если ниже → проиграть scenario целиком, обновить cached screenshot

### Что нужно

#### 5.1 Backend infrastructure (1.5 недели)

**Колонка:** `regression_runs.scenario_state_cache jsonb` — `{[scenarioId]: {screenshotUrl, embeddingVector, lastUpdatedAt, testIdsBenefited[]}}`

**Сервис:** `src/services/test-resource/runtime/scenario-state-fingerprint.service.ts`
- `captureFinalState(scenarioId, regressionRunId, page)` — после успешного прогона scenario, screenshot + embedding
- `tryCacheHit(scenarioId, regressionRunId, page)` — перед прогоном, screenshot + сравнение
- Используем существующий embedding pipeline (`src/services/ai/embeddings/`)

**Точка инжекции:** `src/services/test-resource/resource-step-compiler.service.ts:258-271` (mobile compiler)

Псевдокод:
```
compileScenarioSetup(scenario, ctx):
  if (ctx.regressionRunId && fingerprintEnabled) {
    const cached = await tryCacheHit(scenario.id, ctx.regressionRunId, ctx.page);
    if (cached.hit && cached.similarity >= 0.9) {
      ctx.executedResources.scenarios.push({ id: scenario.id, status: 'skipped_fingerprint_hit', similarity: cached.similarity });
      return []; // empty steps — scenario skipped
    }
  }
  const steps = expandScenario(scenario);
  ctx.afterScenarioHooks.push(() => captureFinalState(scenario.id, ctx.regressionRunId, ctx.page));
  return steps;
```

**Invalidation:**
- Если scenario сыграл, но тест упал на первом шаге после scenario → invalidate cache (`scenario_state_cache[scenarioId] = null`)
- Если 2 hits подряд закончились failed test → invalidate (защита от gravamen "fingerprint врёт")

**Telemetry в `test_executions.executed_resources`:**
```json
{
  "scenarios": [{
    "id": "uuid",
    "name": "logged-in",
    "status": "executed" | "skipped_fingerprint_hit" | "failed_validate",
    "similarity": 0.94,
    "duration_ms": 0
  }]
}
```

#### 5.2 Frontend run-log indicators (3-4 дня)

В regression run log показать:
```
T2 "search"  ⏱ 00:42 → 01:01  ✅ pass
  └ 📦 scenario "logged-in"  ⏭ skipped — visual match 94% (0.5s)
```

Файл: `apps/web/src/components/.../RegressionRunLog.jsx` (найти при имплементации)

#### 5.3 Feature flag

Env: `MOBILE_SCENARIO_FINGERPRINT_ENABLED=false` по умолчанию. Включаем после shadow mode тестирования.

### Edge cases

- Embedding service вернул ошибку → fallback "no cache" (играем scenario)
- Page крашнулся в момент screenshot → fallback
- Similarity ровно на границе (0.85-0.90) → играем scenario (safer)
- Screenshot занимает >2 секунд → отменить, играть scenario (быстрее чем ждать сравнение)
- iOS — нет реализации (Phase 5 = Android only)

### Verification

- Shadow mode: 1 неделя в проде — `fingerprintEnabled=true`, **но всегда играем scenario** + логируем что бы скипнули. Сравниваем cache_hit predictions с реальными test outcomes.
- Если в shadow mode predictions корректные >95% — включаем primary
- Метрика: average regression duration до/после

### Что НЕ делаем

- Не делаем user-authored validate steps — fingerprint полностью автоматический
- Не сохраняем screenshot между regression runs — только в пределах одного run (Redis TTL = длительность run)
- Не делаем fingerprint для web (отдельная фича)

---

## Phase 6 — `sequence_group` flag (3-5 дней, conditional)

### Зачем

После Phase 1+5 у нас 80% use-case'ов покрыто. Остаётся **linear flows с data dependencies** — например onboarding (register → verify email → first login). Email из теста register нужен для verify email — это **не infrastructure constraint**, это data dependency.

### Decision gate

**Делаем только если** Phase 2 telemetry покажет реальный спрос:
- Юзеры реально создают цепочки тестов где порядок критичен
- Customer feedback "хочу группировать тесты"

Если данных нет — **не делаем**. Скрипаем заметку и забываем.

### Что делаем (если делаем)

#### Backend

**Колонка:** `intent_test_cases.sequence_group uuid NULL` — все тесты с одинаковым `sequence_group` идут как группа.

**Колонка:** `intent_test_cases.sequence_order int NULL` — порядок внутри группы.

**Логика в regression dispatch** (`regression-run.service.ts`):
- Если `sequence_group` есть — все тесты группы идут на одну сессию подряд, БЕЗ `pm clear` между ними
- `pm clear` только перед первым тестом группы
- Если любой тест в группе упал — остальные skipped с причиной "sequence prerequisite failed"
- Между группами — обычный isolation

**Mobile job** (`mobile-test-run.job.ts`):
- Новые поля в `TestJobData`: `sequenceGroupId`, `sequencePosition`, `isFirstInSequence`
- Если `!isFirstInSequence` — пропустить `MobileAppPrepService.prepApp`, переиспользовать сессию

#### Frontend

В test card в дереве — group indicator (цветная полоска или icon).

В test editor — секция "Run as part of sequence" с dropdown выбора группы + position.

### Edge cases

- Sequence group с одним тестом — игнорируем флаг, обычный isolation
- Sequence group со scenarios — scenario играется только перед первым тестом группы, остальные тесты в группе используют state от предыдущего теста (не scenario)
- Кросс-платформенная группа — не позволяем (validation на backend)
- Удаление теста из середины группы — последующие тесты могут стартовать не из ожидаемого state. Warning при удалении.

### Что НЕ делаем

- ❌ Новая таблица `test_suites` — flag достаточно
- ❌ UI группировка в дереве как отдельная сущность — visual indicator достаточно

---

## Phase 7+ — Burst pool / Autoscale (conditional, DevOps)

### Decision gate

Включаем **только если все три условия:**
1. Phase 2 telemetry показывает что p95 regression duration > 30 минут после Phase 1+5
2. > 10% регрессий имеют > 20 тестов
3. Customer reported "регрессия слишком долгая"

### Что предположительно

- **Burst pool** — preheated standby redroid контейнеры на той же VM (требует +RAM) или на отдельной VM
- **True autoscale** — Terraform + GCP API spin-up VM per regression > N tests, tear-down после

**Не пишем детальный план пока не дошли до decision gate.** Это работа SRE + DevOps + finance approval (cost line item).

---

## Risk Analysis — что может пойти не так

### R1: AI fingerprint cache врёт → тест падает на первом шаге

**Митигация:**
- Strict similarity threshold (0.90, не 0.70)
- Auto-invalidate cache после 2 failed tests подряд после cache hit
- Shadow mode 1 неделя перед prod включением
- Feature flag для quick disable
- Telemetry: track cache_hit_then_test_failed rate

### R2: Phase 1.2 inline preview производительность

Если scenario большой (20+ шагов) и тестов много в дереве — лагает.

**Митигация:**
- Lazy load — preview грузится только когда панель развернули
- Memo на scenario data per testId

### R3: Phase 1.3 extract — backend wrapper отсутствует

При имплементации может выясниться что create scenario endpoint не принимает готовые шаги (только пустой scenario).

**Митигация:**
- Сначала проверить existing endpoint
- Если требуется новый — добавить тонкий wrapper, не более 30 LOC

### R4: Phase 3 race fix дольше чем 1-2 недели

DevOps оценил приблизительно. Реальный fix может занять 3-4 недели.

**Митигация:**
- Phase 4 блокируется только Phase 3
- Phase 1, 2, 5, 6 — независимы, продолжаем параллельно
- Можем шипнуть Phase 1+5 даже с `MAX_IN_FLIGHT=1` — выигрыш от fingerprint cache работает в serial mode тоже

### R5: Phase 5 embedding cost

Каждый scenario invocation = 1 screenshot upload + 1 embedding generation. На 10 регрессий × 50 тестов × 1 scenario = 500 embeddings/день.

**Митигация:**
- Используем существующий self-hosted embedding (если есть) или дешёвый OpenAI ada
- Кеш per regression run (не cross-run) — invalidates after run completes
- Cost monitor — alert если стоимость embeddings > X USD/день

### R6: Phase 6 sequence_group breaks без явного scenario

Юзер делает group без scenarios, первый тест группы упал на step 3, остальные skipped — но юзер ожидал что они независимы.

**Митигация:**
- В UI чётко показать "Этот тест часть sequence — упадёт если предыдущий упал"
- Warning при создании sequence_group: "Tests in sequence are not independent"

### R7: i18n strings не переведены до Phase 1.1

Кто-то новый делает Phase 1.2 — а Phase 1.1 i18n не shipped. UI показывает "Setup" в одних местах, "Scenario" в других.

**Митигация:**
- Phase 1.1 строго первой подфазой
- Single PR со всеми i18n изменениями
- Pre-commit check — `grep -i "setup" apps/web/src/i18n/locales/*.js | grep -v scenarioSetup.title` должен быть пустой

### R8: Web tests случайно затронуты

Phase 1 затрагивает `TestSuitesMobile.jsx`. Кто-то ошибочно меняет shared компоненты.

**Митигация:**
- Перед каждым PR: `git diff --stat | grep -E "TestSuitesWeb|RunAsSplitButton\."` — если есть изменения в `TestSuitesWeb.jsx`, обосновать
- `RunAsSplitButton` shared — изменения только additive (новые props, не breaking existing)

### R9: Telemetry данные показывают что **другая** проблема главная

Phase 2 может выявить что регрессии медленные из-за **cold-start tail** (60s × cold), а не из-за scenarios. Тогда Phase 5 решает не ту проблему.

**Митигация:**
- После 2 недель Phase 2 — review meeting перед стартом Phase 5
- Готовность отложить Phase 5 и сделать pool warming improvements вместо

### R10: Phase 0 — `openEditorForSetup(null)` принимает только existing resource

Текущая сигнатура (`TestSuitesMobile.jsx:11637`) проверяет `resource.kind` — passing `null` упадёт.

**Митигация:**
- Обновить сигнатуру: `openEditorForSetup(resource: Resource | null)` — null path создаёт новый scenario
- Проверить при имплементации Phase 0

---

## Phase Dependencies Diagram

```
   Phase 0 ──→ Phase 1 ──→ Phase 5 ──→ (Phase 6 if telemetry warrants)
                                       
   Phase 2 ─────────────────────────────→ (Phase 6/7 decision gate)
   (parallel)
                                       
   Phase 3 ──→ Phase 4 ──→ (Phase 7 if telemetry warrants)
   (DevOps team, parallel to FE)
```

Frontend трек (Phase 0 → 1) идёт прямо с этой недели.
Backend трек (Phase 2 → 5) параллельно.
DevOps трек (Phase 3 → 4) параллельно, отдельной командой.

---

## What we explicitly defer

| Что | Почему отложено |
|---|---|
| Hybrid Test Suite table | Заменяется Phase 6 sequence_group flag |
| User-authored validate | Заменяется Phase 5 AI fingerprint |
| AI Auto-Suggest Extract (Testim-style) | Killer feature, не в Phase 1. Возможно Phase 8 |
| Parameterized scenarios | Не запрашивали юзеры, не сейчас |
| iOS parallelism | Нет macOS host инфры, отдельный трек |
| Web sequence_group | Phase 6 только mobile |
| storageState snapshot для mobile | Технически тупик |
| `enrichBindingsWithDefaults` retroactive | Risk surprise existing tests |
| State snapshot via adb backup | Технически медленно (10-100MB/test) |
| Cross-platform scenarios | Платformlocked at creation, оставляем |
| DAG visualization | Преждевременная сложность |

---

## Success Criteria

После Phase 0+1: на пустом проекте юзер за 5 минут создаёт scenario "logged-in" и привязывает к 3 тестам. Видит preview шагов перед каждым тестом.

После Phase 3+4: на стабильной инфре `MAX_IN_FLIGHT=2` (или 3) работает 7 дней без race-related failures. Регрессия из 10 тестов идёт ~50% от serial wall time.

После Phase 5: 90% scenarios скипаются по cache в типичной регрессии (5+ тестов с одинаковым scenario). Регрессия из 50 тестов = ~20 минут вместо 48.

После Phase 6 (если делаем): юзер может создать onboarding flow из 4 связанных тестов одним кликом.

---

## What we measure end-to-end

- Time-to-first-scenario для нового юзера (target: < 5 минут)
- p95 regression duration по test_count buckets (target: 50-test regression < 25 минут после Phase 5)
- Cache hit rate в Phase 5 (target: > 70% после прогрева)
- Race-related failure rate в Phase 4 (target: < 0.1%)
- User feedback score "regression speed" (target: > 4/5)

---

## Open Questions для команды

1. **Когда стартуем Phase 0?** Это блокер для пустых проектов — кажется приоритетным.
2. **Кто owner DevOps трека (Phase 3)?** Backend команда не сможет это сделать.
3. **Phase 5 embedding cost** — кто owner cost monitoring? Нужен бюджет.
4. **Phase 6 decision** — какой минимум данных Phase 2 нужен чтобы решить yes/no?
5. **iOS — отдельный плановый трек или вообще не сейчас?** Сейчас на проде iOS pool size = 0.
6. **Phase 1.3 extract — UX deeper review нужен?** Сложная фича, может стоит мокап-сессии перед кодом.

---

## Версионирование плана

- v1 (этот документ) — после design discussion с командой. Решения зафиксированы.
- v2 — после Phase 2 telemetry data review (~через 1 месяц). Обновим решения Phase 5/6/7.
