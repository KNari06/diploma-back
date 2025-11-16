# 🚀 Load Analysis: 100 Concurrent Users Running Intelligent Tests

## 📊 **Сценарий:**

100 пользователей одновременно запускают intelligent tests (Chrome, 10 pages, 5 minutes each)

---

## 🔥 **Нагрузка по компонентам:**

### **1. API Server (Node.js + Express)**

#### **Endpoint: POST /api/v1/chat**

```
Concurrent Requests: 100 simultaneous
Request Duration: ~2-5 seconds (intent parsing + test plan generation + DB ops)

Load:
- CPU: 30-50% (GPT API calls are async, waiting time)
- RAM: ~200MB baseline + (100 * 5MB) = ~700MB
- Network: Minimal (requests to OpenAI API)
```

**Bottlenecks:**

- ✅ **No blocking** - все async operations
- ⚠️ **OpenAI API rate limits** - 10,000 req/min (мы в рамках)
- ✅ **Database** - Supabase handles 1000+ concurrent connections

---

### **2. Redis (BullMQ Queue)**

#### **Queue: testRunQueue**

```
Jobs Added: 100 (1 per test, chrome only)
Job Size: ~2KB each (testData + commands)
Total: 200KB

Redis Load:
- Memory: 200KB + overhead (~500KB)
- CPU: Minimal (in-memory operations)
- Connections: 100 concurrent connections
```

**Bottlenecks:**

- ✅ **Redis easily handles** 100K ops/sec
- ✅ **Memory** - 500KB is negligible

---

### **3. Worker Processes (Playwright Execution)**

#### **Critical Component: Playwright Browsers**

```
Active Tests: 100 simultaneously
Browser Instances: 100 Chrome instances

Per Browser:
- RAM: 300-500MB (Chrome headless)
- CPU: 50-100% per core (page rendering, JS execution)
- Disk I/O: Moderate (screenshots, DOM snapshots)

Total Resources:
- RAM: 100 * 400MB = 40GB 🔥
- CPU: 100 cores (assuming 1 test = 1 core)
- Disk: 100 * 50MB = 5GB (temporary files)
```

**🚨 MAJOR BOTTLENECK:**

- **RAM: 40GB** - Большинство серверов не имеют столько RAM
- **CPU: 100 cores** - Очень дорого
- **Network**: Fetching 100 websites \* 10 pages = 1000 page loads

---

### **4. Database (Supabase/PostgreSQL)**

#### **Operations per test:**

```
INSERT:
- tests: 1 insert
- test_results: 1 insert (after completion)
- credit_transactions: 1 insert (deduct credits)

SELECT:
- users: 1 read (credit check)
- projects: 1-2 reads (getOrCreateUserProject)
- test_plans: 1 read (get pending plan)

UPDATE:
- tests: 2 updates (status: running → completed)
- users: 1 update (deduct credits)

Total per test: ~9 queries
Total for 100 tests: ~900 queries
```

**Load:**

```
Queries: 900 in first 10 seconds (burst)
Then: Spread over 5 minutes (test duration)

Supabase Free Tier: 500 concurrent connections
Supabase Pro Tier: 1000+ concurrent connections
```

**Bottlenecks:**

- ✅ **Database handles** 900 queries easily
- ✅ **Connections** - 100 concurrent OK
- ⚠️ **Connection pooling** - убедись что настроен правильно

---

### **5. WebSocket Server**

#### **Real-time updates:**

```
Connected Clients: 100 users
Messages per test: ~30 progress updates (every 10 seconds)
Total messages: 100 * 30 = 3000 messages over 5 minutes

Message Rate: 3000 / 300 sec = 10 msg/sec
```

**Load:**

```
Memory: 100 connections * 10KB = 1MB
CPU: Minimal (broadcasting is cheap)
Network: 10 msg/sec * 1KB = 10KB/sec (negligible)
```

**Bottlenecks:**

- ✅ **WebSocket easily handles** 10K connections
- ✅ **No bottleneck** here

---

## 📈 **Total Resource Requirements:**

### **Scenario A: Single Server (All-in-one)**

| Component | Requirement    | Bottleneck? |
| --------- | -------------- | ----------- |
| CPU       | **100+ cores** | 🔥 **YES**  |
| RAM       | **40-50GB**    | 🔥 **YES**  |
| Disk      | 20GB SSD       | ✅ OK       |
| Network   | 100 Mbps       | ✅ OK       |

