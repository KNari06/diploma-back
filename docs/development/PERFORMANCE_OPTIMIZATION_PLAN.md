# План оптимизации производительности тестов

**Дата:** 2024-11-27
**Статус:** 🔴 Критично
**Проблема:** Тесты работают слишком долго (10+ минут вместо 1-2 минут)

---

## 📊 Анализ текущей производительности

### ⏱️ Время на каждую страницу (текущее)

| Этап | Время | Проблема |
|------|-------|----------|
| **Modal Waiting** | 5,000ms | ❌ Фиксированное ожидание, даже если модалок нет |
| **DOM Analysis** | ~500ms | ✅ Быстро |
| **Screenshot** | ~200ms | ✅ Быстро |
| **Vision Analysis** | 11,000-12,000ms | ❌ Медленный GPT-4 Vision API |
| **Match Vision-DOM** | ~1,000ms | ⚠️ Может быть быстрее |
| **Logic Analysis** | 2,400ms | ⚠️ Можно оптимизировать |
| **Action Generation** | 5,000ms | ⚠️ Можно оптимизировать |
| **Execute Actions** | ~2,000ms | ✅ Нормально |
| **Delays** | 1,500ms | ❌ Лишние задержки (500ms + 1000ms) |
| **ИТОГО** | **~28 секунд** | ❌ Слишком долго! |

### 🔴 Критические проблемы

1. **Modal Waiting: 5 секунд на каждую страницу**
   - Ждёт 5 секунд даже если модалок нет
   - На 4 страницах = 20 секунд потеряно

2. **Vision Analysis: 11-12 секунд на каждую страницу**
   - GPT-4 Vision API медленный
   - На 4 страницах = 48 секунд потеряно

3. **Последовательное выполнение**
   - Все операции выполняются последовательно
   - Нет параллелизма

4. **Лишние задержки**
   - `waitForTimeout(500)` после каждого действия
   - `waitForTimeout(1000)` между итерациями
   - На 10 действий = 5+ секунд потеряно

---

## ✅ План оптимизации

### 🎯 Цель: Сократить время с 28 сек до 5-8 сек на страницу

---

## 1. Оптимизация Modal Waiting (экономия: 3-4 сек на страницу)

**Проблема:** Ждёт 5 секунд даже если модалок нет

**Решение:** Умное обнаружение с ранним выходом

```typescript
// src/agent/intelligent-page-analyzer.ts

private static async waitForModals(page: Page): Promise<void> {
  const startTime = Date.now();
  const { maxWaitTime, checkInterval } = MODAL_DETECTION_CONFIG;

  // ✅ OPTIMIZED: Quick check first (most pages don't have modals)
  let modalCount = await this.quickModalCheck(page);

  // If modals found immediately, wait for full render
  if (modalCount > 0) {
    logger.info('[INTELLIGENT_ANALYZER] Modal found immediately', { modalCount });
    await page.waitForTimeout(500); // Wait for render
    return; // Exit early
  }

  // ✅ OPTIMIZED: Only wait if we suspect modals might appear
  // Check for common modal triggers (cookies, newsletter, etc.)
  const hasModalTriggers = await this.checkModalTriggers(page);
  if (!hasModalTriggers) {
    logger.debug('[INTELLIGENT_ANALYZER] No modal triggers, skipping wait');
    return; // Exit early - no modals expected
  }

  // ✅ OPTIMIZED: Reduced max wait time to 2 seconds
  const optimizedMaxWait = 2000; // 2 seconds instead of 5

  // Check periodically with early exit
  while (Date.now() - startTime < optimizedMaxWait) {
    modalCount = await this.quickModalCheck(page);

    if (modalCount > 0) {
      logger.info('[INTELLIGENT_ANALYZER] Modal appeared', {
        modalCount,
        elapsed: `${Date.now() - startTime}ms`,
      });
      await page.waitForTimeout(500); // Wait for render
      return; // Exit early
    }

    // ✅ OPTIMIZED: Check less frequently (every 300ms instead of 500ms)
    await page.waitForTimeout(300);
  }

  logger.debug('[INTELLIGENT_ANALYZER] No modals detected, continuing');
}

/**
 * Quick modal check (lightweight)
 */
private static async quickModalCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    // Quick check: only look for obvious modals (role="dialog", high z-index)
    const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    return modals.length;
  });
}

/**
 * Check if page has modal triggers (cookies, newsletter, etc.)
 */
private static async checkModalTriggers(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const bodyText = document.body.textContent?.toLowerCase() || '';
    const hasCookieKeywords = bodyText.includes('cookie') || bodyText.includes('gdpr');
    const hasNewsletterKeywords = bodyText.includes('newsletter') || bodyText.includes('subscribe');
    return hasCookieKeywords || hasNewsletterKeywords;
  });
}
```

