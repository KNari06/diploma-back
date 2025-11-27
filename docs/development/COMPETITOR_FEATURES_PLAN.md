# План внедрения функциональности конкурента

**Дата:** 2024-11-27
**Статус:** 📋 Планирование
**Приоритет:** Средний

---

## 🎯 Цель

Добавить функции автоматического crawling и fuzzing, которые есть у конкурента:

1. **Crawling (Исследование)** - автоматический обход всех ссылок сайта
2. **Link Validation** - проверка всех ссылок на 404/ошибки
3. **Form Fuzzing** - тестирование форм с разными типами данных
4. **Button Testing** - проверка всех кнопок на сбои

---

## 📊 Текущий статус vs Конкурент

### ✅ Что уже есть

| Функция | Наша система | Конкурент |
|---------|--------------|-----------|
| Идентификация элементов | ✅ Vision AI + DOM | ✅ HTML парсинг |
| Проверка статус-кодов | ✅ При навигации | ✅ Для всех ссылок |
| Проверка JS ошибок | ✅ Консоль | ✅ Консоль |
| API Fuzzing | ✅ Intelligent | ❌ Нет |
| Тестирование форм | ✅ Валидные данные | ✅ Fuzzing данные |
| Выбор действий | ✅ AI-driven по цели | ✅ Автоматический обход |

### ❌ Чего нет (но есть у конкурента)

| Функция | Описание | Приоритет |
|---------|----------|-----------|
| Site Map Crawling | Обход всех ссылок для построения карты | 🔴 Высокий |
| Bulk Link Check | Проверка всех найденных ссылок без перехода | 🟡 Средний |
| UI Form Fuzzing | Автоматический fuzzing форм (пустые/случайные/некорректные данные) | 🔴 Высокий |
| Exhaustive Button Testing | Клик по всем кнопкам для проверки сбоев | 🟢 Низкий |

---

## 🏗️ Архитектура решения

### Новый режим тестирования: "Exploratory Mode"

```
Intelligent Mode (сейчас)        Exploratory Mode (новый)
├── AI выбирает действия         ├── Автоматический обход ВСЕХ элементов
├── Цель-ориентированный         ├── Полное покрытие без цели
├── Умные данные                 ├── Fuzzing данные
└── Адаптивный                   └── Exhaustive (исчерпывающий)
```

---

## 📦 Фаза 1: Site Map Crawling (Приоритет: 🔴 Высокий)

### Описание
Автоматический обход всех ссылок на сайте для построения карты страниц.

### Реализация

**1. Новый сервис:** `SiteCrawlerService`

```typescript
// src/services/testing/ui/exploratory/site-crawler.service.ts

export class SiteCrawlerService {
  /**
   * Crawl entire site starting from URL
   * Builds a complete site map with all discovered pages
   */
  async crawlSite(options: {
    startUrl: string;
    maxDepth: number; // Max link depth (default: 3)
    maxPages: number; // Max pages to crawl (default: 50)
    sameDomainOnly: boolean; // Only crawl same domain (default: true)
    respectRobotsTxt: boolean; // Respect robots.txt (default: true)
  }): Promise<SiteMap>;

  /**
   * Extract all links from a page
   */
  private async extractLinks(page: Page, currentUrl: string): Promise<Link[]>;

  /**
   * Check if link should be crawled
   */
  private shouldCrawlLink(link: string, options: CrawlOptions): boolean;

  /**
   * Build site map from crawled pages
   */
  private buildSiteMap(crawledPages: CrawledPage[]): SiteMap;
}
```

**2. Типы:**

```typescript
interface SiteMap {
  startUrl: string;
  totalPages: number;
  totalLinks: number;
  depth: number;
  pages: CrawledPage[];
  graph: {
    nodes: PageNode[];
    edges: PageEdge[];
  };
}

interface CrawledPage {
  url: string;
  depth: number; // Link depth from start
  statusCode: number;
  title: string;
  links: Link[];
  forms: number;
  buttons: number;
  errors: string[];
  responseTime: number;
}

interface Link {
  url: string;
  text: string;
  type: 'internal' | 'external';
  statusCode?: number; // From bulk check
  error?: string;
}
```

**3. Алгоритм (BFS):**

```
1. Start with startUrl (depth = 0)
2. Extract all links from page
3. Filter links:
   - Same domain only (if sameDomainOnly)
   - Not visited yet
   - Not in robots.txt disallow list
   - Valid HTTP/HTTPS URLs
4. Add links to queue with depth + 1
5. Visit each link in queue (BFS)
6. Repeat until:
   - Queue empty OR
   - maxDepth reached OR
   - maxPages crawled
7. Build site map graph
```

