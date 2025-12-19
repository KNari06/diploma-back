# WebSocket `test:graph-update` - Данные при каждом action

## 📋 Структура payload

При каждом action через WebSocket `test:graph-update` передается:

```typescript
{
  testId: string,
  type: 'incremental', // или 'full' (начало/конец теста)
  data: {
    newNode: GraphNode,    // Новый узел действия
    newEdge: GraphEdge,   // Ребро, соединяющее узлы
  },
  timestamp: string       // ISO timestamp
}
```

## 📊 Структура newNode (при каждом action)

```typescript
{
  id: string,                    // "node_1", "node_2", etc.
  type: "action",                 // "start" | "end" | "action" | "assertion"
  stepType: "click",              // "goto" | "click" | "fill" | "wait" | etc.
  label: string,                  // "Click Login Button"
  selector?: string,              // "button.login"
  value?: any,                    // Значение (для fill, select)

  meta: {
    // Visual
    icon: string,                 // "👆", "✏️", "🌐"
    color: string,                // "#03A9F4", "#F44336", etc.

    // Execution result
    success: boolean,             // true | false
    durationMs: number,           // 340
    errorMessage?: string,        // "Selector not found"

    // URL tracking
    urlChanged: boolean,          // true | false
    urlBefore?: string,            // "https://example.com"
    urlAfter?: string,            // "https://example.com/login"

    // Timing
    timestamp: number,            // 1732608900000
    elapsedTime: number,          // 5000 (ms с начала теста)

    // Retry/Timeout info
    retryCount?: number,          // 2 (если был retry)
    isTimeout: boolean,           // true | false
    isRepeated: boolean,         // true | false
    warning?: string,            // "Action repeated - possible cycle"

    // Validation
    validation?: {
      expected: string,
      actual: string,
      passed: boolean,
      message?: string
    },

    // ❌ НЕ передаются в newNode (слишком большие):
    // screenshotBefore: undefined (придет позже в updatedNode как URL)
    // screenshotAfter: undefined (придет позже в updatedNode как URL)
    // domSnapshot: undefined
    // consoleLogs: undefined
    // networkRequests: undefined
    // networkErrors: undefined
  }
}
```

## 📊 Структура newEdge

```typescript
{
  id: string,                    // "edge_1", "edge_2", etc.
  source: string,                 // "node_1" (id предыдущего узла)
  target: string,                // "node_2" (id текущего узла)
  type: "normal",
  meta: {
    animated: boolean            // false
  }
}
```

## 🎯 Пример payload

```json
{
  "testId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "incremental",
  "data": {
    "newNode": {
      "id": "node_5",
      "type": "action",
      "stepType": "click",
      "label": "Click Login Button",
      "selector": "button.login",
      "meta": {
        "icon": "👆",
        "color": "#03A9F4",
        "success": true,
        "durationMs": 340,
        "urlChanged": false,
        "urlBefore": "https://example.com",
        "urlAfter": "https://example.com",
        "timestamp": 1732608900000,
        "elapsedTime": 10000,
        "retryCount": 0,
        "isTimeout": false,
        "isRepeated": false,
        "validation": {
          "expected": "Button should be clicked",
          "actual": "Button clicked successfully",
          "passed": true
        }
      }
    },
    "newEdge": {
      "id": "edge_4",
      "source": "node_4",
      "target": "node_5",
      "type": "normal",
      "meta": {
        "animated": false
      }
    }
  },
  "timestamp": "2024-11-26T08:15:00.000Z"
}
```

## ⚠️ Что НЕ передается через WebSocket

Следующие поля **НЕ передаются** через WebSocket (слишком большие):

- ❌ `screenshotBefore` - скриншот до действия
- ❌ `screenshotAfter` - скриншот после действия
- ❌ `domSnapshot` - HTML snapshot страницы
- ❌ `consoleLogs` - логи консоли браузера
- ❌ `networkRequests` - количество сетевых запросов
- ❌ `networkErrors` - ошибки сети

Эти данные доступны **только** через REST API после завершения теста:

```
GET /api/v1/test-visualization/{testId}
```

## 🔄 Типы обновлений

### `incremental` (каждое действие)

- `newNode` - новый узел действия (БЕЗ скриншотов)
- `newEdge` - новое ребро
- `updatedNode` - обновление существующего узла (например, с URL скриншотов после загрузки)

### `full` (начало/конец теста)

- `fullGraph` - полный граф со всеми узлами и ребрами
- `metadata` - статистика теста