**Экономия:** 3-4 секунды на страницу (было 5 сек, станет 0.5-1.5 сек)

---

## 2. Оптимизация Vision Analysis (экономия: 5-7 сек на страницу)

**Проблема:** Vision Analysis занимает 11-12 секунд

**Решения:**

### 2.1. Кэширование Vision результатов

```typescript
// src/services/cache/vision-cache.service.ts

export class VisionCacheService {
  /**
   * Get cached vision analysis for page
   */
  static async getCached(url: string, domHash: string): Promise<VisionAnalysis | null> {
    // Check cache by URL + DOM hash
    const cacheKey = `vision:${url}:${domHash}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      logger.info('[VISION_CACHE] Cache hit', { url });
      return cached;
    }
    return null;
  }

  /**
   * Save vision analysis to cache
   */
  static async saveCache(url: string, domHash: string, analysis: VisionAnalysis): Promise<void> {
    const cacheKey = `vision:${url}:${domHash}`;
    await this.cache.set(cacheKey, analysis, { ttl: 3600 }); // 1 hour
  }

  /**
   * Generate DOM hash for cache key
   */
  static async generateDOMHash(page: Page): Promise<string> {
    const dom = await page.evaluate(() => {
      // Get simplified DOM structure (only interactive elements)
      const elements = document.querySelectorAll('form, button, input, a[href]');
      return Array.from(elements).map(el => ({
        tag: el.tagName,
        id: el.id,
        class: el.className,
        text: el.textContent?.substring(0, 50),
      }));
    });

    // Generate hash
    const crypto = await import('crypto');
    return crypto.createHash('md5').update(JSON.stringify(elements)).digest('hex');
  }
}
```

### 2.2. Использовать Vision только когда нужно

```typescript
// src/agent/intelligent-page-analyzer.ts

private static async shouldUseVision(domAnalysis: DOMAnalysis): Promise<boolean> {
  // ✅ OPTIMIZED: More aggressive skipping
  // Skip Vision if page is simple (few elements)
  const totalElements = domAnalysis.forms.length +
                       domAnalysis.buttons.length +
                       domAnalysis.inputs.length;

  if (totalElements < 5) {
    logger.debug('[INTELLIGENT_ANALYZER] Page too simple, skipping Vision');
    return false; // Skip Vision for simple pages
  }

  // Use Vision only for complex pages
  const hasComplexForms = domAnalysis.forms.length > 1;
  const hasManyButtons = domAnalysis.buttons.length > 10; // Increased threshold
  const hasModals = (domAnalysis.modals?.length || 0) > 0;

  return hasComplexForms || hasManyButtons || hasModals;
}
```

### 2.3. Параллельная обработка Vision + Logic

```typescript
// src/agent/intelligent-page-analyzer.ts

// ✅ OPTIMIZED: Run Vision and Logic in parallel (if Vision is used)
if (mode === 'full' || (mode === 'balanced' && await this.shouldUseVision(domAnalysis))) {
  // Run Vision and Logic in parallel
  const [visionResult, logicResult] = await Promise.all([
    this.analyzeWithVision(screenshot, url, goal, previousContext),
    this.analyzeLogic(domAnalysis.pageType, domAnalysis.elements, enhancedDomAnalysis),
  ]);

  visionAnalysis = visionResult;
  logicAnalysis = logicResult;
} else {
  // Fast path: no Vision
  visionAnalysis = await this.analyzeWithoutVision(domAnalysis, url);
  logicAnalysis = await this.analyzeLogic(domAnalysis.pageType, [], enhancedDomAnalysis);
}
```

**Экономия:** 5-7 секунд на страницу (кэш) или 2-3 секунды (параллелизм)

---

## 3. Оптимизация matchVisionElementsWithDOMSelectors (экономия: 0.5-1 сек)

**Проблема:** Делает лишние `page.locator().count()` вызовы

**Решение:** Кэшировать результаты поиска

```typescript
// src/agent/intelligent-page-analyzer.ts

