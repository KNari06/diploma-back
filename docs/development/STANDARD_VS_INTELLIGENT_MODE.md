# Standard Mode vs Intelligent Mode

## 📊 Основные различия

### Standard Mode (Стандартный режим)

**Что это:**
- Выполнение **предопределенных команд** (Playwright commands)
- Команды создаются **до** запуска теста (AI или пользователь)
- Тест выполняет команды **последовательно**, как скрипт

**Когда используется:**
- ✅ Есть `commands` (массив команд)
- ✅ Нужно выполнить конкретные действия
- ✅ Тест должен быть **детерминированным** (одинаковый результат каждый раз)

**Как работает:**
```
1. Получить commands из testPlan
2. CommandExecutor.executeCommands(commands)
3. Выполнить каждую команду последовательно:
   - goto(url)
   - fill(selector, value)
   - click(selector)
   - ...
4. Собрать результаты
```

---

### Intelligent Mode (Интеллектуальный режим)

**Что это:**
- **AI-driven автономное тестирование**
- AI **анализирует страницу** и **генерирует действия динамически**
- Тест **адаптируется** к изменениям на странице

**Когда используется:**
- ✅ Нет `commands` (или пустой массив)
- ✅ Есть `intelligentMode: true` И `testGoal`
- ✅ Нужно **автономное исследование** сайта

**Как работает:**
```
1. IntelligentTestOrchestrator.execute()
2. Цикл (пока не достигнута цель):
   a. analyzePage() → AI анализирует текущую страницу
      - Vision AI (скриншот)
      - DOM анализ
      - Извлечение элементов

   b. generateActions() → AI генерирует действия
      - На основе цели (testGoal)
      - На основе контекста страницы
      - На основе истории действий

   c. executeActions() → Выполнение действий
      - CommandExecutor для каждого действия
      - Валидация результатов

   d. decideNextStep() → AI решает что делать дальше
      - Продолжить?
      - Остановиться?
      - Попробовать другой путь?

   e. Повторить с новой страницей
```

---

## 🔍 Детальное сравнение

| Параметр | Standard Mode | Intelligent Mode |
|----------|---------------|------------------|
| **Входные данные** | `commands: [...]` | `testGoal: "..."` |
| **Исполнитель** | `CommandExecutor` | `IntelligentTestOrchestrator` |
| **Генерация действий** | ❌ До запуска (статично) | ✅ Во время выполнения (динамично) |
| **Анализ страницы** | ❌ Нет | ✅ Vision AI + DOM анализ |
| **Адаптация** | ❌ Нет (фиксированный скрипт) | ✅ Да (AI адаптируется) |
| **Self-healing** | ✅ Да (для селекторов) | ✅ Да (полный) |
| **Стоимость** | 💰 1 кредит | 💰 20 кредитов |
| **Скорость** | ⚡ Быстро (детерминированно) | 🐢 Медленнее (AI анализ) |
| **Гибкость** | ❌ Низкая | ✅ Высокая |
| **Покрытие** | 📝 Только заданные действия | 🌐 Полное исследование |

---

## 💻 Примеры кода

### Standard Mode

**Создание теста:**
```typescript
POST /api/v1/manual-test/run
{
  url: "https://example.com",
  browsers: ["chrome"],
  projectId: "...",
  intelligentMode: false,  // ← Standard Mode
  commands: [             // ← Команды предопределены
    {
      action: "goto",
      url: "https://example.com"
    },
    {
      action: "fill",
      selector: "input[name='email']",
      value: "test@example.com"
    },
    {
      action: "click",
      selector: "button[type='submit']"
    }
  ]
}
```

**Выполнение:**
```typescript
// playwright.service.ts
if (hasCommands) {
  const executor = new CommandExecutor(page);
  await executor.executeCommands(commands);
  // Выполняет команды последовательно
}
```

---

### Intelligent Mode

**Создание теста:**
```typescript
POST /api/v1/manual-test/run
{
  url: "https://example.com",
  browsers: ["chrome"],
  projectId: "...",
  intelligentMode: true,   // ← Intelligent Mode
  testGoal: "Test login flow",  // ← Цель для AI
  commands: []             // ← Нет команд (AI создаст)
}
```

**Выполнение:**
```typescript
// playwright.service.ts
if (hasIntelligentGoal && !hasCommands) {
  const orchestrator = new IntelligentTestOrchestrator(config, userId, testId);
  await orchestrator.execute(browser, page);

  // Внутри orchestrator:
  // 1. analyzePage() → Vision AI + DOM
  // 2. generateActions() → AI создает действия
  // 3. executeActions() → Выполняет
  // 4. decideNextStep() → AI решает что дальше
  // 5. Повторяет цикл
}
```

---

## 🎯 Когда использовать какой режим?

### Используй Standard Mode если:

✅ **Нужен детерминированный тест**
- Тест должен выполняться одинаково каждый раз
- Нужны конкретные проверки

✅ **Есть готовые команды**
- Команды уже сгенерированы (AI или пользователь)
- Нужно просто выполнить их

✅ **Быстрое выполнение**
- Нужен быстрый результат
- Не нужен AI анализ

✅ **Низкая стоимость**
- 1 кредит vs 20 кредитов

**Примеры:**
- Регрессионные тесты
- Smoke тесты
- Конкретные user flows
- API тесты с UI

---

### Используй Intelligent Mode если:

