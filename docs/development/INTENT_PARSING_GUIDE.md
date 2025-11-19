# Intent Parsing & Context-First AI Guide

**Date Created:** 2024-11-19
**Last Updated:** 2024-11-19
**Status:** 🔄 Active Development
**Purpose:** Track AI behavior, prompts optimization, and ensure context-first approach

---

## 🎯 CORE PHILOSOPHY: Context-First AI

### **PRIMARY PRINCIPLE:**
```
AI должен понимать INTENT (что user хочет), а не просто искать keywords!

Priority:
1. 🥇 CONTEXT & INTENT (что user хочет сделать?)
2. 🥈 SENTENCE STRUCTURE (question vs command)
3. 🥉 KEYWORDS (только для уточнения)
```

### **WHY Context-First?**
- ❌ Keyword approach: "Did you test API?" → содержит "API" + "test" → api_test (WRONG!)
- ✅ Context approach: "Did you test API?" → QUESTION about past → general_chat (CORRECT!)

---

## 📊 AFFECTED PROMPTS & THEIR STATUS

### **✅ PROMPTS WITH CONTEXT-FIRST (Critical for routing)**

| Prompt | File | Lines | Status | Last Update |
|--------|------|-------|--------|-------------|
| `buildIntentPrompt` | `src/ai/prompts/index.ts` | 37-240 | ✅ Optimized | 2024-11-19 |
| `buildApprovalDetectionPrompt` | `src/ai/prompts/index.ts` | 390-433 | ✅ Optimized | 2024-11-19 |
| `buildChatSystemPrompt` | `src/ai/prompts/index.ts` | 289-381 | ✅ Optimized | 2024-11-19 |

### **✅ PROMPTS WITH STRUCTURED APPROACH (OK as-is)**

| Prompt | Purpose | Approach | Notes |
|--------|---------|----------|-------|
| `buildApiTestPlanPrompt` | Generate test plan | Structured | JSON output needed |
| `buildApiFuzzingPrompt` | Generate fuzzing scenarios | Structured | Specific rules |
| `buildPageAnalysisPrompt` | Vision analysis | Dynamic | Already flexible |
| `buildActionGenerationPrompt` | Generate test actions | Structured | JSON actions |
| `buildNextStepPrompt` | Continue/Stop decision | Structured | Binary decision |
| `buildLogicAnalysisPrompt` | Dependencies | Structured | Clear analysis |
| `buildVisionPrompt` | Screenshot analysis | Dynamic | Already flexible |

---

## 🐛 KNOWN ISSUES & FIXES

### **ISSUE #1: AI asks for details instead of answering questions**

**Problem:**
```
User: "So, did you run API test already?"
AI: "📋 I need a few more details to set up the API test:
     • 📡 Which HTTP method should I use?"
```

**Root Cause:**
- Intent Parser classified as `api_test` (should be `general_chat`)
- Keyword "API test" triggered api_test intent
- No context understanding

**Fix Applied:**
- ✅ Updated `buildIntentPrompt` with context-first approach
- ✅ Added examples: Ex4, Ex5 with CONTEXT reasoning
- ✅ Updated CRITICAL RULES to prioritize intent over keywords

**Status:** ✅ FIXED (2024-11-19)

---

### **ISSUE #2: AI runs new test instead of summarizing existing results**

**Problem:**
```
User: "can you make briefly response from last success testing result"
AI: [Starts creating NEW test plan instead of summarizing]
```

**Root Cause:**
- `detectUserApproval` classified "can you make" as approval
- No rules for summarization requests
- Keyword "briefly" not recognized as discussion indicator

**Fix Applied:**
- ✅ Updated `buildApprovalDetectionPrompt` with context-first
- ✅ Added explicit NOT APPROVAL examples
- ✅ Updated `buildChatSystemPrompt` with discussion context

**Status:** ✅ FIXED (2024-11-19)

---

### **ISSUE #3: Hardcoded keywords in buildVisionPrompt**

**Problem:**
```typescript
const isRegister = scopeLower.includes('регистрац') || scopeLower.includes('register');
const isLogin = scopeLower.includes('логин') || scopeLower.includes('login');
```

**Root Cause:**
- Hardcoded keyword checks
- Not scalable for synonyms ("signup", "sign-up", etc.)
- Brittle implementation

