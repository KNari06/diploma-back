# WebSocket API Documentation

Real-time communication для QAI Backend через Socket.IO.

## 📡 Connection

### Endpoint
```
ws://localhost:3000
```

### Authentication

Подключение с JWT токеном:

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: {
    token: 'your-jwt-token-here'
  }
});
```

Анонимное подключение (без токена):

```typescript
const socket = io('http://localhost:3000');
```

### Connection Events

```typescript
// Успешное подключение
socket.on('connect', () => {
  console.log('Connected:', socket.id);
});

// Аутентификация подтверждена
socket.on('authenticated', (data) => {
  console.log('Authenticated:', data);
  // data: { userId, isAnonymous, timestamp }
});

// Ошибка подключения
socket.on('error', (data) => {
  console.error('Error:', data);
  // data: { code, message, timestamp }
});

// Отключение
socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});
```

---

## 🔔 Subscriptions

### Subscribe to Test Updates

```typescript
// Подписка на обновления теста
socket.emit('subscribe:test', { testId: 'test-uuid' });

// Отписка
socket.emit('unsubscribe:test', { testId: 'test-uuid' });
```

### Subscribe to Chat Updates

```typescript
// Подписка на обновления чата
socket.emit('subscribe:chat', { sessionId: 'session-uuid' });

// Отписка
socket.emit('unsubscribe:chat', { sessionId: 'session-uuid' });
```

---

## 🧪 Test Events

### test:created
Тест создан и добавлен в очередь.

```typescript
socket.on('test:created', (data) => {
  console.log('Test created:', data);
});

// Payload:
{
  testId: string,
  url: string,
  browsers: string[],
  userId?: string,
  timestamp: string
}
```

### test:started
Тест начал выполняться в браузере.

```typescript
socket.on('test:started', (data) => {
  console.log('Test started:', data);
});

// Payload:
{
  testId: string,
  browser: string,
  timestamp: string
}
```

### test:progress
Прогресс выполнения теста (0-100%).

```typescript
socket.on('test:progress', (data) => {
  console.log(`Progress: ${data.progress}%`);
  updateProgressBar(data.progress);
});

// Payload:
{
  testId: string,
  browser: string,
  progress: number,        // 0-100
  currentStep?: string,
  totalSteps?: number,
  completedSteps?: number,
  timestamp: string
}
```

### test:step:completed
Один шаг теста завершен.

```typescript
socket.on('test:step:completed', (data) => {
  console.log(`Step ${data.step} completed:`, data.stepDescription);
});

// Payload:
{
  testId: string,
  browser: string,
  step: number,
  stepDescription: string,
  success: boolean,
  timestamp: string
}
```

### test:browser:completed
Тест завершен в одном браузере.

```typescript
socket.on('test:browser:completed', (data) => {
  console.log(`Browser ${data.browser} completed:`, data.status);
});

// Payload:
{
  testId: string,
  browser: string,
  status: 'completed' | 'failed',
  duration?: number,
  errorsCount?: number,
  timestamp: string
}
```

### test:completed
Весь тест полностью завершен (все браузеры).

```typescript
socket.on('test:completed', (data) => {
  console.log('Test completed!', data);
  showResults(data);
});

// Payload:
{
  testId: string,
  status: 'completed',
  totalBrowsers: number,
  completedBrowsers: number,
  failedBrowsers: number,
  duration?: number,
  summary?: {
    totalBugs: number,
    criticalBugs: number
  },
  timestamp: string
}
```

### test:failed
Тест провалился.

```typescript
socket.on('test:failed', (data) => {
  console.error('Test failed:', data.error);
});

// Payload:
{
  testId: string,
  browser?: string,
  error: string,
  timestamp: string
}
```

### test:cancelled
Тест отменен.

```typescript
socket.on('test:cancelled', (data) => {
  console.log('Test cancelled:', data.reason);
});