**4. Интеграция:**

```typescript
// В intelligent-test-orchestrator.ts

async executeCrawlMode(): Promise<SiteMap> {
  const siteMap = await SiteCrawlerService.crawlSite({
    startUrl: this.config.startUrl,
    maxDepth: 3,
    maxPages: 50,
    sameDomainOnly: true,
    respectRobotsTxt: true,
  });

  // Emit real-time graph updates
  this.emitSiteMapUpdate(siteMap);

  return siteMap;
}
```

**Оценка:**
- Время разработки: 6-8 часов
- Сложность: Средняя
- Файлы: 2 новых, 2 обновить

---

## 📦 Фаза 2: Bulk Link Validation (Приоритет: 🟡 Средний)

### Описание
Проверка всех найденных ссылок на доступность (404, 500 и т.д.) БЕЗ полного перехода.

### Реализация

**1. Новый сервис:** `LinkValidatorService`

```typescript
// src/services/testing/ui/exploratory/link-validator.service.ts

export class LinkValidatorService {
  /**
   * Validate all links in bulk (parallel HEAD requests)
   * Much faster than navigating to each page
   */
  async validateLinks(links: Link[]): Promise<LinkValidationResult[]>;

  /**
   * Check single link (HEAD request)
   */
  private async checkLink(link: Link): Promise<LinkValidationResult>;

  /**
   * Categorize links by status
   */
  categorizeLinks(results: LinkValidationResult[]): {
    working: Link[];
    broken: Link[];
    redirects: Link[];
    slow: Link[];
  };
}
```

**2. Типы:**

```typescript
interface LinkValidationResult {
  url: string;
  statusCode: number;
  responseTime: number;
  error?: string;
  redirectTo?: string;
  category: 'working' | 'broken' | 'redirect' | 'slow' | 'error';
}
```

**3. Алгоритм:**

```
1. Get all links from site map
2. Group by domain (to respect rate limits)
3. For each link (parallel, max 10 concurrent):
   a. Send HEAD request (faster than GET)
   b. Record status code
   c. Record response time
   d. Follow redirects (max 3)
4. Categorize results:
   - 200-299: working
   - 300-399: redirect
   - 400-499: broken (client error)
   - 500-599: broken (server error)
   - Timeout/DNS: error
   - > 3 seconds: slow
5. Return categorized results
```

**4. Интеграция:**

```typescript
// После crawling
const links = siteMap.pages.flatMap(p => p.links);
const validationResults = await LinkValidatorService.validateLinks(links);

const categorized = LinkValidatorService.categorizeLinks(validationResults);

logger.info('[LINK_VALIDATOR] Results', {
  total: links.length,
  working: categorized.working.length,
  broken: categorized.broken.length,
  redirects: categorized.redirects.length,
  slow: categorized.slow.length,
});
```

**Оценка:**
- Время разработки: 4-6 часов
- Сложность: Низкая-Средняя
- Файлы: 1 новый, 1 обновить

---

## 📦 Фаза 3: UI Form Fuzzing (Приоритет: 🔴 Высокий)

### Описание
Автоматическое тестирование форм с разными типами данных:
- Пустые формы (валидация required полей)
- Случайные данные ("test", "test@example.com")
- Некорректные данные (буквы в числовые поля, XSS, SQL injection)

### Реализация

**1. Новый сервис:** `FormFuzzerService`

```typescript
// src/services/testing/ui/exploratory/form-fuzzer.service.ts

export class FormFuzzerService {
  /**
   * Fuzz all forms on a page
   */
  async fuzzForms(page: Page, forms: DOMAnalysis['forms']): Promise<FormFuzzingResult[]>;

  /**
   * Generate fuzzing test cases for a form
   */
  private generateFuzzingCases(form: DOMAnalysis['forms'][0]): FormFuzzCase[];

  /**
   * Execute a fuzzing test case
   */
  private async executeFuzzCase(
    page: Page,
    form: DOMAnalysis['forms'][0],
    fuzzCase: FormFuzzCase
  ): Promise<FormFuzzResult>;
}
```

**2. Типы:**

```typescript
interface FormFuzzCase {
  name: string;
  type: 'empty' | 'random' | 'invalid' | 'boundary' | 'security';
  fieldValues: Record<string, string>;
  expectedBehavior: 'reject' | 'accept' | 'sanitize';
}

interface FormFuzzResult {
  formId: string;
  caseName: string;
  success: boolean;
  validationTriggered: boolean; // Did form show validation errors?
  submitted: boolean; // Was form submitted?
  errors: string[]; // JS errors
  screenshot?: string;
  findings: Finding[];
}

interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  type: 'validation_missing' | 'xss_vulnerable' | 'sql_injectable' | 'no_sanitization';
  description: string;
}
```

