# 🗂️ Services Architecture

Organized service layer for QAIT Backend with logical categorization.

## 📁 Structure

```
src/services/
├── core/           # Core business services (4 files)
├── ai/             # AI & ML services (6 files)
├── testing/        # Testing & automation (12 files)
├── auth/           # Authentication & users (3 files)
├── api/            # API related services (4 files)
├── kb/             # Knowledge base services (4 files)
└── utils/          # Utility services (5 files)
```

---

## 📂 Categories

### 🏗️ core/ - Core Business Services

**Purpose:** Essential business logic and core functionality

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `workspace.service.ts` | Workspace management & creation | Supabase |
| `user-credits.service.ts` | Credits & billing system | Supabase |
| `credit-cost-tracker.service.ts` | Cost tracking & analytics | user-credits |
| `token-calculator.service.ts` | Token/credit conversion | None |

**When to use:**
- ✅ Workspace operations
- ✅ Credit management
- ✅ Billing calculations

---

### 🤖 ai/ - AI & Machine Learning

**Purpose:** AI services, LLM interactions, and ML operations

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `ai.service.ts` | Main AI analysis service | OpenAI |
| `openai.service.ts` | OpenAI API client | OpenAI |
| `ai-helpers.service.ts` | AI utility functions | openai.service |
| `embedding.service.ts` | Vector embeddings | OpenAI |
| `vision-analyzer.service.ts` | Image/screenshot analysis | OpenAI |
| `intentParser.service.ts` | User intent parsing | openai, kb |

**When to use:**
- ✅ LLM completions
- ✅ Text analysis
- ✅ Image processing
- ✅ Intent detection

---

### 🧪 testing/ - Testing & Automation

**Purpose:** All testing-related services and automation

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `apiTest.service.ts` | API testing execution | None |
| `manualTest.service.ts` | Manual test management | Supabase |
| `autonomous-explorer.service.ts` | Autonomous web exploration | ai, vision |
| `autonomous-orchestrator.service.ts` | Test orchestration | explorer, ai |
| `api-test-plan.service.ts` | API test planning | ai |
| `api-test-scenarios.service.ts` | Test scenario generation | ai |
| `test-plan-generator.service.ts` | Test plan creation | ai, explorer |
| `test-completion-handler.service.ts` | Test completion logic | chat |
| `test-results-formatter.service.ts` | Results formatting | None |
| `test-chat-mapping.service.ts` | Test-chat associations | Supabase |
| `dom-analyzer.service.ts` | DOM structure analysis | None |
| `exploration-cache.service.ts` | Exploration caching | Supabase |

**When to use:**
- ✅ API testing
- ✅ Manual testing
- ✅ Autonomous testing
- ✅ Test planning

---

### 👤 auth/ - Authentication & Users

**Purpose:** User authentication, authorization, and rate limiting

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `auth.service.ts` | User authentication | Supabase |
| `anonymous-limiter.service.ts` | Anonymous user rate limiting | Supabase |
| `anonymous-migration.service.ts` | Anonymous → auth migration | Supabase |

**When to use:**
- ✅ User login/signup
- ✅ Rate limiting
- ✅ Anonymous users

---

### 🌐 api/ - API Services

**Purpose:** External API integrations and configurations

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `api-config.service.ts` | API configuration management | Supabase, testing |
| `credentials-manager.service.ts` | API credentials storage | Supabase |
| `credentials-parser.service.ts` | Credentials parsing | None |
| `jira.service.ts` | Jira integration | External API |

**When to use:**
- ✅ API configurations
- ✅ External integrations
- ✅ Credentials management

---

### 📚 kb/ - Knowledge Base

**Purpose:** Knowledge base, RAG, and context services

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `kb.service.ts` | Main knowledge base | Supabase, ai |
| `localKB.service.ts` | Local KB operations | kb.service |
| `context-enrichment.service.ts` | Context enhancement | kb, utils |
| `smart-api-context.service.ts` | Smart API context | api, utils |

**When to use:**
- ✅ Knowledge retrieval
- ✅ Context enhancement
- ✅ RAG operations

---

### 🔧 utils/ - Utility Services

**Purpose:** Utility functions and helper services

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `chat.service.ts` | Chat utilities | None |
| `project-context.service.ts` | Project context management | api |
| `question-generator.service.ts` | Question generation | ai |
| `trace-context.service.ts` | Trace context handling | None |
| `url-resolver.service.ts` | URL resolution | api |

**When to use:**
- ✅ Utility functions
- ✅ Helper operations
- ✅ Context management

---

## 🔗 Dependencies

### Dependency Graph

```
core/
├── workspace.service ← (used by controllers)
├── user-credits.service ← (used by middleware, controllers)
├── credit-cost-tracker.service ← (uses user-credits)
└── token-calculator.service ← (used by credit-cost-tracker)

ai/
├── openai.service ← (used by all AI services)
├── ai.service ← (uses openai)
├── ai-helpers.service ← (uses openai)
├── embedding.service ← (uses openai)
├── vision-analyzer.service ← (uses openai)
└── intentParser.service ← (uses openai, kb)

testing/
├── autonomous-explorer.service ← (uses ai services)
├── autonomous-orchestrator.service ← (uses explorer, ai, utils)
├── test-plan-generator.service ← (uses ai, explorer)
└── ... (other testing services)

auth/
├── auth.service ← (used by middleware)
├── anonymous-limiter.service ← (used by middleware)
└── anonymous-migration.service ← (used by auth controller)

api/
├── api-config.service ← (uses testing services)
├── credentials-manager.service ← (used by testing)
└── ... (other API services)

kb/
├── kb.service ← (used by AI services)
├── context-enrichment.service ← (uses kb, utils)
└── ... (other KB services)

utils/
├── project-context.service ← (uses api services)
├── question-generator.service ← (uses ai services)
└── ... (other utilities)
```

---

## 📋 Import Guidelines

### ✅ Correct Import Patterns

```typescript
// From controllers/middleware
import { WorkspaceService } from '@/services/core/workspace.service';
import { getChatCompletion } from '@/services/ai/openai.service';
import { executeApiTest } from '@/services/testing/apiTest.service';

// Between services (relative paths)
import { ApiConfigService } from '../api/api-config.service';
import { getChatCompletionWithMessages } from '../ai/openai.service';
```

### ❌ Avoid These Patterns

```typescript
// DON'T: Old flat imports (deprecated)
import { WorkspaceService } from '@/services/workspace.service';

// DON'T: Wrong relative paths
import { ApiConfigService } from './api-config.service'; // if not in same folder
```

---

## 🚀 Migration Benefits

### Before (Flat Structure)
- ❌ 38 files in one folder
- ❌ Hard to find related services
- ❌ No logical grouping
- ❌ Unclear dependencies

### After (Organized Structure)
- ✅ Logical categorization
- ✅ Easy to find services
- ✅ Clear dependencies
- ✅ Better maintainability
- ✅ Scalable architecture

---

## 🔍 Finding Services

**Need to find a service?**

1. **Business logic** → `core/`
2. **AI/ML operations** → `ai/`
3. **Testing features** → `testing/`
4. **User auth** → `auth/`
5. **External APIs** → `api/`
6. **Knowledge base** → `kb/`
7. **Utilities** → `utils/`

---

**Last updated:** 2025-11-11
