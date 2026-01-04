# 📝 QAIT Platform Prompts

All AI prompts are centralized in `index.ts` for easy management and updates.

## 🌍 Language Policy

- **All prompts are in English** (for US market launch)
- **AI automatically detects user's language** and responds accordingly
- Supports: English, Russian, Spanish, Kazakh, and more

## 📁 Prompt Structure

### 1. Intent Parser (`buildIntentPrompt`)

**Purpose:** Determine user's intention from natural language

**Detects:**

- `platform_test` - UI testing
- `api_test` - API testing
- `general_chat` - General conversation

**Extracts:**

- Scope (full, page, element, flow, form, auth, navigation)
- Target (specific thing to test)
- URL, API method, body, headers

### 2. UI Test Plan (`buildUiTestPlanPrompt`)

**Purpose:** Generate comprehensive test plan for UI testing

**Includes:**

- Step-by-step test flow
- Browser automation commands
- What will/won't be tested
- Potential risks
- Duration estimate

### 3. API Test Plan (`buildApiTestPlanPrompt`)

**Purpose:** Generate detailed API test plan

**Includes:**

- Validation steps
- Expected status code
- Headers & body
- What will be tested
- Potential issues

### 4. Chat System (`buildChatSystemPrompt`)

**Purpose:** System prompt for general conversations

**Defines:**

- Platform capabilities
- Communication style
- Multilingual support

### 5. Approval Detection (`buildApprovalDetectionPrompt`)

**Purpose:** Detect if user approved/rejected test plan

**Handles:**

- Natural language in any language
- Emojis (✅, ❌, 👍, 👎)
- Slang and informal speech

### 6. Question Generation (`buildQuestionGenerationPrompt`)

**Purpose:** Generate clarifying questions

**Used when:**

- Missing URL
- Unclear scope
- Need credentials
- Any other missing info

## 📝 Usage Example

```typescript
import { Prompts } from "@/ai/prompts/index";

// Parse intent
const intentPrompt = Prompts.buildIntentPrompt(userMessage, context);

// Generate test plan
const testPlanPrompt = Prompts.buildApiTestPlanPrompt({
  method: "GET",
  url: "https://api.example.com/users",
  userMessage: "Test users endpoint",
});

// Chat
const systemPrompt = Prompts.buildChatSystemPrompt();
```

## 🔄 Updating Prompts

1. **Edit** `src/ai/prompts/index.ts`
2. **Test** with various user inputs
3. **Monitor** AI responses for quality
4. **Iterate** based on user feedback

## 📊 Prompt Guidelines

✅ **DO:**

- Be specific and clear
- Provide examples
- Include context when available
- Use structured formats (JSON)
- Support multilingual responses

❌ **DON'T:**

- Hardcode language-specific responses
- Make prompts too long (>2000 tokens)
- Assume user's language
- Skip error handling

## 🧪 Testing Prompts

Test with diverse inputs:

- Different languages (EN, RU, ES, KZ)
- Various phrasings
- Edge cases
- Incomplete information

## 📈 Monitoring

Track:

- Intent detection accuracy
- Test plan quality
- User approval rates
- Language detection success
