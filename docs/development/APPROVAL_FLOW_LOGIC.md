# Approval Flow Logic - Test Plan Approval

**Created:** 2025-11-20
**Purpose:** Document how test plan approval works and prevent false approvals

---

## 🎯 CORE RULE: Last Message Check

**Approval ONLY works if LAST AI message was a test plan!**

---

## 📊 HOW IT WORKS

### Step 1: Check Last AI Message
```typescript
// In handlePendingTestPlanApproval
const recentMessages = await ChatService.getRecentMessages(chatSessionId, 5);
const lastAiMessage = recentMessages.find(msg => msg.role === 'ai');

// Check if last AI message was a test plan
lastAiMessageWasTestPlan =
  lastAiMessage.metadata.requiresApproval === true ||
  !!lastAiMessage.metadata.testPlan ||
  !!lastAiMessage.metadata.conversationId;
```

### Step 2: Early Exit if Not Test Plan
```typescript
if (!lastAiMessageWasTestPlan) {
  return false; // No approval to handle, continue with intent parsing
}
```

### Step 3: Find Pending Plan in DB
```typescript
const pendingPlan = await findPendingTestPlan(conversationId, userId);
if (!pendingPlan || pendingPlan.status !== 'pending_confirmation') {
  return false;
}
```

### Step 4: Detect Approval
```typescript
const approvalResult = await detectUserApproval(message);
if (approvalResult.approved === true) {
  await executeApprovedTestPlan(...);
}
```

---

## ✅ VALID SCENARIOS

### Scenario 1: Immediate Approval
```
AI: "🧠 Test Plan... [requiresApproval: true]"
User: "yes, start!"
→ Last AI = plan ✅
→ Approval processed ✅
```

### Scenario 2: Multiple Plans
```
AI: "Old plan... [5 min ago]"
AI: "New plan... [requiresApproval: true]" ← LAST
User: "yes!"
→ Last AI = plan ✅
→ Approves NEW plan ✅
```

---

## ❌ INVALID SCENARIOS

### Scenario 1: Chat Between Plan and Approval
```
AI: "🧠 Test Plan... [requiresApproval: true]"
User: "How much does this cost?"
AI: "20 credits" ← LAST (not a plan!)
User: "yes, start!"
→ Last AI ≠ plan ❌
→ Intent parsing asks "What do you want to test?" ❓
```

### Scenario 2: Old Plan
```
AI: "🧠 Test Plan... [10 min ago]"
User: "How does testing work?"
AI: "Testing works by..." ← LAST
User: "test that site"
→ Last AI ≠ plan ❌
→ Creates NEW plan ✅
```

### Scenario 3: After Rejection
```
AI: "🧠 Test Plan... [requiresApproval: true]"
User: "no, cancel"
AI: "❌ Test canceled" ← LAST
User: "wait, yes!"
→ Last AI ≠ plan ❌
→ Intent parsing asks clarification ❓
```

---

## 🔧 PROMPT UPDATES

### 1. buildApprovalDetectionPrompt
**Updated:** 2025-11-20

**Added:**
```
⚠️ IMPORTANT: Approval ONLY works if the LAST AI message was a test plan!
If user is responding to a regular chat message, this is NOT an approval.
```

**Purpose:** Prevent false approvals when user says "yes" to regular chat

---

### 2. buildChatSystemPrompt
**Updated:** 2025-11-20

**Added:**
```
🔍 **When user is APPROVING a test:**
   Signal: Confirmation IMMEDIATELY after seeing test plan (must be LAST AI message!)
   ⚠️ CRITICAL: Approval ONLY works if last AI message was a test plan!
   → If user said "yes" but last message was regular chat → ask what they want to test
```

**Purpose:** Guide AI to understand approval context

---

## 🧪 TEST CASES

### Test 1: Normal Approval
```
Input:
  - Last AI: test plan (requiresApproval: true)
  - User: "yes, start!"
Expected: Approval processed ✅
```

### Test 2: Chat Between
```
Input:
  - AI: test plan
  - AI: "20 credits" (regular chat)
  - User: "yes!"
Expected: Intent parser asks for clarification ❓
```

### Test 3: Multiple Approvals
```
Input:
  - AI: test plan
  - User: "yes!"
  - AI: "Test running..."
  - User: "yes again!"
Expected: No action (last AI wasn't a plan) ✅
```

---

## 📝 KEY TAKEAWAYS

1. ✅ **Always check last AI message** before processing approval
2. ✅ **metadata.requiresApproval** indicates a test plan
3. ✅ **Early exit** if last message wasn't a plan
4. ✅ **Intent parsing** handles unclear cases
5. ✅ **No false approvals** for old/rejected plans

---

## 🔗 Related Files

- `src/api/chat/chat.controller.ts` (handlePendingTestPlanApproval)
- `src/ai/prompts/index.ts` (buildApprovalDetectionPrompt, buildChatSystemPrompt)
- `src/services/ai/ai-helpers.service.ts` (detectUserApproval)