**Cost Estimate (Single Server):**

- AWS c6i.metal (128 cores, 256GB RAM): **$6.912/hour** (~$5,000/month)
- **Not feasible for 100 concurrent tests on single server**

---

### **Scenario B: Distributed Architecture (Recommended)**

#### **Architecture:**

```
┌─────────────────┐
│   API Server    │ (4 cores, 8GB RAM)
│  (Node.js)      │ Handles: Requests, GPT calls, DB ops
└────────┬────────┘
         │
    ┌────┴────┐
    │  Redis  │ (2 cores, 4GB RAM)
    │  Queue  │ Job queue
    └────┬────┘
         │
    ┌────┴────────────────────────────┐
    │                                  │
┌───▼────┐  ┌─────────┐  ┌─────────┐
│Worker 1│  │Worker 2 │  │Worker N │ (8 cores, 16GB RAM each)
│(10 tests)│ │(10 tests)│ │(10 tests)│ Playwright execution
└────────┘  └─────────┘  └─────────┘
```

#### **Worker Distribution:**

```
10 Workers: Each handles 10 concurrent tests
Per Worker:
- CPU: 8 cores (1 test = 0.8 cores)
- RAM: 16GB (10 tests * 1.5GB = 15GB)
- Cost: $0.50/hour (AWS c5.2xlarge)

Total for 100 tests:
- 10 workers * $0.50/hour = $5/hour (~$3,600/month)
```

**Resources:**

```
API Server:   4 cores,  8GB RAM  = $0.20/hour
Redis:        2 cores,  4GB RAM  = $0.10/hour
10 Workers:  80 cores, 160GB RAM = $5.00/hour
Database:     Supabase Pro        = $25/month
─────────────────────────────────────────────
Total:                             $5.30/hour
Monthly:                           ~$3,800/month
```

---

## ⚡ **Optimization Strategies:**

### **1. Queue-based Concurrency Limiting**

```typescript
// Limit concurrent tests per worker
const MAX_CONCURRENT_TESTS_PER_WORKER = 10;

// BullMQ configuration:
const worker = new Worker(QUEUE_NAMES.TEST_RUN, processJob, {
  concurrency: MAX_CONCURRENT_TESTS_PER_WORKER, // ← ВАЖНО!
  connection: redisConnection,
});
```

**Effect:**

- Prevents worker overload
- Ensures stable performance
- Tests queue up instead of crashing

---

### **2. Dynamic Scaling (Auto-scaling Workers)**

```typescript
// Kubernetes HPA (Horizontal Pod Autoscaler)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: playwright-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: playwright-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

**Effect:**

- Workers автоматически добавляются при нагрузке
- Costs scale with demand
- 2-20 workers = 20-200 concurrent tests

---

### **3. Resource Pooling (Browser Context Reuse)**

```typescript
// Вместо: 1 test = 1 full Chrome instance
// Используй: 1 Chrome instance = multiple contexts

const browser = await chromium.launch();

// Test 1
const context1 = await browser.newContext();
const page1 = await context1.newPage();
// ... test execution ...
await context1.close();

// Test 2 (reuse browser)
const context2 = await browser.newContext();
const page2 = await context2.newPage();
// ... test execution ...
await context2.close();

await browser.close();
```

**Effect:**

- RAM: 500MB → 300MB per test (40% reduction)
- CPU: Faster startup (no browser launch)
- **Total savings:** 40GB → 25GB RAM for 100 tests

---

### **4. Test Scheduling (Peak vs Off-peak)**

```typescript
// Priority queue for intelligent tests
interface TestPriority {
  HIGH: 1; // Paid users, small tests
  NORMAL: 5; // Regular tests
  LOW: 10; // Large intelligent tests (10+ pages)
}