✅ **Нужно автономное исследование**
- AI должен сам найти элементы
- Адаптироваться к изменениям

✅ **Нет готовых команд**
- Не знаешь структуру сайта
- Нужно исследовать новый сайт

✅ **Динамический контент**
- Страница меняется динамически
- Нужна адаптация к изменениям

✅ **Широкое покрытие**
- Нужно протестировать весь сайт
- Найти все возможные проблемы

**Примеры:**
- Исследование нового сайта
- E2E тестирование всего flow
- Поиск багов автоматически
- Тестирование после редизайна

---

## 🔄 Workflow сравнение

### Standard Mode Workflow:

```
User/AI создает commands
    ↓
Test запускается
    ↓
CommandExecutor.executeCommands(commands)
    ↓
Выполняет команды последовательно:
  - goto(url) ✅
  - fill(selector, value) ✅
  - click(selector) ✅
    ↓
Собирает результаты
    ↓
Тест завершен
```

**Время:** ~30-60 секунд
**Стоимость:** 1 кредит

---

### Intelligent Mode Workflow:

```
User задает testGoal
    ↓
Test запускается
    ↓
IntelligentTestOrchestrator.execute()
    ↓
ЦИКЛ (пока не достигнута цель):
  ├─ analyzePage()
  │   ├─ Vision AI (скриншот) → GPT-4o Vision
  │   ├─ DOM анализ → GPT-4o-mini
  │   └─ Извлечение элементов
  │
  ├─ generateActions()
  │   └─ AI создает действия на основе:
  │       - Цели (testGoal)
  │       - Контекста страницы
  │       - Истории действий
  │
  ├─ executeActions()
  │   └─ CommandExecutor для каждого действия
  │
  ├─ validateResults()
  │   └─ Проверка результатов
  │
  └─ decideNextStep()
      └─ AI решает: продолжить/остановиться/другой путь
    ↓
Повторяет цикл для новой страницы
    ↓
Тест завершен (цель достигнута или лимиты)
```

**Время:** ~2-5 минут
**Стоимость:** 20 кредитов

---

## 🧠 AI компоненты

### Standard Mode:
- ✅ **Self-healing** (только для селекторов)
  - Если селектор не найден → AI пытается найти альтернативу
  - Но действия **не меняются**

### Intelligent Mode:
- ✅ **Vision AI** (GPT-4o Vision)
  - Анализирует скриншоты
  - Понимает визуальный контекст

- ✅ **DOM Analysis** (GPT-4o-mini)
  - Анализирует структуру DOM
  - Находит интерактивные элементы

- ✅ **Action Generation** (GPT-4o-mini)
  - Генерирует действия динамически
  - Учитывает контекст и цель

- ✅ **Decision Making** (GPT-4o-mini)
  - Решает что делать дальше
  - Адаптируется к изменениям

- ✅ **Self-healing** (полный)
  - Не только селекторы
  - Но и действия, стратегия

---

## 📊 Примеры результатов

### Standard Mode результат:

```json
{
  "success": true,
  "status": "completed",
  "screenshot": "base64...",
  "dom": "<html>...</html>",
  "logs": ["Command 1 executed", "Command 2 executed"],
  "errors": [],
  "performance": {
    "duration": 45000
  }
}
```

**Что видно:**
- ✅ Все команды выполнены
- ✅ Результаты каждой команды
- ❌ Нет информации о других элементах на странице

---

### Intelligent Mode результат:

```json
{
  "success": true,
  "goal": "Test login flow",
  "pagesVisited": 5,
  "actionsTaken": 23,
  "duration": 180000,
  "cost": 0.15,
  "summary": "Successfully tested login flow...",
  "pageVisits": [
    {
      "url": "https://example.com",
      "pageType": "home",
      "actions": [...],
      "success": true
    },
    {
      "url": "https://example.com/login",
      "pageType": "login",
      "actions": [...],
      "success": true
    }
  ],
  "graphData": {
    "nodes": [...],
    "edges": [...]
  }
}
```

**Что видно:**
- ✅ Все страницы, которые посетил AI
- ✅ Все действия, которые выполнил
- ✅ Граф навигации
- ✅ Стоимость теста
- ✅ Детальный анализ каждой страницы

---

## 🎯 Итоговая таблица

| | Standard Mode | Intelligent Mode |
|---|---|---|
| **Вход** | Commands (массив) | TestGoal (строка) |
| **Исполнитель** | CommandExecutor | IntelligentTestOrchestrator |
| **AI используется** | Только self-healing | Полный AI pipeline |
| **Адаптация** | ❌ Нет | ✅ Да |
| **Скорость** | ⚡ Быстро | 🐢 Медленнее |
| **Стоимость** | 💰 1 кредит | 💰 20 кредитов |
| **Покрытие** | 📝 Только заданные действия | 🌐 Полное исследование |
| **Детерминированность** | ✅ Да (одинаково каждый раз) | ❌ Нет (может быть разным) |
| **Когда использовать** | Регрессия, конкретные тесты | Исследование, E2E, новые сайты |

---

## ✅ Вывод

**Standard Mode** = **Скрипт** (выполняет заданные команды)
**Intelligent Mode** = **AI агент** (сам исследует и тестирует)

**Выбор зависит от задачи:**
- Нужен быстрый детерминированный тест? → **Standard Mode**
- Нужно автономное исследование? → **Intelligent Mode**