**3. Fuzzing Cases:**

```typescript
const FUZZING_CASES = {
  // 1. Empty form (should show validation)
  empty: {
    name: 'Empty Form Submission',
    type: 'empty',
    fieldValues: {}, // All fields empty
    expectedBehavior: 'reject',
  },

  // 2. Random valid data
  random: {
    name: 'Random Valid Data',
    type: 'random',
    fieldValues: {
      email: 'test@example.com',
      name: 'John Doe',
      phone: '+1234567890',
    },
    expectedBehavior: 'accept',
  },

  // 3. Invalid data types
  invalid: {
    name: 'Invalid Data Types',
    type: 'invalid',
    fieldValues: {
      email: 'not-an-email', // Invalid email
      number: 'abc', // Letters in number field
      phone: '123', // Too short phone
    },
    expectedBehavior: 'reject',
  },

  // 4. Boundary values
  boundary: {
    name: 'Boundary Values',
    type: 'boundary',
    fieldValues: {
      number: '-1', // Negative where positive expected
      string: 'A'.repeat(10000), // Very long string
      email: 'a'.repeat(256) + '@example.com', // Max length email
    },
    expectedBehavior: 'reject',
  },

  // 5. Security attacks
  security: {
    name: 'Security Attack Vectors',
    type: 'security',
    fieldValues: {
      text: '<script>alert("XSS")</script>', // XSS
      search: "' OR '1'='1", // SQL injection
      name: '../../etc/passwd', // Path traversal
    },
    expectedBehavior: 'sanitize', // Should escape/sanitize
  },
};
```

**4. Алгоритм:**

```
For each form on page:
  1. Generate fuzzing cases based on form fields
  2. For each fuzzing case:
     a. Fill form with test values
     b. Submit form
     c. Wait for response (validation/success)
     d. Check:
        - Did validation trigger? (for invalid cases)
        - Was form submitted? (for valid cases)
        - Any JS errors?
        - Did XSS execute? (for security cases)
        - Was SQL injection sanitized?
     e. Record findings
  3. Return aggregated results
```

**5. Интеграция:**

```typescript
// В intelligent-test-orchestrator.ts

async executeFuzzingMode(): Promise<FuzzingReport> {
  const context = await this.analyzePage();

  if (context.dom.forms.length === 0) {
    return { message: 'No forms found' };
  }

  const fuzzResults = await FormFuzzerService.fuzzForms(
    this.page,
    context.dom.forms
  );

  // Categorize findings by severity
  const critical = fuzzResults.flatMap(r =>
    r.findings.filter(f => f.severity === 'critical')
  );

  return {
    totalForms: context.dom.forms.length,
    totalCases: fuzzResults.length,
    findings: {
      critical: critical.length,
      high: ...,
      medium: ...,
      low: ...,
    },
    results: fuzzResults,
  };
}
```

**Оценка:**
- Время разработки: 8-12 часов
- Сложность: Средняя-Высокая
- Файлы: 1 новый, 2 обновить

---

## 📦 Фаза 4: Exhaustive Button Testing (Приоритет: 🟢 Низкий)

### Описание
Автоматический клик по всем кнопкам для проверки сбоев.

### Реализация

**1. Новый сервис:** `ButtonTesterService`

```typescript
// src/services/testing/ui/exploratory/button-tester.service.ts

export class ButtonTesterService {
  /**
   * Test all buttons on a page
   */
  async testAllButtons(page: Page, buttons: DOMAnalysis['buttons']): Promise<ButtonTestResult[]>;

  /**
   * Test single button
   */
  private async testButton(page: Page, button: DOMAnalysis['buttons'][0]): Promise<ButtonTestResult>;
}
```

**2. Типы:**

```typescript
interface ButtonTestResult {
  buttonText: string;
  selector: string;
  clickSucceeded: boolean;
  pageChanged: boolean;
  modalAppeared: boolean;
  jsErrors: string[];
  screenshot?: string;
}
```

**3. Алгоритм:**

```
For each button on page:
  1. Capture state before click
  2. Click button
  3. Wait for changes (max 3 seconds)
  4. Check:
     - Did button click succeed?
     - Did URL change?
     - Did modal appear?
     - Any JS errors?
     - Did page crash?
  5. Revert state (go back if URL changed)
  6. Record result
```

**Оценка:**
- Время разработки: 4-5 часов
- Сложность: Низкая
- Файлы: 1 новый, 1 обновить