// BullMQ priority:
await testRunQueue.add("test-run", jobData, {
  priority: test.intelligentMode ? TestPriority.LOW : TestPriority.NORMAL,
});
```

**Effect:**

- Small tests complete first
- Large tests schedule during off-peak
- Better user experience

---

## 🎯 **Realistic Load Scenarios:**

### **Scenario 1: Startup (Low Traffic)**

```
Concurrent Users: 5-10
Infrastructure:
- 1 API server (2 cores, 4GB)
- 1 Redis (1 core, 2GB)
- 2 Workers (16 cores, 32GB)
Cost: ~$500/month
```

### **Scenario 2: Growth (Medium Traffic)**

```
Concurrent Users: 20-50
Infrastructure:
- 2 API servers (load balanced)
- 1 Redis (2 cores, 4GB)
- 5 Workers (40 cores, 80GB)
Cost: ~$1,500/month
```

### **Scenario 3: Scale (High Traffic)**

```
Concurrent Users: 100+
Infrastructure:
- 4 API servers (load balanced)
- 1 Redis cluster (4 cores, 8GB)
- 10-20 Workers (auto-scaling)
Cost: ~$3,500-7,000/month
```

---

## 🚨 **Критические Риски:**

### **1. Worker Overload**

**Problem:** Too many tests = OOM (Out of Memory)
**Solution:**

```typescript
// Add memory limit per worker
const MAX_MEMORY_MB = 15000; // 15GB

process.on("SIGTERM", async () => {
  logger.info("[WORKER] Graceful shutdown...");
  await worker.close();
  process.exit(0);
});

// Monitor memory
setInterval(() => {
  const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memUsage > MAX_MEMORY_MB) {
    logger.error("[WORKER] Memory limit exceeded, shutting down");
    process.exit(1);
  }
}, 10000);
```

### **2. Database Connection Exhaustion**

**Problem:** 100 concurrent connections → connection pool exhausted
**Solution:**

```typescript
// Supabase connection pooling
const supabase = createClient(url, key, {
  db: {
    pool: {
      min: 2,
      max: 50, // ← Limit connections per instance
      idleTimeoutMillis: 30000,
    },
  },
});
```

### **3. OpenAI Rate Limits**

**Problem:** 100 tests \* GPT calls = rate limit exceeded
**Solution:**

```typescript
// Implement retry with exponential backoff
async function callGPTWithRetry(prompt: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await openai.chat.completions.create(...);
    } catch (error) {
      if (error.status === 429) { // Rate limit
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}
```

---

## 📊 **Performance Metrics (Expected):**

### **API Server:**

```
Request Rate: 100 req at t=0, then ~10 req/min (completions)
Response Time: 2-5 seconds (p95)
Error Rate: <1%
CPU: 30-50%
RAM: <1GB
```

### **Workers:**

```
Test Throughput: 10 tests/worker concurrently
Test Duration: 3-7 minutes (intelligent mode)
Success Rate: >95%
CPU: 70-90% per worker
RAM: 12-15GB per worker
```

### **Database:**

```
Query Rate: ~900 queries/min (burst), then ~200 queries/min (steady)
Connection Count: 50-100
Query Latency: <50ms (p95)
```

---

## ✅ **Рекомендации:**

### **Immediate (Before Launch):**

1. ✅ **Implement concurrency limits** (10 tests/worker)
2. ✅ **Setup monitoring** (DataDog, New Relic, Prometheus)
3. ✅ **Configure connection pooling** (Supabase, Redis)
4. ✅ **Add graceful shutdown** (workers)

### **Short-term (First Month):**

1. ⚠️ **Implement auto-scaling** (Kubernetes HPA)
2. ⚠️ **Optimize browser reuse** (context pooling)
3. ⚠️ **Setup alerting** (high CPU, OOM, queue depth)
4. ⚠️ **Add load testing** (k6, Artillery)

### **Long-term (3-6 Months):**

1. 🔄 **Implement caching** (test results, AI responses)
2. 🔄 **Optimize Playwright** (headless, disable images)
3. 🔄 **Database read replicas** (read-heavy queries)
4. 🔄 **CDN for screenshots** (S3 + CloudFront)

---

## 🎯 **Final Answer:**

### **100 одновременных intelligent tests:**

| Metric          | Value                                                               |
| --------------- | ------------------------------------------------------------------- |
| **CPU**         | 80-100 cores (10 workers \* 8 cores)                                |
| **RAM**         | 160GB (10 workers \* 16GB)                                          |
| **Cost**        | **~$3,800/month** (distributed) or **$5,000/month** (single server) |
| **Bottleneck**  | 🔥 **Workers (RAM + CPU)**                                          |
| **Feasibility** | ✅ **Feasible with distributed architecture**                       |

**Recommended Setup:**

- Start with **2-3 workers** (~20-30 concurrent tests)
- Add **auto-scaling** for growth
- Monitor and optimize as you scale

---

**Дата:** 2025-11-16
**Сценарий:** 100 concurrent intelligent tests
**Вывод:** ✅ Feasible, but requires distributed architecture and proper resource management