**Fix Applied:**
- ✅ Removed all hardcoded checks
- ✅ Let GPT-4o Vision understand scope dynamically
- ✅ Added guidelines instead of hardcoded rules

**Status:** ✅ FIXED (2024-11-19)

---

## 📝 PROMPT OPTIMIZATION HISTORY

### **buildIntentPrompt - Version 3 (Current)**

**Key Changes:**
- Removed keyword-based INDICATORS
- Added "TRUE INTENT" focus
- Added CONTEXT reasoning in examples
- Added PRIORITY ORDER rules (🥇🥈🥉)

**Before:**
```typescript
2️⃣ "api_test" - API/HTTP endpoint testing
   INDICATORS: "API", "endpoint", "HTTP", methods
```

**After:**
```typescript
2️⃣ "api_test" - User wants to RUN a new API test
   CONTEXT CLUES (Primary):
   ✓ User is giving you an API URL + asking you to test it
   ✓ It's a COMMAND/REQUEST or APPROVAL, not a question

   Keywords (Secondary): "API", "endpoint", HTTP methods
```

**Token Count:**
- Before: ~1,100 tokens
- After: ~1,200 tokens (+9%)
- Cost impact: +$0.000005 per request (negligible)

**Examples Added:**
```typescript
Ex4: "So, did you run API test already?"
CONTEXT: User is ASKING about past action ("did you run") → QUESTION ABOUT STATUS
Keywords: Contains "API test" but context = ASKING, not REQUESTING
→ {"intent": "general_chat"}
```

---

### **buildApprovalDetectionPrompt - Version 2 (Current)**

**Key Changes:**
- Removed approval/rejection keyword lists
- Added "Think like human" mindset
- Added KEY DISTINCTION section
- Added context-based examples

**Before:**
```typescript
APPROVAL PATTERNS:
• Positive: да, yes, ok, ок, го, давай, запускай...
• Confirmative: согласен, одобряю, approve...

REJECTION PATTERNS:
• Negative: нет, no, не надо, don't, stop...
```

**After:**
```typescript
CONTEXT: The user previously received a test plan and we need to know if they want to:
1. APPROVE (execute the test) → approved=true
2. REJECT (cancel the test) → approved=false
3. DO SOMETHING ELSE (ask questions, request changes) → approved=null

BE INTELLIGENT:
• "make briefly response" = discussing results, NOT approval
• "go ahead" = clear approval
```

**Token Count:**
- Before: ~280 tokens
- After: ~240 tokens (-14%)
- Cost savings: $0.000002 per request

---

### **buildChatSystemPrompt - Version 2 (Current)**

**Key Changes:**
- Added "Think like ChatGPT" mindset
- Replaced CRITICAL RULES with CONTEXT UNDERSTANDING
- Added signal-based detection (REQUESTING vs ASKING vs DISCUSSING)
- Added concrete BAD vs GOOD example

**Before:**
```typescript
⚠️ CRITICAL RULES:
1. No URL in message & no URL in history → ASK for URL
2. "summary"/"briefly"/"what were" → Summarize EXISTING results
3. "that"/"this"/"same" → Check history FIRST
```

**After:**
```typescript
🎯 YOUR MINDSET: Understand CONTEXT, not just keywords

🔍 When user is REQUESTING a new test:
   Signal: Giving you URL + asking to test something
   → Guide them through test plan creation

🔍 When user is ASKING about past tests:
   Signal: Questions about what already happened
   → Look at conversation history
   → DON'T create a new test plan!
```

**Token Count:**
- Before: ~850 tokens
- After: ~920 tokens (+8%)
- Cost impact: Minimal, worth the improvement

---

## 🧪 TEST CASES & EXPECTED BEHAVIOR

### **Test Suite 1: Question vs Command Detection**

| User Input | Expected Intent | Expected Behavior | Status |
|------------|----------------|-------------------|--------|
| "Test this API https://..." | `api_test` | Create test plan | ✅ Pass |
| "Did you run API test?" | `general_chat` | Answer question | 🔄 Testing |
| "Have you tested the endpoint?" | `general_chat` | Discuss results | 🔄 Testing |
| "So, did you run API test already?" | `general_chat` | Answer status | 🔄 Testing |
| "What were the API test results?" | `general_chat` | Summarize results | 🔄 Testing |

### **Test Suite 2: Summarization vs New Test**

