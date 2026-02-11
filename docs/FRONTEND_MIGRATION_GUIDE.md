# Frontend Migration Guide: Suite Removal

## 🎯 Основные изменения

### Старая иерархия (удалена):

```
Platform → Module → Suite (Default) → Flow → TestCase
```

### Новая иерархия:

```
Platform → Module → Flow → TestCase
```

**Удалён промежуточный уровень Suite** — теперь Flow создаётся напрямую в Module.

---

## 🔥 Breaking Changes для Frontend

### 1. API Endpoints

#### ❌ Удалены:

- `POST /api/v1/regression/suites` — создание suite
- `GET /api/v1/regression/suites` — список suites
- `GET /api/v1/platforms/tree?suiteId=...` — suite mode

#### ✅ Изменены:

**Создание Flow:**

```diff
- POST /api/v1/flows
- Body: { suiteId: "uuid", name: "..." }

+ POST /api/v1/flows
+ Body: { moduleId: "uuid", name: "..." }
```

**Список Flows:**

```diff
- GET /api/v1/flows?suiteId=uuid

+ GET /api/v1/flows?moduleId=uuid
```

**Reorder Flows:**

```diff
- POST /api/v1/flows/reorder
- Body: { suiteId: "uuid", flowIds: [...] }

+ POST /api/v1/flows/reorder
+ Body: { moduleId: "uuid", flowIds: [...] }
```

**Platform Tree (3 режима вместо 4):**

```javascript
// Base mode - список platforms с modules
GET /api/v1/platforms/tree?projectId=uuid
// Response: { platforms: [{ id, name, modules: { items: [...], pageInfo } }] }

// Module mode - показать flows в модуле
GET /api/v1/platforms/tree?moduleId=uuid
// Response: { module: {...}, flows: { items: [...], pageInfo } }

// Flow mode - показать test cases в flow
GET /api/v1/platforms/tree?flowId=uuid
// Response: { flow: {...}, testCases: { items: [...], pageInfo } }
```

---

## 📱 UI/UX Changes

### Navigation Tree (левая панель)

**Старая структура:**

```
📁 Web UI Platform
  📂 Auth Module
    📋 Default (suite) ← УДАЛИТЬ
      🔄 Login Flow
      🔄 Logout Flow
  📂 Payments Module
    📋 Default (suite) ← УДАЛИТЬ
      🔄 Checkout Flow
```

**Новая структура:**

```
📁 Web UI Platform
  📂 Auth Module
    🔄 Login Flow     ← теперь напрямую в модуле
    🔄 Logout Flow
  📂 Payments Module
    🔄 Checkout Flow
```

**Что делать:**

1. Убрать уровень "Default" или любых других suites из дерева
2. Flows теперь дети Module (не Suite)
3. Клик на Module → показать список Flows
4. Breadcrumbs: `Platform > Module > Flow` (без Suite)

---

### Create Flow Dialog

**Что изменить:**

```diff
- Поле: "Select Suite" (dropdown)
+ Поле: "Select Module" (dropdown)

- placeholder: "Choose or create suite"
+ placeholder: "Choose module"

- API: POST /flows { suiteId: ... }
+ API: POST /flows { moduleId: ... }
```

**Автосоздание test case:**

- Как и раньше, при `moduleId` + `baseUrl` → автоматически создаётся 1 test case
- Логика не изменилась

---

### Regression Plans

**Старый itemType enum:**

```typescript
type PlanItemType = "module" | "suite" | "flow" | "test_case";
```

**Новый itemType enum:**

```typescript
type PlanItemType = "module" | "flow" | "test_case";
```

**UI изменения:**

- В форме "Add to Plan" убрать опцию "Suite"
- Можно добавлять: Module, Flow, или отдельный Test Case
- Показ плана: убрать иконку/бейдж "Suite"

---

### Git Integrations

```diff
- Field: suiteId
+ Field: используйте moduleId или planId
```

**Schedule Form:**

```diff
- Target options: [Module, Suite, Plan]
+ Target options: [Module, Plan]
```

---

## 🆕 Новая фича: Shared Steps

### Что это:

Возможность переиспользовать шаги одного test case внутри другого.

### Пример:

```
Test Case "Login" (id: abc-123):
1. Navigate to /login
2. Fill email
3. Fill password
4. Click Submit

Test Case "Checkout":
1. ← Shared Steps: "Login" (abc-123)    ← автоматически вставит шаги 1-4
2. Navigate to /checkout
3. Click "Buy Now"
```

### UI для этого (будущая задача):

**Command Builder:**

- Добавить новый тип команды: `shared_steps`
- Dropdown: выбор test case из текущего проекта
- Поле description (опционально)

**При сохранении:**

```json
{
  "action": "shared_steps",
  "test_case_id": "uuid-of-login-test",
  "description": "Login flow"
}
```

**Preview/Expand:**

- Кнопка "Preview expanded" — показать все команды после раскрытия
- API: `GET /api/v1/regression/test-cases/:id/commands`
- Response: `{ commands: [...], parametersSchema, name }`

---

## 🔄 Типы (TypeScript)

### Обновить интерфейсы:

```diff
interface TestFlow {
  id: string;
- suiteId: string;
+ moduleId: string;
  name: string;
  flowType: 'ui' | 'api' | 'mixed';
  ...
}

interface RegressionPlanItem {
  itemType: 'module' | 'flow' | 'test_case';
- suiteId?: string;  // удалить
  moduleId?: string;
  flowId?: string;
  testCaseId?: string;
}

interface CreateFlowRequest {
- suiteId?: string;  // удалить
+ moduleId: string;   // обязательный
  name: string;
  flowType?: 'ui' | 'api' | 'mixed';
  baseUrl?: string;
}

- type FixtureScope = 'global' | 'project' | 'module' | 'suite' | 'flow';
+ type FixtureScope = 'global' | 'project' | 'module' | 'flow';

- type EntityType = 'test_run' | 'saved_case' | 'suite';
+ type EntityType = 'test_run' | 'saved_case' | 'module';
```

---

## ✅ Чеклист миграции Frontend

### Обязательно (блокирует работу):

- [ ] Убрать suite уровень из Navigation Tree
- [ ] Create Flow: заменить `suiteId` → `moduleId`
- [ ] List Flows: изменить query param `?suiteId=` → `?moduleId=`
- [ ] Platform Tree API: убрать suite mode, обновить типы
- [ ] Regression Plans: убрать `'suite'` из `itemType` enum
- [ ] Reorder Flows: заменить `suiteId` → `moduleId`
- [ ] TypeScript типы: удалить все `suiteId` поля

### Рекомендуется (UX улучшение):

- [ ] Breadcrumbs: убрать suite из пути
- [ ] Git Integration form: убрать suite target
- [ ] Schedule form: убрать suite target
- [ ] Fixtures: убрать `'suite'` из scope dropdown
- [ ] Удалить все упоминания "Suite" из UI текстов

### Будущая фича (не срочно):

- [ ] UI для Shared Steps в Command Builder
- [ ] Preview expanded commands API integration

---

## 🆘 Если что-то сломалось

### 404 на старых endpoints:

- Проверьте, нет ли `POST /regression/suites` — замените на `POST /flows` с `moduleId`
- Проверьте `GET /platforms/tree?suiteId=...` — используйте `moduleId`

### "module_id is required":

- Убедитесь, что передаёте `moduleId` вместо `suiteId` в CREATE/UPDATE запросах

### Пустое дерево в UI:

- Проверьте, что запрашиваете `moduleId` в query params (не `suiteId`)
- Убедитесь, что миграция SQL выполнена на сервере

---