---

## 🔀 Новый тип теста: "Exploratory Test"

### Режимы тестирования

```typescript
type TestMode =
  | 'intelligent'   // Текущий: AI-driven, goal-oriented
  | 'exploratory';  // Новый: Exhaustive, fuzzing-based

interface ExploratoryTestConfig {
  mode: 'exploratory';
  crawling: {
    enabled: boolean;
    maxDepth: number;
    maxPages: number;
  };
  linkValidation: {
    enabled: boolean;
    checkExternal: boolean;
  };
  formFuzzing: {
    enabled: boolean;
    includeSecurityTests: boolean;
  };
  buttonTesting: {
    enabled: boolean;
  };
}
```

### Пример использования

```typescript
const result = await executePlaywrightTest({
  url: 'https://example.com',
  mode: 'exploratory',
  config: {
    crawling: { enabled: true, maxDepth: 3, maxPages: 50 },
    linkValidation: { enabled: true, checkExternal: false },
    formFuzzing: { enabled: true, includeSecurityTests: true },
    buttonTesting: { enabled: true },
  },
});
```

---

## 📈 Итоговая оценка

| Фаза | Приоритет | Время | Сложность | Файлов |
|------|-----------|-------|-----------|--------|
| 1. Site Crawling | 🔴 Высокий | 6-8ч | Средняя | 4 |
| 2. Link Validation | 🟡 Средний | 4-6ч | Низкая-Средняя | 2 |
| 3. Form Fuzzing | 🔴 Высокий | 8-12ч | Средняя-Высокая | 3 |
| 4. Button Testing | 🟢 Низкий | 4-5ч | Низкая | 2 |
| **ИТОГО** | - | **22-31ч** | - | **11 файлов** |

---

## 🎯 Рекомендуемый порядок внедрения

### Спринт 1 (Crawling & Validation): 10-14 часов
1. ✅ Site Crawling (6-8ч) - фундамент для остальных фич
2. ✅ Link Validation (4-6ч) - дополняет crawling

**Результат:** Полная карта сайта + проверка всех ссылок

### Спринт 2 (Fuzzing): 8-12 часов
3. ✅ Form Fuzzing (8-12ч) - ключевая фича конкурента

**Результат:** Автоматическое тестирование форм

### Спринт 3 (Опционально): 4-5 часов
4. ✅ Button Testing (4-5ч) - nice-to-have

**Результат:** Полное покрытие UI элементов

---

## 🔧 Технические детали

### Новые файлы

```
src/services/testing/ui/exploratory/
├── site-crawler.service.ts          (NEW)
├── link-validator.service.ts        (NEW)
├── form-fuzzer.service.ts           (NEW)
├── button-tester.service.ts         (NEW)
└── README.md                        (NEW)

src/types/
└── exploratory-testing.types.ts     (NEW)

docs/development/
└── EXPLORATORY_MODE_GUIDE.md        (NEW)
```

### Обновить существующие

```
src/agent/
├── intelligent-test-orchestrator.ts  (UPDATE: add exploratory mode)
└── types/intelligent-testing.types.ts (UPDATE: add exploratory types)

src/api/playwright/
└── playwright.route.ts               (UPDATE: add exploratory endpoint)

src/services/testing/ui/
└── playwright.service.ts             (UPDATE: integrate exploratory mode)
```

---

## 💡 Дополнительные идеи

### 1. Visualize Site Map
- Создать граф-визуализацию сайта
- Показать broken links красным
- Показать slow links жёлтым

### 2. Export Reports
- Export crawling report to PDF
- Export link validation to CSV
- Export fuzzing findings to JSON

### 3. Comparison Mode
- Сравнить 2 версии сайта (staging vs production)
- Найти различия в ссылках
- Найти новые/удалённые страницы

---

## ❓ Вопросы для обсуждения

1. **Приоритеты:** Согласны ли вы с порядком внедрения?
2. **Scope:** Нужны ли все 4 фазы или только критичные (1 и 3)?
3. **Интеграция:** Сделать exploratory mode отдельным endpoint или частью intelligent mode?
4. **Безопасность:** Включать ли security fuzzing (XSS, SQL injection) по умолчанию?
5. **Performance:** Какие лимиты установить (maxPages, maxDepth, timeout)?

---

## 📝 Следующие шаги

1. **Обсудить план** с командой/заказчиком
2. **Уточнить приоритеты** (все фазы или только 1 и 3?)
3. **Начать с Фазы 1** (Site Crawling) - фундамент для остальных
4. **Итеративно добавлять** остальные фазы

---

**Дата последнего обновления:** 2024-11-27