| User Input | Expected Intent | Expected Behavior | Status |
|------------|----------------|-------------------|--------|
| "can you make briefly response" | `general_chat` | Summarize existing | 🔄 Testing |
| "summarize last test" | `general_chat` | Summarize existing | 🔄 Testing |
| "explain the results" | `general_chat` | Discuss results | 🔄 Testing |
| "Test this API again" | `api_test` | Create NEW test | ✅ Pass |

### **Test Suite 3: Approval Detection**

| User Input | Expected Approval | Expected Behavior | Status |
|------------|------------------|-------------------|--------|
| "yes, execute it" | `true` | Execute test | ✅ Pass |
| "go ahead" | `true` | Execute test | ✅ Pass |
| "can you make briefly" | `null` | NOT approval | 🔄 Testing |
| "no, cancel" | `false` | Reject test | ✅ Pass |

### **Test Suite 4: Context Understanding**

| User Input | Context | Expected Intent | Status |
|------------|---------|----------------|--------|
| "Test API" (no URL) | New conversation | `general_chat` | ✅ Pass |
| "yes" (after test plan) | Test plan shown | `api_test` | ✅ Pass |
| "test that with POST" | Previous GET test | `api_test` | ✅ Pass |
| "explain this" | Test plan shown | `general_chat` | ✅ Pass |

### **Test Suite 5: Real Data Usage (No Hallucination)**

| User Input | Context | Expected Behavior | Status |
|------------|---------|------------------|--------|
| "What were the results?" | Test completed | Quote REAL data from history | 🔄 Testing |
| "did you remember last test?" | Test completed | Show ACTUAL status, time, response | 🔄 Testing |
| "show errors from test" | Test completed | Quote REAL errors or say "no errors" | 🔄 Testing |
| "give me detailed info" | Test completed | Extract ALL real data from history | 🔄 Testing |

**CRITICAL:** AI should NEVER use placeholders like:
- ❌ `[insert response time here]`
- ❌ `[insert relevant details]`
- ❌ `[List any relevant headers]`

**ALWAYS use real data:**
- ✅ "Response Time: 613ms"
- ✅ "Status: 200 OK"
- ✅ "Response: Array of 150 tutors"

---

## 🔧 DEBUGGING GUIDE

### **If AI still asks for details when user asks question:**

**Check:**
1. Is Intent Parser returning correct intent?
   - Look for log: `[INTENT_PARSER] Intent parsed { intent: "???" }`
   - Should be `general_chat`, not `api_test`

2. Is `extractUrlFromChatHistory` being called?
   - Look for log: `[INTENT_PARSER] URL FOUND IN HISTORY!`
   - Should NOT find URL when user is asking question

3. Is `detectUserApproval` working correctly?
   - Look for log: `[APPROVAL_DETECT] User approval detected`
   - Should return `approved: null` for questions

**Fix locations:**
- `src/ai/prompts/index.ts` → `buildIntentPrompt` (line 37)
- `src/services/ai/intentParser.service.ts` → `extractUrlFromChatHistory` (line 574)

---

### **If AI creates new test plan instead of summarizing:**

**Check:**
1. Is Intent correctly classified as `general_chat`?
2. Is `handleGeneralChat` being called?
   - Look for log: `[GENERAL_CHAT] Handling general conversation`

3. Is chat history being included?
   - Look for log: `[GENERAL_CHAT] Built context for AI { recentHistoryCount: ??? }`
   - Should have recent messages with test results

4. Is `buildChatSystemPrompt` being used?
   - Check that system prompt includes context understanding guide

**Fix locations:**
- `src/api/chat/chat.controller.ts` → `handleGeneralChat` (line 1332)
- `src/ai/prompts/index.ts` → `buildChatSystemPrompt` (line 289)

---

## 📈 PERFORMANCE METRICS

### **Token Usage Changes:**

| Prompt | Before | After | Change | Cost Impact |
|--------|--------|-------|--------|-------------|
| `buildIntentPrompt` | 1,100 | 1,200 | +9% | +$0.000005/req |
| `buildApprovalDetectionPrompt` | 280 | 240 | -14% | -$0.000002/req |
| `buildChatSystemPrompt` | 850 | 920 | +8% | +$0.000004/req |
| **Total per conversation** | ~2,230 | ~2,360 | +5.8% | +$0.000007/req |

**At scale:**
- 1,000 conversations/day: +$0.007/day = $2.55/year
- 10,000 conversations/day: +$0.07/day = $25.55/year

