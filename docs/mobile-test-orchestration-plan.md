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

### Что собираем

В `regression_runs` уже есть `started_at`, `completed_at`. Добавить:

**Колонки в `regression_runs`:**
- `test_count int` — сколько тестов в run
- `total_duration_ms int` — total wall time
- `total_app_setup_ms int` — суммарное время `MobileAppPrepService.prepApp` по всем тестам в run
- `total_scenario_ms int` — суммарное время scenario steps
- `total_test_steps_ms int` — суммарное время user steps
- `cold_start_count int` — сколько cold-start было в run

**Колонки в `test_executions`:**
- `app_setup_ms int`
- `scenario_steps_ms int` (если использовали scenario)
- `test_steps_ms int`
- `cold_start_used bool`

**Endpoint для дашборда:**
- `GET /admin/regression-metrics?from=...&to=...` — возвращает histogram распределения по test_count, p50/p95/p99 duration, % cold-starts

### Анти-цель

**Не пытаться** агрегировать на runtime в красивые dashboards. Это просто СУБД-данные для ad-hoc SQL запросов. Дашборд может появиться позже.

### Verification

- После 2 недель прода — посмотреть `SELECT test_count, percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms) FROM regression_runs GROUP BY test_count` — есть ли реальные пользователи которые жалуются на performance?

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

### Зачем

После Phase 3 — использовать существующий pool из 3 redroid умно. Маленькие регрессии не платят overhead, большие получают 2-3x speedup.

### Что делаем

**Файл:** `src/services/testing/regression/regression-run.service.ts:2088`

Заменить static parse на функцию:

```typescript
const decideMaxInFlight = (testCount: number, poolHealth: PoolHealth): number => {
  const envCap = parseInt(process.env.REGRESSION_MOBILE_MAX_CONCURRENCY || '1', 10);
  if (envCap <= 1) return 1;                          // operator forced serial
  if (poolHealth.warmReady < 2) return 1;             // pool not healthy
  if (testCount === 1) return 1;                      // overhead не нужен
  if (testCount <= 5) return Math.min(2, envCap, poolHealth.warmReady);
  return Math.min(3, envCap, poolHealth.warmReady);
};
```

**Pool health check** — лёгкий `GET /pool/status` к runner, возвращает `{warmReady: 0..3}`. Если runner недоступен — fallback `warmReady=0` → serial.

### Edge cases

- Pool health check сам fail'ит → fallback serial, лог warn
- envCap=1 (operator hard-override) → всегда serial
- iOS платформа → warmReady всегда 0 (нет iOS pool на проде) → serial

### Verification

Unit-test на `decideMaxInFlight` с 6 сценариями. Integration: запустить регрессию из 10 тестов после Phase 3 → лог "in-flight cap=3" → 10/3 = ~3.3 батча → wall time снижается до 1/3 от serial.

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