private static async matchVisionElementsWithDOMSelectors(
  page: Page,
  visionAnalysis: VisionAnalysis,
  domAnalysis: DOMAnalysis
): Promise<VisionAnalysis> {
  // ✅ OPTIMIZED: Batch all locator checks at once
  const textSelectorsToCheck: string[] = [];

  for (const visionElement of visionAnalysis.elements) {
    if (!visionElement.selector && visionElement.text) {
      textSelectorsToCheck.push(`${visionElement.type}:has-text("${visionElement.text}")`);
    }
  }

  // ✅ OPTIMIZED: Check all selectors in parallel (one page.evaluate call)
  const selectorResults = await page.evaluate((selectors) => {
    const results: Record<string, number> = {};
    for (const selector of selectors) {
      try {
        // @ts-ignore - browser context
        results[selector] = document.querySelectorAll(selector).length;
      } catch {
        results[selector] = 0;
      }
    }
    return results;
  }, textSelectorsToCheck);

  // Match elements using cached results
  const matchedElements = visionAnalysis.elements.map((visionElement, idx) => {
    // ... existing matching logic ...

    // Use cached selector result
    if (!matchedSelector && visionElement.text) {
      const textSelector = textSelectorsToCheck[idx];
      if (selectorResults[textSelector] > 0) {
        matchedSelector = textSelector;
      }
    }

    return { ...visionElement, selector: matchedSelector || '' };
  });

  return { ...visionAnalysis, elements: matchedElements };
}
```

**Экономия:** 0.5-1 секунда на страницу

---

## 4. Убрать лишние задержки (экономия: 1.5 сек на итерацию)

**Проблема:** Лишние `waitForTimeout`

**Решение:** Умные задержки только когда нужно

```typescript
// src/agent/intelligent-test-orchestrator.ts

// ❌ УБРАТЬ: await this.page.waitForTimeout(500); // После каждого действия
// ✅ ЗАМЕНИТЬ: Умное ожидание только при необходимости

// После действия
const urlAfter = this.page.url();
const urlChanged = urlBefore !== urlAfter;

// ✅ OPTIMIZED: Wait only if URL changed (page navigation)
if (urlChanged) {
  // Wait for new page to stabilize
  await this.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
} else {
  // No wait needed - same page, just check if element appeared
  // Most actions don't need delay
}

// ❌ УБРАТЬ: await this.page.waitForTimeout(1000); // Между итерациями
// ✅ ЗАМЕНИТЬ: Нет задержки между итерациями (не нужна)
```

**Экономия:** 1.5 секунды на итерацию

---

## 5. Параллелизация операций (экономия: 2-3 сек на страницу)

**Проблема:** Все операции последовательные

**Решение:** Параллельное выполнение где возможно

```typescript
// src/agent/intelligent-page-analyzer.ts