// Payload:
{
  testId: string,
  reason?: string,
  timestamp: string
}
```

---

## 📊 Result Events

### result:ready
Результаты теста готовы.

```typescript
socket.on('result:ready', (data) => {
  console.log('Results ready:', data);
  fetchResults(data.testId);
});

// Payload:
{
  testId: string,
  browser: string,
  resultId: string,
  timestamp: string
}
```

### result:screenshot
Новый скриншот получен.

```typescript
socket.on('result:screenshot', (data) => {
  displayScreenshot(data.screenshot);
});

// Payload:
{
  testId: string,
  browser: string,
  screenshot: string,  // base64
  timestamp: string
}
```

### result:error
Ошибка во время выполнения теста.

```typescript
socket.on('result:error', (data) => {
  console.error('Test error:', data.error);
});

// Payload:
{
  testId: string,
  browser: string,
  error: {
    type: string,
    message: string,
    stack?: string
  },
  timestamp: string
}
```

---

## 🤖 AI Analysis Events

### ai:analysis:started
AI анализ начался.

```typescript
socket.on('ai:analysis:started', (data) => {
  console.log('AI analysis started:', data);
  showAnalyzing();
});

// Payload:
{
  testId: string,
  resultId: string,
  timestamp: string
}
```

### ai:analysis:progress
Прогресс AI анализа.

```typescript
socket.on('ai:analysis:progress', (data) => {
  console.log(`AI analyzing: ${data.stage} - ${data.progress}%`);
});

// Payload:
{
  testId: string,
  resultId: string,
  stage: 'analyzing_screenshot' | 'analyzing_logs' | 'generating_report',
  progress: number,  // 0-100
  timestamp: string
}
```

### ai:analysis:completed
AI анализ завершен.

```typescript
socket.on('ai:analysis:completed', (data) => {
  console.log('AI analysis completed:', data.summary);
  displayAISummary(data.summary);
});

// Payload:
{
  testId: string,
  resultId: string,
  summary: {
    summary: string,
    bugs: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low',
      message: string,
      location?: string
    }>,
    recommendations: string[],
    confidence: number
  },
  timestamp: string
}
```

### ai:bug:found
AI обнаружил баг (отправляется для каждого найденного бага).

```typescript
socket.on('ai:bug:found', (data) => {
  console.warn(`Bug found: ${data.bug.severity} - ${data.bug.message}`);
  addBugToList(data.bug);
});

// Payload:
{
  testId: string,
  resultId: string,
  bug: {
    severity: 'critical' | 'high' | 'medium' | 'low',
    message: string,
    location?: string,
    screenshot?: string
  },
  timestamp: string
}
```

---

## 💬 Chat Events

### chat:message
Новое сообщение в чате.

```typescript
socket.on('chat:message', (data) => {
  addMessageToChat(data.content, data.role);
});

// Payload:
{
  sessionId: string,
  messageId: string,
  role: 'user' | 'assistant',
  content: string,
  timestamp: string
}
```

### chat:test:update
Обновление о тесте в чате (автоматическое уведомление).

```typescript
socket.on('chat:test:update', (data) => {
  console.log('Test update in chat:', data);
  addTestUpdateToChat(data);
});

// Payload:
{
  sessionId: string,
  testId: string,
  message: string,
  status: 'created' | 'started' | 'progress' | 'completed' | 'failed',
  summary?: {
    totalBrowsers?: number,
    completedBrowsers?: number,
    totalBugs?: number,
    criticalBugs?: number,
    duration?: string
  },
  links?: {
    fullReport?: string,
    screenshots?: string
  },
  timestamp: string
}
```

---

## 🔧 System Events

### system:error
Системная ошибка.

```typescript
socket.on('system:error', (data) => {
  console.error('System error:', data);
  showErrorNotification(data.message);
});

// Payload:
{
  code: string,
  message: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  timestamp: string
}
```

### system:maintenance
Режим обслуживания.

```typescript
socket.on('system:maintenance', (data) => {
  console.log('Maintenance mode:', data);
  showMaintenanceNotification(data.message);
});

