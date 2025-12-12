# Autonomous Exploration Mode

## Overview

Autonomous Mode активируется когда у системы нет данных о продукте (no traces, no RAG). AI сам исследует продукт и генерирует test plan с подтверждением от юзера.

## Flow

```
User: "Протестируй регистрацию"
  ↓
1. Detect: No URL, no context → Autonomous Mode
  ↓
2. AI generates questions:
   - "Какой URL?"
   - "Что тестировать?"
   - "Нужны credentials?"
  ↓
3. User answers
  ↓
4. System explores product:
   - Opens browser
   - Takes screenshot
   - GPT-4o Vision analyzes image
   - DOM parser extracts elements
  ↓
5. AI generates Test Plan
  ↓
6. ⚠️ SHOW PLAN TO USER (ВАЖНО!)
  ↓
7. User confirms → Execute
   User rejects → Ask why, start over
```

---

## Components

### 1. Question Generator

**File:** `src/services/question-generator.service.ts`

**Base Questions:**
- URL (required)
- Scope (required)
- Needs Auth? (dynamic)
- Credentials (if auth needed)

**Dynamic Questions** (AI generated):
- Based on user intent
- Context-aware
- Max 3 additional questions

**Example:**
```typescript
const questions = await generateClarifyingQuestions(
  "Протестируй регистрацию",
  { hasUrl: false }
);

// Returns:
{
  needsMoreInfo: true,
  questions: [
    { id: "url", question: "Какой URL?", required: true },
    { id: "scope", question: "Что тестировать?", required: true },
    { id: "expected_outcome", question: "What should happen after registration?", required: false }
  ]
}
```

---

### 2. Autonomous Explorer

**File:** `src/services/autonomous-explorer.service.ts`

**Process:**
1. Launch browser
2. Authenticate (if needed)
3. Navigate to URL
4. Screenshot (full page)
5. GPT-4o Vision analysis (parallel)
6. DOM structure analysis (parallel)
7. Generate recommendations

**Output:**
```typescript
{
  url: "https://app.com/register",
  screenshot: "data:image/png;base64,...",
  visualAnalysis: {
    elements: [
      { type: "input", purpose: "email", required: true },
      { type: "button", purpose: "submit" }
    ],
    suggestions: ["Test empty fields", "Test invalid email"]
  },
  domAnalysis: {
    forms: [...],
    buttons: [...],
    inputs: [...]
  },
  recommendations: [...]
}
```

---

### 3. GPT-4o Vision Analyzer

**File:** `src/services/vision-analyzer.service.ts`

**Uses:** `gpt-4o` model with vision capabilities

**Analyzes:**
- Layout and structure
- All interactive elements
- Required vs optional fields
- Validation messages
- Visual hints

**Scope-specific:**
- Registration forms → email, password fields
- Login forms → username, password, "forgot password"
- General forms → all fields, buttons

---

### 4. DOM Analyzer

**File:** `src/services/dom-analyzer.service.ts`

**Extracts:**
- Forms (action, method, fields)
- Buttons (text, type, selector)
- Links (href, text)
- Inputs (type, name, placeholder, required)

**Smart selector generation:**
1. Try `id`
2. Try `name` attribute
3. Try `data-testid` / `data-cy`
4. Try meaningful classes
5. Try `placeholder` / text content
6. Fallback to nth-of-type

**Example output:**
```typescript
{
  forms: [{
    fields: [
      {
        name: "email",
        type: "email",
        required: true,
        selector: "input[name='email']"
      }
    ]
  }],
  buttons: [
    { text: "Sign Up", selector: "button:has-text('Sign Up')" }
  ]
}
```

---

### 5. Test Plan Generator

**File:** `src/services/test-plan-generator.service.ts`

**Combines:**
- Visual analysis
- DOM analysis
- User intent
- Recommendations

**Generates:**
- Summary
- Step-by-step plan
- Playwright commands
- What will/won't be tested
- Risks
- Estimated duration