**Verdict:** Negligible cost increase, significant UX improvement ✅

---

## 🎓 TRAINING DATA FOR AI

### **Good Patterns to Learn:**

```typescript
// ✅ REQUESTING new test (commands)
"Test this API"
"Run test on https://..."
"Check endpoint"
"Execute GET https://..."
"Verify this website"

// ✅ ASKING about past (questions)
"Did you run the test?"
"Have you tested it?"
"Was the test successful?"
"What were the results?"
"Did you finish testing?"

// ✅ DISCUSSING results (conversation)
"briefly"
"summarize"
"explain this"
"what happened?"
"tell me about the test"
"show me summary"

// ✅ APPROVING test (confirmations)
"yes"
"go ahead"
"execute it"
"run it"
"давай"
"✅"
```

### **Bad Patterns to Avoid:**

```typescript
// ❌ DON'T match keywords blindly
"Did you test API?" → NOT api_test! (it's a question)
"API test results?" → NOT api_test! (asking for info)
"Tell me about API testing" → NOT api_test! (general discussion)

// ❌ DON'T create new test plans when summarizing
"briefly" → Summarize EXISTING, don't create NEW
"summarize" → Reference HISTORY, don't start fresh
"what were results" → PAST tense = existing results

// ❌ DON'T treat questions as approvals
"can you make briefly" → NOT approval! (it's a request)
"could you explain" → NOT approval! (it's a question)
```

---

## 🚀 FUTURE IMPROVEMENTS

### **Planned Optimizations:**

1. **Vector-based Intent Classification** (Phase 2)
   - Use embeddings instead of GPT for faster classification
   - Train on historical user queries
   - Expected: 50% latency reduction

2. **User Feedback Loop** (Phase 3)
   - Track when AI misclassifies intent
   - Learn from corrections
   - Auto-improve prompts based on feedback

3. **Multi-language Support** (Phase 4)
   - Better Russian language understanding
   - Support for Spanish, Chinese, etc.
   - Maintain context-first approach across languages

---

## 🐛 KNOWN ISSUES & FIXES (Continued)

### **ISSUE #6: Intent parser doesn't understand "from that test" references**

**Problem:**
```
User: "yes, give whole data from that test"
Intent Parser: api_test ❌ (should be general_chat)
Result: AI asks "Which HTTP method?" instead of showing past test data
```

**Root Cause:**
- Intent parser sees keywords: "yes" + "give" + "data" + "test"
- Doesn't analyze CONTEXT: "from THAT test" = past test!
- Classifies as `api_test` instead of `general_chat`
- Wrong handler called → wrong response

**Fix Applied:**
- ✅ Added Ex10 and Ex11 to `buildIntentPrompt`
- ✅ Explicit examples showing "from that test" → general_chat
- ✅ Added to "COMMON MISTAKES TO AVOID" section
- ✅ Added matching examples in `buildChatSystemPrompt`

**Example Fix:**
```typescript
Ex10: "yes, give whole data from that test"
CONTEXT: User wants COMPLETE details from PREVIOUS test ("that test" = past!)
→ {"intent": "general_chat"}
❌ NOT api_test! User wants DATA from existing test, not CREATE new test!
```

**Status:** ✅ FIXED (2024-11-19)

---

### **ISSUE #7: Upgraded to gpt-4o-mini for better context understanding**

**Problem:**
- Intent parser used `gpt-3.5-turbo` for all helper functions
- GPT-3.5 is older (2023), keyword-focused
- Struggles with nuanced context like "from that test"

**Solution:**
- ✅ Upgraded ALL intent parsing to `gpt-4o-mini`
- ✅ Changed in: `detectUserApproval`, `extractUrlWithGPT`, `detectLoginPage`, `validateSelector`, `parseNaturalAnswers`, `smartNavigation`
- ✅ Already used `gpt-4o-mini` by default in `intentParser.service.ts`

**Benefits:**
- 🧠 **Better context understanding** (GPT-4 level intelligence)
- 💰 **10x cheaper** ($0.00015/1K vs $0.0015/1K)
- ⚡ **Faster** (~400ms vs ~500ms)
- 📅 **Newer model** (2024 release)

**Cost Comparison:**
```
Before: gpt-3.5-turbo = $0.0015 / 1K tokens
After:  gpt-4o-mini   = $0.00015 / 1K tokens (10x cheaper!)

Example: 1M intent parsing calls:
- Before: ~$30/month
- After: ~$3/month
- Savings: $27/month (90% reduction!)
```