// Payload:
{
  message: string,
  estimatedDuration?: number,  // seconds
  timestamp: string
}
```

---

## ❤️ Heartbeat

Для проверки здоровья соединения:

```typescript
// Отправить ping
socket.emit('ping');

// Получить pong
socket.on('pong', () => {
  console.log('Pong received');
});
```

---

## 📝 Complete Example

```typescript
import { io } from 'socket.io-client';

// Подключение
const socket = io('http://localhost:3000', {
  auth: {
    token: localStorage.getItem('authToken')
  }
});

// Connection
socket.on('connect', () => {
  console.log('✅ Connected');
});

socket.on('authenticated', (data) => {
  console.log('✅ Authenticated:', data.userId);
});

// Подписка на тест
const testId = 'abc-123';
socket.emit('subscribe:test', { testId });

// Test lifecycle
socket.on('test:created', (data) => {
  console.log('📦 Test created:', data.testId);
});

socket.on('test:started', (data) => {
  console.log('🚀 Test started:', data.browser);
});

socket.on('test:progress', (data) => {
  console.log(`⏳ Progress: ${data.progress}%`);
  updateProgressBar(data.progress);
});

socket.on('test:completed', (data) => {
  console.log('✅ Test completed!', data);
  showCompletionNotification({
    totalBugs: data.summary.totalBugs,
    criticalBugs: data.summary.criticalBugs
  });
});

// AI Analysis
socket.on('ai:analysis:started', (data) => {
  console.log('🤖 AI analyzing...');
});

socket.on('ai:bug:found', (data) => {
  console.warn(`🐛 Bug: ${data.bug.message}`);
  addBugToList(data.bug);
});

socket.on('ai:analysis:completed', (data) => {
  console.log('🤖 AI analysis completed:', data.summary);
  displayAIReport(data.summary);
});

// Chat updates
socket.on('chat:test:update', (data) => {
  addMessageToChat(`✅ ${data.message}`, 'system');
});

// Errors
socket.on('test:failed', (data) => {
  console.error('❌ Test failed:', data.error);
  showErrorNotification(data.error);
});

socket.on('error', (data) => {
  console.error('❌ Error:', data.message);
});

// Cleanup on unmount
onUnmount(() => {
  socket.emit('unsubscribe:test', { testId });
  socket.disconnect();
});
```

---

## 🔒 Security

- **Authentication:** JWT токен проверяется при подключении
- **Authorization:** Пользователи могут подписываться только на свои тесты/чаты
- **Rate Limiting:** Максимум 50 subscriptions на одно соединение
- **CORS:** Настроено для безопасного cross-origin доступа

---

## 💡 Best Practices

1. **Подписывайтесь только на нужные события** - не слушайте все события глобально
2. **Отписывайтесь при unmount** - избегайте memory leaks
3. **Обрабатывайте ошибки** - всегда слушайте `error` и `test:failed`
4. **Используйте heartbeat** - проверяйте здоровье соединения
5. **Reconnection handling** - обрабатывайте переподключения корректно

```typescript
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    // Сервер отключил нас, переподключаемся вручную
    socket.connect();
  }
  // Иначе Socket.IO переподключится автоматически
});

socket.on('connect', () => {
  // Восстанавливаем subscriptions после reconnect
  socket.emit('subscribe:test', { testId: currentTestId });
});
```

---

## 🐛 Troubleshooting

**Соединение не устанавливается:**
- Проверьте URL и порт
- Проверьте CORS настройки
- Убедитесь что сервер запущен

**События не приходят:**
- Проверьте подписку (`subscribe:test`)
- Проверьте правильность testId/sessionId
- Проверьте логи сервера

**Disconnects:**
- Проверьте network connectivity
- Увеличьте timeout в конфигурации
- Проверьте firewall/proxy настройки

---

## 📚 Resources

- [Socket.IO Client Docs](https://socket.io/docs/v4/client-api/)
- [Socket.IO TypeScript Guide](https://socket.io/docs/v4/typescript/)
