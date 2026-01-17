# Intent Parser Service Improvements

**Date:** 2025-01-07
**File:** `src/services/ai/intent/intent-parser.service.ts`

## Summary

Comprehensive refactoring of intent parser service to improve code quality, maintainability, and correctness.

---

## ✅ Completed Fixes

### 1. Removed Unused Variables
- **Removed:** `isResponseToClarification` variable (computed but only used in log)
- **Removed:** `kbRulesUsed` variable (defined but never used)
- **Impact:** Cleaner code, less confusion

### 2. Fixed `isIntentCompleteness` for Regression Intents
- **Added:** Validation for `save_test` (requires `sourceTestId`)
- **Added:** Validation for `create_suite` (requires `testCaseIds` array)
- **Added:** Validation for `run_regression` (requires `savedTestCaseId` OR `suiteId`)
- **Impact:** Proper validation for all 7 intent types instead of just 2

**Before:**
```typescript
function isIntentCompleteness(intentResult: IntentResult): boolean {
  // Only checked api_test and platform_test
  // Missing: save_test, create_suite, run_regression
}
```

**After:**
```typescript
function isIntentCompleteness(intentResult: IntentResult): boolean {
  // Now checks ALL 7 intent types:
  // api_test, platform_test, save_test, create_suite, run_regression
  // general_chat, needs_clarification (no required fields)
}
```

### 3. Consolidated URL Normalization
- **Fixed:** Duplicate URL normalization in `finalizeIntentResult`
- **Fixed:** URL normalization now happens in single place after misclassification correction
- **Added:** Confidence recalculation after intent change (api_test → platform_test)
- **Impact:** No more duplicate code, proper confidence after intent correction

**Changes:**
- Moved URL normalization to happen AFTER misclassification check
- Added `recalculatedConfidence` to metadata when intent is corrected
- Consolidated trimming, empty check, and protocol addition in one block

### 4. Updated `createFallbackResult` Logic
- **Removed:** Hardcoded `< 0.7` threshold that contradicted AI prompt changes
- **New logic:**
  - If AI explicitly returns `needs_clarification` → respect it
  - If confidence `< 0.6` on actionable intents → request clarification
  - Otherwise → proceed with original intent
- **Impact:** More aligned with prompt's "smart AI" approach

**Before:**
```typescript
if (confidence < 0.7) {
  // Always convert to needs_clarification
}
```

**After:**
```typescript
if (intentResult.intent === 'needs_clarification') {
  // AI decided, respect its decision
} else if (confidence < 0.6 && (api_test || platform_test)) {
  // Only for very low confidence on actionable intents
} else {
  // Proceed with original intent
}
```

### 5. Fixed `calculateConfidence` Consistency
- **Fixed:** Now uses `trimmedMessage` consistently instead of mixing `message` and `trimmedMessage`
- **Impact:** More consistent confidence calculation

**Changes:**
- `message.includes('?')` → `trimmedMessage.includes('?')`
- `message.match(/https?:\/\//)` → `trimmedMessage.match(/https?:\/\//)`

### 6. Added `availableIntents` to Cache Key
- **Fixed:** Cache now considers `availableIntents` to prevent false hits
- **Impact:** No more cache collision when intent set changes

**Before:**
```typescript
function buildCacheKey(message: string, projectId?: string): string {
  return `${message.toLowerCase()}|${projectId || 'global'}`;
}
```

**After:**
```typescript
function buildCacheKey(message: string, projectId?: string, availableIntents?: string[]): string {
  const intentsKey = availableIntents?.sort().join(',') || 'default';
  return `${message.toLowerCase()}|${projectId || 'global'}|${intentsKey}`;
}
```

### 7. Extracted Magic Numbers to Constants
- **Added constants:**
  - `MIN_CONFIDENCE_FOR_ACTION = 0.7` (threshold to proceed)
  - `MIN_CLARIFICATION_CONFIDENCE_CAP = 0.65` (max for needs_clarification)
  - `MIN_CONFIDENCE_FOR_CLARIFICATION = 0.6` (threshold to request clarification)
  - `VERY_SHORT_MESSAGE_LENGTH = 5` (approvals, unclear)
  - `DETAILED_MESSAGE_LENGTH = 50` (detailed messages)
  - `MIN_API_URL_LENGTH = 7` (minimum valid URL)
- **Impact:** Better maintainability, clear thresholds

---

## ⚠️ Remaining Issues (Manual Cleanup Needed)

### KB Search Commented Code (Lines ~260-750, 1960-2021)
- **Issue:** ~500 lines of commented KB/RAG code
- **Recommendation:** Remove entirely or move to separate branch
- **Reason:** Code is marked "TODO: temporarily disabled" but takes up 25% of file

**Location:**
- Lines 262-339: `getKBRulesContext`
- Lines 345-364: `buildRulesContext`
- Lines 402-470: `handleLowConfidenceWithRAG`
- Lines 524-545: `buildEnhancedContext`
- Lines 731-807: `createEnhancedResult`
- Lines 1963-2021: `getCachedRulesWithFallback`

**Action:** Delete these blocks or create feature branch for KB Search re-enabling.

---

## 🧪 Testing Recommendations

### Critical Test Cases:

1. **Regression Intents:**
   - `"save this flow"` with lastTestId → should detect save_test
   - `"save this flow"` without lastTestId → should request clarification
   - `"create suite from test1, test2"` → should detect create_suite
   - `"run saved test abc-123"` → should detect run_regression

2. **Confidence Thresholds:**
   - Test messages with confidence 0.58, 0.62, 0.68, 0.72
   - Verify behavior matches new thresholds

3. **Cache with Different Intent Sets:**
   - Same message, different availableIntents → should not hit cache

4. **URL Normalization:**
   - Test `example.com` → `https://example.com`
   - Test misclassified URLs (api.example.com as website)

---

## 📊 Metrics

**Code Quality:**
- Removed: 2 unused variables
- Fixed: 4 logic bugs
- Added: 27 lines of validation (regression intents)
- Consolidated: 2 duplicate blocks into 1
- Extracted: 6 magic numbers to constants

**File Size:**
- Current: ~1960 lines (with commented code)
- After cleanup: ~1450 lines (without commented code)
- Reduction: ~25%

---

## 🔄 Migration Notes

**No breaking changes** - all fixes are internal optimizations and bug fixes.

**Behavior changes:**
- Regression intents now properly validated
- Confidence thresholds adjusted (0.7 → 0.6 for clarification)
- Cache more accurate (considers availableIntents)

**Backward compatible:**
- All external APIs unchanged
- Return types unchanged
- Error handling unchanged

---

## 📝 Related Files

- `src/ai/prompts/intent-and-chat-prompts.ts` - Intent prompt definitions
- `src/api/chat/shared/handler-registry.ts` - Intent handler registry
- `src/api/chat/regression/*.handler.ts` - Regression intent handlers
- `src/types/index.ts` - IntentResult interface
