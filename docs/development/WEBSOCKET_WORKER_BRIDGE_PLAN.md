# План: Передача этапов тестирования через WebSocket из Worker

**Дата:** 2024-11-21
**Статус:** 📋 План
**Проблема:** Worker процесс не может напрямую эмитить WebSocket события (отдельный процесс без HTTP сервера)

---

## 🎯 Текущая ситуация

### Архитектура процессов:

```
┌─────────────────────┐         ┌─────────────────────┐
│   Main Process      │         │   Worker Process    │
│   (index.ts)        │         │   (worker/index.ts) │
│                     │         │                     │
│  ✅ HTTP Server     │         │  ❌ No HTTP Server  │
│  ✅ WebSocket Server │         │  ❌ No WebSocket   │
│  ✅ API Routes      │         │  ✅ Redis Queue     │
│  ✅ Chat Controller │         │  ✅ Job Handlers    │
└─────────────────────┘         └─────────────────────┘
         │                                │
         │                                │
         └──────────┬─────────────────────┘
                    │
              ┌─────▼─────┐
              │   Redis   │
              │  (Queue)  │
              └───────────┘
```

### Где эмитятся события:

1. **`playwright.service.ts`** (в worker)
   - `emitTestProgress(10%)` - Browser launching
   - `emitTestProgress(15%)` - Browser ready
   - `emitTestProgress(20%)` - Navigating
   - `emitTestProgress(25%)` - Page loaded

2. **`intelligent-test-orchestrator.ts`** (в worker)
   - `emitEvent('page_analyzing')` → `emitToUser('test:progress')`
   - `emitEvent('action_executing')` → `emitToUser('test:progress')`

3. **`progress-emitter.ts`** (в worker)
   - `emitTestProgress(50-90%)` - Action execution progress

4. **`manual-test-run.job.ts`** (в worker)
   - `emitTestStarted()`
   - `emitTestFailed()`
   - `emitTestBrowserCompleted()`

### Проблема:

```typescript
// В worker процессе:
webSocketService.emitTestProgress(testId, payload);
// ❌ WebSocket не инициализирован → событие теряется
// ✅ Сейчас: debug log, но событие не доходит до клиента
```

---

## 🚀 Варианты решения

### **Вариант 1: Redis Pub/Sub (РЕКОМЕНДУЕМЫЙ)** ⭐

**Принцип:**
- Worker публикует события в Redis Pub/Sub
- Main процесс подписывается и эмитит через WebSocket

**Архитектура:**
```
Worker → Redis Pub/Sub (channel: "websocket:events") → Main Process → WebSocket → Client
```