static async analyzePage(
  page: Page,
  goal: string,
  mode: 'full' | 'fast' | 'balanced' = 'balanced',
  previousContext?: string
): Promise<PageContext> {
  const startTime = Date.now();
  const url = page.url();

  try {
    // ✅ OPTIMIZED: Run modal check and DOM analysis in parallel
    const [modalCheckResult, domAnalysis] = await Promise.all([
      this.quickModalCheck(page), // Fast check
      this.analyzeDOMFull(page),
    ]);

    // Only wait for modals if found
    if (modalCheckResult > 0) {
      await this.waitForModals(page);
    }

    // ✅ OPTIMIZED: Run screenshot and Vision decision in parallel
    const [screenshot, shouldUseVisionResult] = await Promise.all([
      this.captureScreenshot(page, mode),
      this.shouldUseVision(domAnalysis),
    ]);

    // ✅ OPTIMIZED: Run Vision and Logic in parallel (if Vision needed)
    let visionAnalysis: VisionAnalysis;
    let logicAnalysis: any;

    if (mode === 'full' || (mode === 'balanced' && shouldUseVisionResult)) {
      // Check cache first
      const domHash = await VisionCacheService.generateDOMHash(page);
      const cached = await VisionCacheService.getCached(url, domHash);

      if (cached) {
        visionAnalysis = cached;
        logger.info('[INTELLIGENT_ANALYZER] Using cached Vision analysis');
      } else {
        // Run Vision and Logic in parallel
        [visionAnalysis, logicAnalysis] = await Promise.all([
          this.analyzeWithVision(screenshot, url, goal, previousContext),
          this.analyzeLogic(domAnalysis.pageType, [], domAnalysis), // Start early
        ]);

        // Save to cache
        await VisionCacheService.saveCache(url, domHash, visionAnalysis);
      }
    } else {
      visionAnalysis = await this.analyzeWithoutVision(domAnalysis, url);
    }

    // ✅ OPTIMIZED: Match Vision-DOM while Logic runs (if not already done)
    if (!logicAnalysis) {
      logicAnalysis = await this.analyzeLogic(
        visionAnalysis.pageType,
        visionAnalysis.elements,
        domAnalysis
      );
    }

    // Match Vision with DOM (can run in parallel with Logic if Logic already done)
    visionAnalysis = await this.matchVisionElementsWithDOMSelectors(
      page,
      visionAnalysis,
      domAnalysis
    );

    // Build context
    return {
      url,
      pageType: visionAnalysis.pageType,
      timestamp: Date.now(),
      vision: visionAnalysis,
      dom: domAnalysis,
      screenshot: mode !== 'fast' ? screenshot : undefined,
      requiredActions: logicAnalysis.requiredActions,
      possibleActions: logicAnalysis.possibleActions,
      criticalElements: visionAnalysis.elements.filter(el => el.priority === 'critical'),
      warnings: visionAnalysis.warnings || [],
    };
  } catch (error) {
    // ... error handling
  }
}
```

**Экономия:** 2-3 секунды на страницу

---

## 6. Оптимизация Action Generation (экономия: 1-2 сек)

**Проблема:** 5 секунд на генерацию действий

**Решение:** Использовать более быструю модель для простых случаев

```typescript
// src/agent/contextual-action-generator.ts

static async generateActions(
  context: PageContext,
  state: TestState,
  page?: Page
): Promise<{ actions: DynamicAction[]; reasoning: string; confidence: number }> {
  // ✅ OPTIMIZED: Use faster model for simple pages
  const isSimplePage = context.dom.buttons.length < 5 &&
                       context.dom.forms.length === 0 &&
                       context.dom.inputs.length < 3;

  const model = isSimplePage ? 'gpt-4o-mini' : 'gpt-4o'; // Faster for simple pages

  const response = await openai.chat.completions.create({
    model, // ✅ Use faster model for simple pages
    messages: [
      {
        role: 'system',
        content: 'You are an expert QA automation engineer generating test actions.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: isSimplePage ? 800 : 1500, // ✅ Less tokens for simple pages
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  // ... rest of code
}
```

**Экономия:** 1-2 секунды на простых страницах

---

## 📊 Итоговая экономия времени

| Оптимизация | Экономия на страницу | Приоритет |
|-------------|---------------------|-----------|
| Modal Waiting | 3-4 сек | 🔴 Критично |
| Vision Cache | 5-7 сек (при повторных запусках) | 🟡 Высокий |
| Параллелизация | 2-3 сек | 🔴 Критично |
| Убрать задержки | 1.5 сек | 🔴 Критично |
| Match оптимизация | 0.5-1 сек | 🟢 Средний |
| Action Generation | 1-2 сек | 🟢 Средний |
| **ИТОГО** | **12-18 сек** | - |

**Результат:** С 28 секунд → 10-16 секунд на страницу (улучшение на 40-60%)

---

## 🎯 План внедрения

### Фаза 1: Критичные оптимизации (2-3 часа)
1. ✅ Оптимизация Modal Waiting
2. ✅ Убрать лишние задержки
3. ✅ Параллелизация операций

**Ожидаемый результат:** 28 сек → 18-20 сек на страницу

### Фаза 2: Кэширование (3-4 часа)
4. ✅ Vision Cache
5. ✅ DOM Hash для кэша

**Ожидаемый результат:** 18-20 сек → 10-12 сек на страницу (при повторных запусках)

### Фаза 3: Дополнительные оптимизации (2-3 часа)
6. ✅ Оптимизация matchVisionElementsWithDOMSelectors
7. ✅ Оптимизация Action Generation

**Ожидаемый результат:** 10-12 сек → 8-10 сек на страницу

---

## 📝 Следующие шаги

1. **Обсудить приоритеты** - начать с Фазы 1?
2. **Реализовать оптимизации** - по порядку
3. **Измерить результаты** - сравнить до/после
4. **Итеративно улучшать** - на основе метрик

---

**Дата создания:** 2024-11-27
