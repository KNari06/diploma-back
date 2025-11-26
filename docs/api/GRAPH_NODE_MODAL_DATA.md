# Graph Node Modal - Rich Data Display

## Overview

При клике на ноду графа, фронтенд может отобразить детальную информацию о каждом шаге теста, включая скриншоты, DOM, логи, и другие метаданные.

---

## 🎯 Данные доступные в каждой ноде

### 1. **Start Node** (Начало теста)

```typescript
{
  id: "node_1",
  type: "start",
  label: "Test Started",
  meta: {
    icon: "▶️",
    color: "#4CAF50",
    timestamp: 1732608900000
  }
}
```

**Что показать:**
- Время начала теста
- Цель теста (goal)
- Стартовый URL
- Конфигурация браузера

---

### 2. **Page Node** (Навигация на новую страницу)

```typescript
{
  id: "node_2",
  type: "action",
  stepType: "goto",
  label: "Navigate to https://example.com/login",
  value: "https://example.com/login",
  meta: {
    icon: "🌐",
    color: "#673AB7",
    pageType: "login",
    timestamp: 1732608905000,
    elapsedTime: 5000,

    // ✅ Скриншот страницы (публичный URL после загрузки в storage)
    screenshot: "https://storage.supabase.co/.../screenshot-123.png",

    // ✅ Анализ страницы
    pageAnalysis: {
      title: "Login Page",
      metaDescription: "Sign in to your account",
      formsCount: 1,
      buttonsCount: 3,
      linksCount: 10,
      inputsCount: 2,
      loadTime: 1200
    },

    networkRequests: 15
  }
}
```

**Что показать:**
- 📸 **Screenshot**: Скриншот страницы (`meta.screenshot` - публичный URL)
- 📊 **Page Stats**:
  - Заголовок: `pageAnalysis.title`
  - Кол-во форм: `pageAnalysis.formsCount`
  - Кол-во кнопок: `pageAnalysis.buttonsCount`
  - Время загрузки: `pageAnalysis.loadTime`ms
- 🌐 **Network**: `meta.networkRequests` запросов

---

### 3. **Action Node** (Действие на странице)

#### **Success Case:**

```typescript
{
  id: "node_3",
  type: "action",
  stepType: "fill",
  label: "Fill email field",
  selector: "input[name='email']",
  value: "user@example.com",
  meta: {
    icon: "✏️",
    color: "#2196F3",
    success: true,
    durationMs: 250,
    timestamp: 1732608910000,
    elapsedTime: 10000,

    // URL tracking
    urlBefore: "https://example.com/login",
    urlAfter: "https://example.com/login",
    urlChanged: false,

    // ✅ Screenshots ДО и ПОСЛЕ (публичные URL после загрузки в storage)
    screenshotBefore: "https://storage.supabase.co/.../screenshot-before-123.png",
    screenshotAfter: "https://storage.supabase.co/.../screenshot-after-123.png",

    // ✅ Validation result
    validation: {
      expected: "Input should contain 'user@example.com'",
      actual: "Input value: 'user@example.com'",
      passed: true,
      message: "Value successfully filled"
    },

    retryCount: 0,
    isRepeated: false,
    isTimeout: false
  }
}
```

**Что показать:**
- 📸 **Before/After Comparison**:
  - Слева: `meta.screenshotBefore` (публичный URL)
  - Справа: `meta.screenshotAfter` (публичный URL)
  - Можно использовать image slider для сравнения
- ✅ **Validation**:
  - Expected: `validation.expected`
  - Actual: `validation.actual`
  - Status: ✅ Passed / ❌ Failed
- ⏱️ **Timing**: `meta.durationMs`ms
- 🎯 **Action Details**:
  - Selector: `node.selector`
  - Value: `node.value`
  - Success: `meta.success`

---

#### **Failed Case:**

```typescript
{
  id: "node_4",
  type: "action",
  stepType: "click",
  label: "Click submit button ❌",
  selector: "button[type='submit']",
  meta: {
    icon: "🖱️",
    color: "#F44336", // Red for failed
    success: false,
    errorMessage: "Element not found or not visible: button[type='submit']",
    durationMs: 5000,
    timestamp: 1732608915000,

    // ✅ Screenshot момента ошибки (публичный URL)
    screenshot: "https://storage.supabase.co/.../screenshot-error-123.png",

    // ✅ Console logs в момент ошибки
    consoleLogs: [
      {
        type: "error",
        message: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        timestamp: "2024-11-26T08:15:13Z",
        source: "network"
      }
    ],

    // ✅ Network errors
    networkErrors: [
      {
        url: "https://example.com/api/submit",
        status: 500,
        error: "Internal Server Error",
        timestamp: "2024-11-26T08:15:14Z"
      }
    ],

    // ✅ DOM snapshot в момент ошибки
    domSnapshot: "<html>...</html>",

    retryCount: 3,
    isTimeout: true
  }
}
```

**Что показать:**
- ❌ **Error Details**:
  - Message: `meta.errorMessage`
  - Retry attempts: `meta.retryCount`
  - Timeout: `meta.isTimeout` ? "⏱️ Timeout" : ""
