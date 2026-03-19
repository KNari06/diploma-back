# LLM Active Layer Detection — Plan

## Что заменяем

`detectActiveModal()` в `snapshot-collector.ts` (строки 135-319) — 180 строк эвристик:
- z-index >= 3, coverage 3-90%, sidebar/header exclusion, class regex patterns
- Ломается на нестандартных сайтах (repetino.kz drawer, custom React popups)

## Что оставляем

- **Step 1**: `querySelectorAll` сбор элементов — скрипт ✅
- **Step 3**: `buildAllowedSets` rule engine — скрипт ✅
- **Step 4**: LLM element selection — уже работает ✅
- **Step 5**: execute action — скрипт ✅

## Архитектура нового Step 2

### Файл: `src/services/testing/ui/preview/active-layer-detector.service.ts` (новый)

```typescript
interface ActiveLayerResult {
  hasActiveLayer: boolean;
  layerType: 'modal' | 'drawer' | 'dropdown' | 'tooltip' | 'popover' |
             'toast' | 'combobox' | 'context-menu' | 'mega-menu' |
             'cookie-banner' | 'sticky-header' | 'none';
  activeRefs: string[];           // refs элементов в активном слое
  backgroundBlocked: boolean;     // true = фон за overlay не кликабелен
  confidence: number;             // 0-1
}

async function detectActiveLayer(
  elements: ElementSummary[],     // ref, tag, text, boundingBox, role
  pageUrl: string,
  options: {
    timeout?: number;             // default 2000ms
    cache?: ActiveLayerCache;
  }
): Promise<ActiveLayerResult>
```

### Prompt для LLM (Gemini Flash — быстрый и дешёвый)

```
You analyze a web page's interactive elements to detect overlay layers.

PAGE: {url}
VIEWPORT: {width}x{height}

ELEMENTS ({count}):
1. ref="e1" <button> "Login" pos=(10,50) size=100x40
2. ref="e5" <input> placeholder="Search" pos=(200,50) size=300x36
...
45. ref="e45" <input> placeholder="+7(___)" pos=(900,300) size=300x36
46. ref="e46" <button> "Continue" pos=(900,370) size=300x40

Determine if there is an active overlay layer (modal, drawer, dropdown,
tooltip, popover, toast, combobox, context-menu, mega-menu, cookie-banner).

Rules:
- Overlay = group of elements floating ABOVE the main page content
- Elements in overlay typically have higher position coordinates that cluster together
- Drawer: elements clustered on one side (right/left)
- Modal: elements clustered in center
- Dropdown: small group below a trigger element
- If NO overlay visible, return hasActiveLayer: false

Return JSON only:
{
  "hasActiveLayer": boolean,
  "layerType": "modal" | "drawer" | "dropdown" | ... | "none",
  "activeRefs": ["e45", "e46"],
  "backgroundBlocked": boolean
}
```

### Где вызывается

**НЕ в snapshot-collector** (это browser context, нет async/LLM).

Вызывается в `element-resolver.service.ts` → `buildAllowedSets()`:

```
БЫЛО:
  nodes уже имеют isInsideActiveModal от snapshot-collector эвристик
  buildAllowedSets() использует этот флаг

БУДЕТ:
  1. snapshot-collector собирает элементы БЕЗ modal detection (убираем detectActiveModal)
  2. Элементы приходят в buildAllowedSets() без isInsideActiveModal
  3. buildAllowedSets() вызывает detectActiveLayer(elements) → LLM
  4. LLM возвращает activeRefs → помечаем эти элементы как active layer
  5. Остальная фильтрация работает как раньше
```

### Кэширование

```typescript
interface ActiveLayerCache {
  key: string;           // hash(url + elementCount + topElementRefs)
  result: ActiveLayerResult;
  timestamp: number;
  ttl: 30000;            // 30 секунд — достаточно для editor сессии
}
```

Cache key = `hash(pageUrl + domNodes.length + first10Refs)`.
DOM mutation (новый элемент появился) → cache miss → новый LLM вызов.
Мелкие изменения (text change, attribute change) → cache hit.

### Timeout / Fallback

```
LLM ответил за 2с → используем результат
LLM timeout 2с    → fallback: ВСЕ элементы allowed (не фильтруем)
LLM error         → fallback: ВСЕ элементы allowed
LLM вернул несуществующие refs → игнорируем, используем только валидные
LLM вернул 0 activeRefs но hasActiveLayer=true → fallback: все allowed
```

### Что удаляем из snapshot-collector.ts

1. `detectActiveModal()` — вся функция (строки 135-319)
2. Вся логика `isInsideActiveModal` в element tagging
3. `__mc.ironCladSelectors`, `__mc.positionalSelector`, `__mc.overlaySelectors` — больше не нужны
4. `__mc.classRegexSource` — больше не нужен

**НО** оставляем Layer 1 iron-clad (`role="dialog"`, `dialog[open]`) как быстрый shortcut:
- Если `role="dialog"` найден → не вызываем LLM, используем `.contains()` как раньше
- LLM вызывается ТОЛЬКО когда iron-clad не нашёл модал

### Что меняем в buildAllowedSets()

```typescript
// БЫЛО:
const hasModalFlaggedElements = nodes.some(n => n.isInsideActiveModal === true);

// БУДЕТ:
const layerResult = await detectActiveLayer(nodes, pageUrl, { cache });
const activeRefSet = new Set(layerResult.activeRefs);
// Помечаем nodes
for (const node of nodes) {
  node.isInsideActiveModal = activeRefSet.has(node.ref);
}
const hasVisibleModal = layerResult.hasActiveLayer && layerResult.backgroundBlocked;
```

### Что меняем в intent-step-lint.service.ts

`buildAllowedSets` станет async → `lintStepWithAI` уже async → минимальные изменения.

## Порядок реализации

1. Создать `active-layer-detector.service.ts` с prompt + cache + fallback
2. Сделать `buildAllowedSets` async
3. Интегрировать detectActiveLayer в buildAllowedSets
4. Оставить Layer 1 iron-clad в snapshot-collector как fast path
5. Убрать positional/legacy heuristics из snapshot-collector
6. Тест на repetino.kz drawer case