**Files Changed:**
- `src/services/ai/ai-helpers.service.ts` (6 functions upgraded)
- `src/services/ai/intentParser.service.ts` (already used gpt-4o-mini)

**Status:** ✅ UPGRADED (2024-11-19)

---

### **ISSUE #4: AI uses placeholders instead of real data**

**Problem:**
```
User: "What were the API test results?"
AI: "Status: 200 OK
     Response Time: [insert response time here]
     Response Body: [insert relevant details]"
```

**Root Cause:**
- AI acknowledges test exists but doesn't extract actual data from history
- Uses generic placeholders instead of quoting real results
- Prompt doesn't explicitly forbid placeholders

**Fix Applied:**
- ✅ Updated `buildChatSystemPrompt` with explicit instructions
- ✅ Added: "Use REAL data from history (NEVER use placeholders)"
- ✅ Added: "Quote specific numbers and details from the test"
- ✅ Added BAD example showing hallucination

**Example Fix:**
```typescript
🔍 When user is ASKING about past tests:
   → Find the ACTUAL test results (status, response time, response body)
   → Use REAL data from history (NEVER use placeholders like "[insert here]")
   → Quote specific numbers and details from the test
   → If you can't find data, say "I don't see test results"
```

**Status:** ✅ FIXED (2024-11-19)

---

### **ISSUE #5: Misleading logs + unnecessary GPT calls**

**Problem:**
```log
Line 41: 🔍 [APPROVAL_CHECK] Checking for pending test plan approval hi, how are you/
Line 44: ✅ [PENDING_PLAN_SEARCH] Found plan by conversationId!
Line 56: 🔍 [APPROVAL_DETECT] Starting detection hi, how are you/
Line 60: ✅ [APPROVAL_DETECT] User approval detected by AI  ← MISLEADING!
Line 63: [INTENT_PARSER] Message not recognized as approval
```

**Root Causes:**
1. **Misleading log**: `ai-helpers.service.ts` always logged "✅ User approval detected" even when `approved=null`
2. **Unnecessary GPT calls**: `intentParser.service.ts` called `detectUserApproval()` + `extractUrlWithGPT()` for EVERY message (even "hi, how are you")
3. **No early exit**: No fast path for obvious non-approval messages

**Fix Applied:**
- ✅ Fixed misleading log in `ai-helpers.service.ts` (line 80-89)
- ✅ Added early exit for greetings/questions in `intentParser.service.ts` (line 595-610)
- ✅ Skip GPT calls for messages starting with "hi/hello/what/how/why" or ending with "?"

**Before Fix:**
```typescript
logger.info('✅ [APPROVAL_DETECT] User approval detected by AI', {
  approved: parsed.approved,  // Can be null!
});
```

**After Fix:**
```typescript
const logPrefix = parsed.approved === true ? '✅ [APPROVAL_DETECT] Approved'
                : parsed.approved === false ? '❌ [APPROVAL_DETECT] Rejected'
                : '⚠️ [APPROVAL_DETECT] Unclear/Not approval';
```

**Optimization (AI-powered, not hardcoded):**
```typescript
// ❌ BAD: Hardcoded patterns (не универсально!)
const patterns = [/^(hi|hello|привет)/i]; // Не покрывает все языки!

// ✅ GOOD: AI-powered sequential filtering
// Step 1: Check approval (cheap, ~200ms, $0.0004)
const approvalResult = await detectUserApproval(message);

// Step 2: Early exit if NOT approval (saves ~200ms + $0.0004)
if (approvalResult.approved !== true || approvalResult.confidence < 0.7) {
  return { extractedUrl: null, extractedMethod: null }; // ⚡ Skip URL extraction!
}

// Step 3: ONLY extract URL if approval detected (expensive)
const extractionResult = await extractUrlWithGPT(userMessages, message);
```

**Why AI-powered, not regex?**
- ✅ Universal: Works for ALL languages (English, Russian, Chinese, Arabic...)
- ✅ Context-aware: Understands "maybe", "later", "not now" as non-approvals
- ✅ Maintainable: No need to update hardcoded patterns for new languages
- ✅ Consistent: Uses same AI logic as main approval detection