**Example plan:**
```json
{
  "id": "plan_123",
  "summary": "Test registration form with validation",
  "steps": [
    {
      "id": "step_1",
      "description": "Navigate to registration page",
      "action": "goto",
      "expectedOutcome": "Page loads successfully"
    },
    {
      "id": "step_2",
      "description": "Fill email field",
      "action": "fill",
      "selector": "input[name='email']",
      "value": "test@example.com",
      "expectedOutcome": "Email accepted"
    }
  ],
  "whatWillBeTested": [
    "Form field validation",
    "Submit button functionality"
  ],
  "whatWillNotBeTested": [
    "Email confirmation flow",
    "Password reset"
  ]
}
```

---

### 6. Exploration Cache

**File:** `src/services/exploration-cache.service.ts`

**Functions:**
- `saveExplorationToCache()` - Save exploration
- `getCachedExploration()` - Get from cache
- `saveTestPlan()` - Save plan for confirmation
- `confirmTestPlan()` - Mark plan as confirmed
- `rejectTestPlan()` - Mark plan as rejected

**Cache strategy:**
- Expires after 7 days
- Track hit_count
- Reuse for same URL

---

### 7. Credentials Manager

**File:** `src/services/credentials-manager.service.ts`

**Security:**
- AES-256-GCM encryption
- Separate IV per credential
- Auth tag for integrity
- Only owner can decrypt

**Functions:**
- `storeCredentials()` - Encrypt and store
- `retrieveCredentials()` - Decrypt and return
- `listCredentials()` - List without decrypting
- `deleteCredentials()` - Securely delete

---

### 8. Orchestrator

**File:** `src/services/autonomous-orchestrator.service.ts`

**Main functions:**
- `needsAutonomousMode()` - Detect if needed
- `requestMissingInformation()` - Generate questions
- `runAutonomousExploration()` - Full exploration workflow
- `confirmAndExecuteTestPlan()` - Execute confirmed plan
- `rejectPlan()` - Handle rejection

---

## Database Schema

### Table: `exploration_cache`

```sql
- id: UUID
- user_id: UUID
- project_id: TEXT
- url: TEXT
- scope: TEXT
- screenshot: TEXT (base64)
- visual_analysis: JSONB
- dom_analysis: JSONB
- page_info: JSONB
- recommendations: TEXT[]
- created_at: TIMESTAMP
- expires_at: TIMESTAMP (7 days)
- hit_count: INTEGER
```

### Table: `test_plans`

```sql
- id: TEXT (plan_timestamp_random)
- user_id: UUID
- project_id: TEXT
- url: TEXT
- scope: TEXT
- summary: TEXT
- steps: JSONB
- commands: JSONB
- estimated_duration: TEXT
- what_will_be_tested: TEXT[]
- what_will_not_be_tested: TEXT[]
- risks: TEXT[]
- status: TEXT (pending_confirmation | confirmed | rejected | expired)
- exploration_id: UUID (FK to exploration_cache)
- created_at: TIMESTAMP
- expires_at: TIMESTAMP (3 days)
```

### Table: `test_credentials`

```sql
- id: UUID
- user_id: UUID
- project_id: TEXT
- email_encrypted: TEXT (AES-256-GCM)
- username_encrypted: TEXT
- password_encrypted: TEXT (required)
- label: TEXT
- url_pattern: TEXT
- created_at: TIMESTAMP
- last_used_at: TIMESTAMP
```

---

## Example Scenarios

### Scenario 1: New Product, No Data

**User:** "Протестируй регистрацию"

```
1. System: "Нужна информация:"
   - Какой URL?
   - Что конкретно протестировать?

2. User: "https://myapp.com/register, проверь форму"

3. System:
   - Opens https://myapp.com/register
   - Screenshot → GPT-4o Vision
   - DOM parsing
   - Generates plan:

📋 Test Plan:
1. Navigate to /register
2. Fill email field (input[name="email"])
3. Fill password field
4. Click submit button
5. Assert redirect to /dashboard

✅ Тестируем: form validation, submit
❌ НЕ тестируем: email confirmation

Подтвердить? /confirm plan_123

4. User: "/confirm plan_123"

5. System: Executes test
```

---

### Scenario 2: Has URL, Needs Auth

