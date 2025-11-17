# 📁 Testing Services Reorganization Plan

## 🎯 **Цель:** Логичная структура по типам тестирования

---

## 📊 **Текущая структура (плоская):**
```
/services/testing/
  - apiTest.service.ts
  - api-test-plan.service.ts
  - api-test-scenarios.service.ts
  - api-fuzzing-executor.service.ts
  - api-fuzzing-formatter.service.ts
  - intelligent-api-fuzzer.service.ts
  - fuzzing-config.ts
  - manualTest.service.ts
  - ui-test-plan.service.ts
  - autonomous-explorer.service.ts
  - autonomous-orchestrator.service.ts
  - dom-analyzer.service.ts
  - test-plan-generator.service.ts
  - exploration-cache.service.ts
  - test-results-formatter.service.ts
  - test-completion-handler.service.ts
  - test-chat-mapping.service.ts
  - intelligent-test-storage.service.ts
```

---

## 🎯 **Новая структура (логичная):**

```
/services/testing/
  /api/                          # API Testing Services
    - apiTest.service.ts         # Main API test execution
    - api-test-plan.service.ts   # API test plan generation
    - api-test-scenarios.service.ts # API test scenarios
    /fuzzing/                    # API Fuzzing
      - intelligent-api-fuzzer.service.ts
      - api-fuzzing-executor.service.ts
      - api-fuzzing-formatter.service.ts
      - fuzzing-config.ts

  /ui/                           # UI Testing Services
    - manualTest.service.ts      # Main UI test execution
    - ui-test-plan.service.ts   # UI test plan generation
    /autonomous/                 # Autonomous UI Testing
      - autonomous-explorer.service.ts
      - autonomous-orchestrator.service.ts
      - dom-analyzer.service.ts

  /plans/                        # Test Plan Management
    - test-plan-generator.service.ts  # Legacy plan generator
    - exploration-cache.service.ts    # Plan caching

  /results/                      # Results Processing
    - test-results-formatter.service.ts
    - test-completion-handler.service.ts
    - intelligent-test-storage.service.ts

  /shared/                       # Shared Utilities
    - test-chat-mapping.service.ts
```

---

## 📋 **Migration Steps:**

1. ✅ Create new folder structure
2. ✅ Move files to new locations
3. ✅ Update all imports across codebase
4. ✅ Verify compilation
5. ⏳ Test functionality (manual testing required)

---

## 🔄 **Import Path Changes:**

### **Before:**
```typescript
import { executeApiTest } from '@/services/testing/apiTest.service';
import { ManualTestService } from '@/services/testing/manualTest.service';
import { IntelligentApiFuzzerService } from '@/services/testing/intelligent-api-fuzzer.service';
```

### **After:**
```typescript
import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { IntelligentApiFuzzerService } from '@/services/testing/api/fuzzing/intelligent-api-fuzzer.service';
```

---

## ✅ **Benefits:**

1. **Clear Separation:** API vs UI testing
2. **Better Organization:** Related files grouped together
3. **Easier Navigation:** Find files by purpose
4. **Scalability:** Easy to add new test types
5. **Maintainability:** Clear structure for new developers

---

**Status:** 🚧 In Progress