**Преимущества:**
- ✅ Надежно (Redis гарантирует доставку)
- ✅ Масштабируемо (несколько worker'ов → один main)
- ✅ Низкая latency (~1-2ms)
- ✅ Уже используем Redis для очередей
- ✅ Простая реализация

**Недостатки:**
- ⚠️ Нужен Redis (уже есть)
- ⚠️ Один дополнительный subscriber в main process

**Реализация:**

```typescript
// 1. Worker: Публикует события
// src/services/websocket/redis-bridge.service.ts
class RedisWebSocketBridge {
  async publishEvent(event: string, payload: any): Promise<void> {
    const redis = getRedisClient();
    await redis.publish('websocket:events', JSON.stringify({
      event,
      payload,
      timestamp: Date.now(),
    }));
  }
}

// 2. Main: Подписывается и эмитит
// src/websocket/redis-subscriber.ts
class WebSocketRedisSubscriber {
  async start(): Promise<void> {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    await subscriber.subscribe('websocket:events');

    subscriber.on('message', (channel, message) => {
      const { event, payload } = JSON.parse(message);

      // Эмитим через WebSocket
      const wsService = WebSocketService.getInstance();

      switch (event) {
        case 'test:progress':
          wsService.emitTestProgress(payload.testId, payload);
          break;
        case 'test:started':
          wsService.emitTestStarted(payload.testId, payload);
          break;
        // ... другие события
      }
    });
  }
}
```

**Оценка сложности:** 🟢 Низкая (2-3 часа)
**Производительность:** 🟢 Отлично (~1ms latency)
**Надежность:** 🟢 Высокая (Redis гарантирует доставку)

---

### **Вариант 2: HTTP API Endpoint**

**Принцип:**
- Worker делает HTTP POST запрос в main process
- Main process эмитит через WebSocket

**Архитектура:**
```
Worker → HTTP POST /api/internal/websocket/emit → Main Process → WebSocket → Client
```

**Преимущества:**
- ✅ Простая реализация
- ✅ Не требует Redis Pub/Sub
- ✅ Легко дебажить (HTTP запросы в логах)

**Недостатки:**
- ⚠️ Выше latency (~5-10ms vs 1-2ms)
- ⚠️ Нужен внутренний API endpoint (security risk)
- ⚠️ HTTP overhead (headers, parsing)
- ⚠️ Может быть bottleneck при высокой нагрузке

**Реализация:**

```typescript
// 1. Main: Internal API endpoint
// src/api/internal/websocket.route.ts
router.post('/emit', async (req, res) => {
  const { event, payload } = req.body;

  // Validate internal secret
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const wsService = WebSocketService.getInstance();

  switch (event) {
    case 'test:progress':
      wsService.emitTestProgress(payload.testId, payload);
      break;
    // ...
  }

  res.json({ success: true });
});

// 2. Worker: HTTP client
// src/services/websocket/http-bridge.service.ts
class HttpWebSocketBridge {
  async emitEvent(event: string, payload: any): Promise<void> {
    await fetch(`http://localhost:${process.env.PORT}/api/internal/websocket/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': process.env.INTERNAL_SECRET,
      },
      body: JSON.stringify({ event, payload }),
    });
  }
}
```

**Оценка сложности:** 🟢 Низкая (1-2 часа)
**Производительность:** 🟡 Средняя (~5-10ms latency)
**Надежность:** 🟡 Средняя (зависит от HTTP)

---

### **Вариант 3: BullMQ Job Events**

**Принцип:**
- Worker создает специальный job для WebSocket эмита
- Main process обрабатывает job и эмитит через WebSocket

**Архитектура:**
```
Worker → BullMQ Queue ("websocket-emit") → Main Process Worker → WebSocket → Client
```

**Преимущества:**
- ✅ Используем существующую инфраструктуру (BullMQ)
- ✅ Гарантированная доставка (retry механизм)
- ✅ Можно добавить priority для важных событий

**Недостатки:**
- ⚠️ Выше latency (~10-50ms, зависит от queue processing)
- ⚠️ Overhead (job creation, serialization)
- ⚠️ Может быть медленнее для real-time событий

**Реализация:**

```typescript
// 1. Worker: Создает job
// src/services/websocket/queue-bridge.service.ts
class QueueWebSocketBridge {
  async emitEvent(event: string, payload: any): Promise<void> {
    await QueueManager.addWebSocketEmitJob({
      event,
      payload,
      priority: event === 'test:progress' ? 1 : 5, // Progress = high priority
    });
  }
}

// 2. Main: Обрабатывает job
// src/jobs/websocket-emit.job.ts
export class WebSocketEmitJobHandler {
  static async process(job: Job): Promise<void> {
    const { event, payload } = job.data;
    const wsService = WebSocketService.getInstance();

    switch (event) {
      case 'test:progress':
        wsService.emitTestProgress(payload.testId, payload);
        break;
      // ...
    }
  }
}
```

**Оценка сложности:** 🟡 Средняя (3-4 часа)
**Производительность:** 🟡 Средняя (~10-50ms latency)
**Надежность:** 🟢 Высокая (BullMQ гарантирует доставку)

---

### **Вариант 4: Shared Memory / IPC (Node.js cluster)**

**Принцип:**
- Используем Node.js cluster для shared memory
- Worker и main в одном процессе (разные threads)

**Архитектура:**
```
Main Process (Cluster Master)
  ├── Worker Thread 1 (Job Handler)
  ├── Worker Thread 2 (Job Handler)
  └── Main Thread (HTTP + WebSocket)