**User:** "Проверь dashboard на https://app.com/dashboard"

```
1. System detects "dashboard" → probably needs auth

2. System: "Для доступа нужна авторизация?"

3. User: "Да, test@test.com / testpass"

4. System:
   - Navigates to /login (auto-detected)
   - Logs in with credentials
   - Goes to /dashboard
   - Analyzes page
   - Generates plan

5. Shows plan → User confirms → Executes
```

---

### Scenario 3: Cache Hit

**User:** "Протестируй https://app.com/register" (second time)

```
1. System checks cache
2. Found! (cached 2 hours ago)
3. Uses cached exploration
4. Generates plan immediately
5. Shows for confirmation
```

---

## Security

### Credentials Encryption

**Algorithm:** AES-256-GCM

**Format:** `iv:authTag:encryptedData`

**Key derivation:** scrypt from `ENCRYPTION_SECRET`

**Protection:**
- ✅ RLS (row level security)
- ✅ Only owner can decrypt
- ✅ Separate IV per record
- ✅ Auth tag for tampering detection

---

## Configuration

### Environment Variables

```bash
# Required for encryption
ENCRYPTION_SECRET=your-32-char-secret-minimum

# GPT-4o Vision (more expensive!)
OPENAI_MODEL=gpt-4o  # Supports vision
```

### Costs

- **GPT-4o Vision:** ~$0.01-0.03 per screenshot analysis
- **Regular GPT-4o-mini:** ~$0.001 per test plan
- **Total per exploration:** ~$0.02-0.05

---

## API Integration

### POST /api/v1/chat (with missing context)

**Request:**
```json
{
  "message": "Протестируй регистрацию",
  "projectId": "proj-123"
}
```

**Response (needs info):**
```json
{
  "needsMoreInfo": true,
  "questions": [
    {
      "id": "url",
      "question": "Какой URL?",
      "required": true,
      "type": "url"
    }
  ],
  "conversationId": "conv_123"
}
```

**Second request (with answers):**
```json
{
  "message": "Протестируй регистрацию",
  "projectId": "proj-123",
  "conversationId": "conv_123",
  "answers": {
    "url": "https://myapp.com/register",
    "scope": "Форма регистрации"
  }
}
```

**Response (test plan):**
```json
{
  "testPlan": {
    "id": "plan_123",
    "summary": "...",
    "steps": [...],
    "commands": [...]
  },
  "message": "📋 Test Plan:\n...\n\n✅ Подтвердить: /confirm plan_123"
}
```

**Third request (confirmation):**
```json
{
  "message": "/confirm plan_123",
  "projectId": "proj-123"
}
```

**Response (execution started):**
```json
{
  "testId": "test-456",
  "status": "running",
  "message": "✅ Test started!"
}
```

---

## Files Created

```
src/services/
├── question-generator.service.ts         (245 lines)
├── autonomous-explorer.service.ts        (267 lines)
├── vision-analyzer.service.ts            (203 lines)
├── dom-analyzer.service.ts               (183 lines)
├── test-plan-generator.service.ts        (218 lines)
├── exploration-cache.service.ts          (221 lines)
├── credentials-manager.service.ts        (179 lines)
└── autonomous-orchestrator.service.ts    (220 lines)

supabase-migrations/
└── autonomous-exploration.sql            (200+ lines)

Total: ~1900+ lines of code
```

---

## Summary

✅ **Реализовано:**
- Динамическая генерация вопросов (AI + база)
- GPT-4o Vision для screenshot analysis
- DOM парсинг и извлечение селекторов
- Test plan generator с детальным планом
- User confirmation flow (ВАЖНО!)
- Supabase кэширование (7 days)
- AES-256 encryption для credentials

✅ **Безопасность:**
- Encrypted credentials
- RLS policies
- Only owner access
- Auto-expire plans (3 days)

✅ **Performance:**
- Cache hits = instant (~100ms)
- Fresh exploration = ~5-10s
- Parallel Vision + DOM analysis

✅ **Smart:**
- Context-aware questions
- Scope detection
- Auto-login handling
- Reusable selectors

---

## Ready for integration into chat.controller! 🚀