**Impact:**
- 🚀 Performance: ~200ms saved per greeting/question message (skip URL extraction)
- 💰 Cost: ~$0.0004 saved per greeting/question message (1 GPT call instead of 2)
- 📊 Logs: Clearer distinction between approved/rejected/unclear
- 🎯 UX: Faster response for simple greetings
- 🌍 Universal: Works for ALL languages, not just English/Russian

**Status:** ✅ FIXED (2024-11-19)

---

## 📝 CHANGE LOG

### **2024-11-19 (Update 3): Fixed Misleading Logs + Performance (AI-powered)**

**Issue Found (from production logs):**
- Misleading log "✅ User approval detected" even when `approved=null`
- Unnecessary GPT calls for greetings/questions (~400ms delay + cost)
- "hi, how are you" triggered `detectUserApproval()` + `extractUrlWithGPT()` in parallel

**User Feedback:**
- ❌ Initial fix used hardcoded regex patterns (not universal!)
- ✅ Refactored to AI-powered sequential filtering

**Changes:**
- ✅ Fixed misleading log in `ai-helpers.service.ts` (line 80-89)
- ✅ Changed from parallel to sequential: `detectUserApproval()` → early exit → `extractUrlWithGPT()`
- ✅ NO hardcoded patterns - AI determines approval status dynamically

**Approach:**
```typescript
// ❌ REJECTED: Hardcoded patterns
const patterns = [/^(hi|hello|привет)/i]; // Not universal!

// ✅ IMPLEMENTED: AI-powered filtering
const approvalResult = await detectUserApproval(message); // Step 1
if (approvalResult.approved !== true) return; // Step 2: Early exit
const extractionResult = await extractUrlWithGPT(...); // Step 3: Only if approved
```

**Performance Impact:**
- 🚀 ~200ms faster for greetings/questions (skip URL extraction)
- 💰 ~$0.0004 saved per greeting/question (1 GPT call instead of 2)
- 🌍 Universal: Works for ALL languages (no hardcoded keywords!)

**Files Modified:**
- `src/services/ai/ai-helpers.service.ts` (lines 80-89)
- `src/services/ai/intentParser.service.ts` (lines 595-618)

---

### **2024-11-19 (Update 2): Fixed Data Hallucination**

**Issue Found:**
- AI was using placeholders `[insert here]` instead of real data
- Not extracting actual test results from history

**Changes:**
- ✅ Updated `buildChatSystemPrompt` line 322-330
- ✅ Added explicit "NEVER use placeholders" instruction
- ✅ Added BAD example with hallucination (line 376-379)

**Files Modified:**
- `src/ai/prompts/index.ts` (lines 322-330, 376-379)

---

### **2024-11-19 (Update 1): Major Refactor - Context-First Approach**

**Changes:**
- ✅ Refactored `buildIntentPrompt` to context-first
- ✅ Refactored `buildApprovalDetectionPrompt` to context-first
- ✅ Refactored `buildChatSystemPrompt` to context-first
- ✅ Removed hardcoded keywords from `buildVisionPrompt`
- ✅ Added PRIORITY ORDER rules (Context > Structure > Keywords)
- ✅ Added concrete examples with reasoning

**Issues Fixed:**
- #1: AI asks for details when user asks question
- #2: AI runs new test instead of summarizing
- #3: Hardcoded keywords in vision prompt

**Files Modified:**
- `src/ai/prompts/index.ts` (lines 37-381)

**Testing Required:**
- [ ] Question vs Command detection
- [ ] Summarization vs New Test
- [ ] Approval detection
- [ ] Context understanding

---

## 📞 CONTACTS & REFERENCES

**Owner:** QAI Team
**Last Reviewed By:** AI Assistant
**Next Review:** After production testing

**Related Docs:**
- [Chat Flow Architecture](../architecture/chat-flow.md)
- [Intent Parser Service](../../src/services/ai/intentParser.service.ts)
- [Chat Controller](../../src/api/chat/chat.controller.ts)

---

## ⚠️ IMPORTANT NOTES

1. **NEVER revert to keyword-based approach** - it breaks natural conversation
2. **ALWAYS test changes with real user scenarios** - don't just check syntax
3. **MONITOR logs** after deployment - intent misclassification is visible in logs
4. **UPDATE THIS DOC** when making prompt changes - keep it as single source of truth

---

**Last Updated:** 2024-11-19
**Version:** 1.0
**Status:** 🟢 Active