Shared Memory / process.send() для коммуникации
```

**Преимущества:**
- ✅ Низкая latency (~0.1ms)
- ✅ Нет network overhead
- ✅ Простая коммуникация

**Недостатки:**
- ❌ Требует рефакторинга архитектуры
- ❌ Worker и main должны быть в одном процессе
- ❌ Сложнее масштабировать (один процесс)
- ❌ Не подходит для текущей архитектуры (отдельные процессы)

**Оценка сложности:** 🔴 Высокая (1-2 дня рефакторинг)
**Производительность:** 🟢 Отлично (~0.1ms latency)
**Надежность:** 🟡 Средняя (один процесс = single point of failure)

---

### **Вариант 5: Database Polling (НЕ РЕКОМЕНДУЕТСЯ)**

**Принцип:**
- Worker сохраняет события в БД
- Main process polling'ит БД и эмитит через WebSocket

**Недостатки:**
- ❌ Высокая latency (polling interval)
- ❌ Нагрузка на БД
- ❌ Не real-time
- ❌ Сложная логика (cleanup, deduplication)

**Оценка сложности:** 🟡 Средняя
**Производительность:** 🔴 Плохая (не real-time)
**Надежность:** 🟡 Средняя

---

## 📊 Сравнительная таблица

| Вариант | Latency | Сложность | Масштабируемость | Надежность | Рекомендация |
|---------|---------|-----------|------------------|-----------|--------------|
| **Redis Pub/Sub** | ~1-2ms | 🟢 Низкая | 🟢 Отлично | 🟢 Высокая | ⭐ **ЛУЧШИЙ** |
| HTTP API | ~5-10ms | 🟢 Низкая | 🟡 Средняя | 🟡 Средняя | ✅ Хороший |
| BullMQ Jobs | ~10-50ms | 🟡 Средняя | 🟢 Отлично | 🟢 Высокая | ✅ Хороший |
| Shared Memory | ~0.1ms | 🔴 Высокая | 🔴 Плохая | 🟡 Средняя | ❌ Не подходит |
| DB Polling | ~100-500ms | 🟡 Средняя | 🟡 Средняя | 🟡 Средняя | ❌ Не рекомендуется |

---

## 🎯 Рекомендуемый план реализации

### **Фаза 1: Redis Pub/Sub Bridge (Вариант 1)** ⭐

**Шаги:**

1. **Создать Redis Bridge Service** (30 мин)
   ```typescript
   // src/services/websocket/redis-bridge.service.ts
   - publishEvent(event, payload)
   - subscribeToEvents(callback)
   ```

2. **Обновить WebSocketService** (30 мин)
   ```typescript
   // src/websocket/websocket.service.ts
   - Добавить fallback: если WebSocket не инициализирован → Redis Pub/Sub
   - Автоматическое определение: worker или main process
   ```

3. **Создать Redis Subscriber в Main Process** (1 час)
   ```typescript
   // src/websocket/redis-subscriber.ts
   - Подписка на 'websocket:events' channel
   - Парсинг и эмит через WebSocket
   - Обработка ошибок и reconnection
   ```

4. **Обновить все emit вызовы** (30 мин)
   ```typescript
   // Автоматически работает через WebSocketService fallback
   // Никаких изменений в существующем коде!
   ```

5. **Тестирование** (30 мин)
   - Unit тесты для Redis bridge
   - Integration тесты (worker → main → client)
   - Load тесты (много событий)

**Итого:** ~3 часа работы

---

## 📝 Детальный план реализации (Redis Pub/Sub)

### **Шаг 1: Redis Bridge Service**

```typescript
// src/services/websocket/redis-bridge.service.ts
import { connection } from '@/config/queues';
import { logger } from '@/utils/logger';
import Redis from 'ioredis';

class RedisWebSocketBridge {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private isSubscribed = false;

  /**
   * Get Redis publisher client
   */
  private getPublisher(): Redis {
    if (!this.publisher) {
      this.publisher = new Redis(connection as any);
    }
    return this.publisher;
  }