- 📸 **Error Screenshot**: `meta.screenshot` (публичный URL)
- 🔴 **Console Logs**:
  ```
  [ERROR] Failed to load resource: net::ERR_CONNECTION_REFUSED
  Source: network
  Time: 08:15:13
  ```
- 🌐 **Network Errors**:
  ```
  POST /api/submit → 500 Internal Server Error
  ```
- 🗂️ **DOM Snapshot**: Можно показать в expandable accordion

---

### 4. **End Node** (Завершение теста)

```typescript
{
  id: "node_15",
  type: "end",
  label: "Test Completed ✅",
  meta: {
    icon: "✅",
    color: "#4CAF50",
    success: true,
    summary: "Test completed successfully. 5 pages visited, 12 actions taken.",
    timestamp: 1732609065000,

    // ✅ Test statistics
    testSummary: {
      pagesVisited: 5,
      actionsTaken: 12,
      successRate: "100%",
      duration: "2m 45s",
      cost: "$0.003"
    },

    // ✅ Final screenshot (публичный URL)
    screenshot: "https://storage.supabase.co/.../screenshot-final-123.png"
  }
}
```

**Что показать:**
- 📊 **Test Summary**:
  - Pages visited: `testSummary.pagesVisited`
  - Actions taken: `testSummary.actionsTaken`
  - Success rate: `testSummary.successRate`
  - Duration: `testSummary.duration`
  - Cost: `testSummary.cost`
- 📸 **Final Screenshot**: `meta.screenshot` (публичный URL)
- ✅ **Summary**: `meta.summary`

---

## 🎨 UI Component Example

```jsx
import { useState } from 'react';
import { GraphNode } from './types';

interface NodeModalProps {
  node: GraphNode;
  onClose: () => void;
}

export function NodeDetailModal({ node, onClose }: NodeModalProps) {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <Modal open onClose={onClose} size="xl">
      {/* Header */}
      <ModalHeader>
        <Icon type={node.meta?.icon} />
        <Title>{node.label}</Title>
        <Badge success={node.meta?.success} />
      </ModalHeader>

      {/* Tabs */}
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tab value="overview">Overview</Tab>
        {node.meta?.screenshotBefore && <Tab value="screenshots">Screenshots</Tab>}
        {node.meta?.validation && <Tab value="validation">Validation</Tab>}
        {node.meta?.consoleLogs && <Tab value="console">Console</Tab>}
        {node.meta?.networkErrors && <Tab value="network">Network</Tab>}
        {node.meta?.domSnapshot && <Tab value="dom">DOM</Tab>}
      </Tabs>

      {/* Content */}
      <ModalBody>
        {activeTab === 'overview' && (
          <OverviewTab node={node} />
        )}

        {activeTab === 'screenshots' && (
          <ScreenshotsTab
            before={node.meta.screenshotBefore}
            after={node.meta.screenshotAfter}
          />
        )}

        {activeTab === 'validation' && (
          <ValidationTab validation={node.meta.validation} />
        )}

        {activeTab === 'console' && (
          <ConsoleTab logs={node.meta.consoleLogs} />
        )}

        {activeTab === 'network' && (
          <NetworkTab errors={node.meta.networkErrors} />
        )}

        {activeTab === 'dom' && (
          <DOMViewer html={node.meta.domSnapshot} />
        )}
      </ModalBody>
    </Modal>
  );
}
```

---

## 📦 API Response Structure

Когда фронтенд получает граф через:
- **WebSocket** (`test:graph-update` event) - скриншоты могут быть base64 (во время выполнения)
- **REST API** (`GET /api/v1/test-visualization/{testId}`) - скриншоты всегда публичные URL

**Важно:** После завершения теста все base64 скриншоты автоматически загружаются в Supabase Storage и заменяются на публичные URL в `graph_data`.

Структура одинаковая:

```json
{
  "nodes": [
    {
      "id": "node_1",
      "type": "start",
      "label": "Test Started",
      "meta": { ... }
    },
    {
      "id": "node_2",
      "type": "action",
      "stepType": "goto",
      "label": "Navigate to...",
      "value": "https://...",
      "selector": null,
      "meta": {
        "screenshot": "https://storage.supabase.co/.../screenshot-123.png",
        "pageAnalysis": { ... },
        ...
      }
    },
    {
      "id": "node_3",
      "type": "action",
      "stepType": "fill",
      "label": "Fill email",
      "selector": "input[name='email']",
      "value": "user@example.com",
      "meta": {
        "screenshotBefore": "https://storage.supabase.co/.../screenshot-before-123.png",
        "screenshotAfter": "https://storage.supabase.co/.../screenshot-after-123.png",
        "validation": { ... },
        ...
      }
    }
  ],
  "edges": [ ... ],
  "metadata": {
    "totalNodes": 15,
    "totalEdges": 14,
    "generatedAt": "2024-11-26T08:17:45Z",
    "version": "1.0"
  }
}
```

---

## ✅ Готово!

Теперь каждая нода содержит богатые метаданные для детального отображения в модале на фронтенде.