  /**
   * Publish WebSocket event to Redis
   * Used by worker processes
   */
  async publishEvent(
    event: string,
    payload: any,
    target?: { testId?: string; userId?: string; sessionId?: string }
  ): Promise<void> {
    try {
      const message = JSON.stringify({
        event,
        payload,
        target,
        timestamp: Date.now(),
      });

      await this.getPublisher().publish('websocket:events', message);

      logger.debug('[REDIS_BRIDGE] Published event', {
        event,
        target,
      });
    } catch (error) {
      logger.error('[REDIS_BRIDGE] Failed to publish event', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Subscribe to WebSocket events from Redis
   * Used by main process to receive events from workers
   */
  async subscribe(callback: (event: string, payload: any, target?: any) => void): Promise<void> {
    if (this.isSubscribed) {
      logger.warn('[REDIS_BRIDGE] Already subscribed, skipping');
      return;
    }

    try {
      if (!this.subscriber) {
        this.subscriber = new Redis(connection as any);
      }

      await this.subscriber.subscribe('websocket:events');
      this.isSubscribed = true;

      this.subscriber.on('message', (channel, message) => {
        try {
          const { event, payload, target } = JSON.parse(message);

          logger.debug('[REDIS_BRIDGE] Received event', {
            event,
            target,
          });

          callback(event, payload, target);
        } catch (error) {
          logger.error('[REDIS_BRIDGE] Failed to parse event', {
            error: error instanceof Error ? error.message : String(error),
            message: message.substring(0, 100),
          });
        }
      });

      logger.info('[REDIS_BRIDGE] Subscribed to websocket:events channel');
    } catch (error) {
      logger.error('[REDIS_BRIDGE] Failed to subscribe', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Unsubscribe and cleanup
   */
  async unsubscribe(): Promise<void> {
    if (this.subscriber && this.isSubscribed) {
      await this.subscriber.unsubscribe('websocket:events');
      await this.subscriber.quit();
      this.subscriber = null;
      this.isSubscribed = false;
      logger.info('[REDIS_BRIDGE] Unsubscribed from websocket:events');
    }

    if (this.publisher) {
      await this.publisher.quit();
      this.publisher = null;
    }
  }
}

export const redisWebSocketBridge = new RedisWebSocketBridge();
```

### **Шаг 2: Обновить WebSocketService**

```typescript
// src/websocket/websocket.service.ts

import { redisWebSocketBridge } from '@/services/websocket/redis-bridge.service';
import { isWebSocketInitialized } from './server';

class WebSocketService {
  // ...

  /**
   * Check if WebSocket is ready
   * If not (worker process), use Redis Pub/Sub as fallback
   */
  private isReady(): boolean {
    return isWebSocketInitialized();
  }

  /**
   * Emit event with automatic fallback to Redis Pub/Sub
   */
  private emitWithFallback(
    event: string,
    payload: any,
    directEmit: () => void,
    target?: { testId?: string; userId?: string; sessionId?: string }
  ): void {
    if (this.isReady()) {
      // Main process: emit directly
      directEmit();
    } else {
      // Worker process: publish to Redis
      redisWebSocketBridge.publishEvent(event, payload, target).catch((error) => {
        logger.error('[WebSocketService] Failed to publish to Redis', {
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  public emitTestProgress(testId: string, payload: TestProgressPayload): void {
    this.emitWithFallback(
      'test:progress',
      payload,
      () => this.emitToTest(testId, 'test:progress', payload),
      { testId }
    );
  }

  public emitTestStarted(testId: string, payload: TestStartedPayload): void {
    this.emitWithFallback(
      'test:started',
      payload,
      () => this.emitToTest(testId, 'test:started', payload),
      { testId }
    );
  }

  // ... аналогично для всех методов
}
```

### **Шаг 3: Redis Subscriber в Main Process**

```typescript
// src/websocket/redis-subscriber.ts

import { redisWebSocketBridge } from '@/services/websocket/redis-bridge.service';
import { WebSocketService } from './websocket.service';
import { logger } from '@/utils/logger';

class WebSocketRedisSubscriber {
  private isRunning = false;

  /**
   * Start Redis subscriber for WebSocket events
   * Should be called in main process only
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[WS_REDIS_SUB] Already running');
      return;
    }

    try {
      await redisWebSocketBridge.subscribe((event, payload, target) => {
        this.handleEvent(event, payload, target);
      });

      this.isRunning = true;
      logger.info('[WS_REDIS_SUB] Started Redis subscriber for WebSocket events');
    } catch (error) {
      logger.error('[WS_REDIS_SUB] Failed to start subscriber', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Handle event from Redis and emit via WebSocket
   */
  private handleEvent(event: string, payload: any, target?: any): void {
    try {
      const wsService = WebSocketService.getInstance();

      switch (event) {
        case 'test:progress':
          wsService.emitTestProgress(payload.testId, payload);
          break;

        case 'test:started':
          wsService.emitTestStarted(payload.testId, payload);
          break;

        case 'test:completed':
          wsService.emitTestCompleted(payload.testId, payload);
          break;

        case 'test:failed':
          wsService.emitTestFailed(payload.testId, payload);
          break;

        case 'test:cancelled':
          wsService.emitTestCancelled(payload.testId, payload);
          break;

        case 'test:browser:completed':
          wsService.emitTestBrowserCompleted(payload.testId, payload);
          break;

        case 'test:step:completed':
          wsService.emitTestStepCompleted(payload.testId, payload);
          break;

        case 'result:ready':
          wsService.emitResultReady(payload.testId, payload);
          break;

        case 'result:error':
          wsService.emitResultError(payload.testId, payload);
          break;

        case 'ai:analysis:started':
          wsService.emitAIAnalysisStarted(payload.testId, payload);
          break;

        case 'ai:analysis:completed':
          wsService.emitAIAnalysisCompleted(payload.testId, payload);
          break;

        case 'ai:bug:found':
          wsService.emitAIBugFound(payload.testId, payload);
          break;

        default:
          logger.warn('[WS_REDIS_SUB] Unknown event type', { event });
      }
    } catch (error) {
      logger.error('[WS_REDIS_SUB] Failed to handle event', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop Redis subscriber
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await redisWebSocketBridge.unsubscribe();
      this.isRunning = false;
      logger.info('[WS_REDIS_SUB] Stopped Redis subscriber');
    } catch (error) {
      logger.error('[WS_REDIS_SUB] Failed to stop subscriber', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const webSocketRedisSubscriber = new WebSocketRedisSubscriber();
```

### **Шаг 4: Инициализация в Main Process**

```typescript
// src/index.ts

import { webSocketRedisSubscriber } from '@/websocket/redis-subscriber';

const startServer = async () => {
  // ... существующий код ...

  // Initialize WebSocket server
  try {
    const { initializeWebSocket } = await import('@/websocket/server');
    if (server) {
      initializeWebSocket(server);
      logger.info('🌐 WebSocket server initialized');

      // ✅ NEW: Start Redis subscriber for worker events
      await webSocketRedisSubscriber.start();
      logger.info('📡 WebSocket Redis subscriber started');
    }
  } catch (wsError) {
    // ... error handling ...
  }

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    // ... существующий код ...

    // ✅ NEW: Stop Redis subscriber
    await webSocketRedisSubscriber.stop();
  };
};
```

---

## 🧪 Тестирование

### **Unit Tests:**

```typescript
// src/services/websocket/__tests__/redis-bridge.service.test.ts
describe('RedisWebSocketBridge', () => {
  it('should publish event to Redis', async () => {
    // Mock Redis
    // Test publishEvent()
  });

  it('should subscribe and receive events', async () => {
    // Mock Redis subscriber
    // Test subscribe() callback
  });
});
```

### **Integration Tests:**

```typescript
// src/websocket/__tests__/redis-subscriber.integration.test.ts
describe('WebSocketRedisSubscriber Integration', () => {
  it('should receive event from worker and emit via WebSocket', async () => {
    // 1. Start subscriber
    // 2. Publish event (simulate worker)
    // 3. Verify WebSocket emit
  });
});
```

### **E2E Test:**

```typescript
// tests/e2e/websocket-worker-bridge.test.ts
describe('Worker → WebSocket Bridge E2E', () => {
  it('should deliver test progress from worker to client', async () => {
    // 1. Start test in worker
    // 2. Connect WebSocket client
    // 3. Verify progress events received
  });
});
```

---

## 📈 Метрики успеха

1. **Latency:** < 5ms от worker до клиента
2. **Reliability:** 99.9% доставка событий
3. **Throughput:** 1000+ событий/сек
4. **Zero downtime:** Graceful reconnection при Redis restart

---

## 🔄 Миграция

### **План миграции:**

1. **Фаза 1:** Реализовать Redis Pub/Sub (backward compatible)
2. **Фаза 2:** Протестировать на staging
3. **Фаза 3:** Deploy на production с feature flag
4. **Фаза 4:** Мониторинг метрик
5. **Фаза 5:** Убрать feature flag

### **Rollback план:**

Если что-то пойдет не так:
1. Отключить Redis subscriber (feature flag)
2. События будут теряться (как сейчас)
3. Никаких breaking changes для клиентов

---

## 📚 Дополнительные улучшения

### **Future Enhancements:**

1. **Event Batching:**
   - Batch несколько событий в один Redis message
   - Снизить overhead

2. **Priority Queue:**
   - Важные события (test:failed) → high priority
   - Progress события → normal priority

3. **Event Filtering:**
   - Фильтровать дубликаты
   - Rate limiting для частых событий

4. **Monitoring:**
   - Метрики: latency, throughput, errors
   - Dashboard для мониторинга

---

**Last Updated:** 2024-11-21
**Owner:** QAI Team
**Status:** 📋 План (готов к реализации)
