# Daily Credits Replenishment - Examples

## 📋 Overview

Free plan users get **5 credits per day**, but only if they used **at least 1 credit** the previous day.

**Logic:**
- Used 0 credits → No credits added (stay at current balance)
- Used 1 credit → Add 1 credit (restore to 5)
- Used 2 credits → Add 2 credits (restore to 5)
- Used 3 credits → Add 3 credits (restore to 5)
- Used 4 credits → Add 4 credits (restore to 5)
- Used 5 credits → Add 5 credits (restore to 5)

---

## 📊 Example Scenarios

### Scenario 1: User Uses 0 Credits (No Activity)

**Day 1:**
- Starting balance: `5 credits`
- Credits used: `0`
- Ending balance: `5 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `0`
- Credits added: `0` ❌ (didn't use any)
- New balance: `5 credits` (unchanged)

**Day 3 (after daily reset):**
- Credits used yesterday: `0`
- Credits added: `0` ❌ (still didn't use any)
- New balance: `5 credits` (unchanged)

**Result:** User keeps their 5 credits but doesn't get replenishment because they didn't use any.

---

### Scenario 2: User Uses 1 Credit (Chat Message)

**Day 1:**
- Starting balance: `5 credits`
- Action: Sends 1 chat message → `-1 credit`
- Credits used: `1`
- Ending balance: `4 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `1`
- Credits added: `+1` ✅ (restore to 5)
- New balance: `5 credits` (4 + 1 = 5)

**Day 2 (user activity):**
- Action: Sends 2 chat messages → `-2 credits`
- Credits used: `2`
- Ending balance: `3 credits`

**Day 3 (after daily reset):**
- Credits used yesterday: `2`
- Credits added: `+2` ✅ (restore to 5)
- New balance: `5 credits` (3 + 2 = 5)

---

### Scenario 3: User Uses All 5 Credits

**Day 1:**
- Starting balance: `5 credits`
- Actions:
  - 1 chat message → `-1 credit`
  - 1 API test → `-2 credits`
  - 1 chat message → `-1 credit`
  - 1 chat message → `-1 credit`
- Credits used: `5`
- Ending balance: `0 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `5`
- Credits added: `+5` ✅ (restore to 5)
- New balance: `5 credits` (0 + 5 = 5)

---

### Scenario 4: User Uses More Than 5 Credits (Purchased Extra)

**Day 1:**
- Starting balance: `10 credits` (5 free + 5 purchased)
- Actions:
  - 3 chat messages → `-3 credits`
  - 1 API test → `-2 credits`
  - 1 chat message → `-1 credit`
- Credits used: `6`
- Ending balance: `4 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `6` (but only 5 are "free")
- Credits added: `+5` ✅ (restore free portion to 5)
- New balance: `9 credits` (4 + 5 = 9)

**Note:** System adds back up to 5 credits (the daily free amount), regardless of how many were used.

---

### Scenario 5: User Doesn't Use Credits for Multiple Days

**Day 1:**
- Starting balance: `5 credits`
- Credits used: `0`
- Ending balance: `5 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `0`
- Credits added: `0` ❌
- New balance: `5 credits` (unchanged)

**Day 3 (after daily reset):**
- Credits used yesterday: `0`
- Credits added: `0` ❌
- New balance: `5 credits` (unchanged)

**Day 4:**
- User finally uses 1 credit
- Ending balance: `4 credits`

**Day 5 (after daily reset):**
- Credits used yesterday: `1`
- Credits added: `+1` ✅
- New balance: `5 credits` (4 + 1 = 5)

**Result:** User keeps their credits but doesn't get replenishment until they start using them.

---

### Scenario 6: User Uses Credits Partially Over Multiple Days

**Day 1:**
- Starting balance: `5 credits`
- Uses: `2 credits` (2 chat messages)
- Ending balance: `3 credits`

**Day 2 (after daily reset):**
- Credits added: `+2` ✅
- New balance: `5 credits` (3 + 2 = 5)

**Day 2 (user activity):**
- Uses: `1 credit` (1 chat message)
- Ending balance: `4 credits`

**Day 3 (after daily reset):**
- Credits added: `+1` ✅
- New balance: `5 credits` (4 + 1 = 5)

**Day 3 (user activity):**
- Uses: `3 credits` (3 chat messages)
- Ending balance: `2 credits`

**Day 4 (after daily reset):**
- Credits added: `+3` ✅
- New balance: `5 credits` (2 + 3 = 5)

---

### Scenario 7: Pro Plan User (No Daily Replenishment)

**Day 1:**
- Plan: `Pro` (unlimited monthly, no daily limit)
- Starting balance: `1000 credits` (from monthly plan)
- Uses: `50 credits` (various tests)
- Ending balance: `950 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `50`
- Credits added: `0` ❌ (Pro plan doesn't get daily free credits)
- New balance: `950 credits` (unchanged)
- Daily counter reset: `credits_used_today = 0`

**Result:** Pro plan users don't get daily free credits, only monthly allocation.

---

### Scenario 8: User Switches from Free to Pro Plan

**Day 1 (Free Plan):**
- Starting balance: `5 credits`
- Uses: `3 credits` (3 chat messages)
- Ending balance: `2 credits`

**Day 2 (User upgrades to Pro - 1000 credits option):**
- Plan changed: `Free` → `Pro`
- **Existing balance preserved:** `2 credits` (kept from free plan)
- **Monthly credits added:** `+1000 credits` (Pro plan monthly allocation)
- **New balance:** `1002 credits` (2 + 1000)
- Daily counter reset: `credits_used_today = 0`
- Monthly counter reset: `credits_used_this_month = 0`

**Day 3 (after daily reset):**
- Credits used yesterday: `0` (no activity on Day 2)
- Credits added: `0` ❌ (Pro plan doesn't get daily free credits)
- New balance: `1002 credits` (unchanged)
- **Daily replenishment:** Disabled (only for free plan)

**Day 3 (user activity):**
- Uses: `50 credits` (various tests and chats)
- Ending balance: `952 credits`

**Next Month (monthly reset):**
- Monthly credits reset: `credits_used_this_month = 0`
- **New monthly allocation:** `+1000 credits` (if subscription renewed)
- New balance: `1952 credits` (952 + 1000)

---

### Scenario 9: User Switches from Free to Ultra Plan

**Day 1 (Free Plan):**
- Starting balance: `5 credits`
- Uses: `1 credit` (1 chat message)
- Ending balance: `4 credits`

**Day 2 (after daily reset - still Free):**
- Credits used yesterday: `1`
- Credits added: `+1` ✅
- New balance: `5 credits` (4 + 1 = 5)

**Day 2 (User upgrades to Ultra - 2000 credits option):**
- Plan changed: `Free` → `Ultra`
- **Existing balance preserved:** `5 credits` (kept from free plan)
- **Monthly credits added:** `+2000 credits` (Ultra plan monthly allocation)
- **New balance:** `2005 credits` (5 + 2000)

**Day 3 (after daily reset):**
- Credits used yesterday: `0`
- Credits added: `0` ❌ (Ultra plan doesn't get daily free credits)
- New balance: `2005 credits` (unchanged)

---

### Scenario 10: Pro Plan User - Monthly Credits System

**Month 1 (Pro Plan - 1000 credits):**
- Starting balance: `1000 credits` (from purchase)
- Uses throughout month: `850 credits`
- Ending balance: `150 credits`

**Month 2 (after monthly reset):**
- Monthly counter reset: `credits_used_this_month = 0`
- **New monthly allocation:** `+1000 credits` (subscription renewed)
- New balance: `1150 credits` (150 + 1000)

**Month 2 (user activity):**
- Uses: `1200 credits`
- Ending balance: `-50 credits` ❌ (exceeded monthly limit)
- **Result:** User cannot use more credits until next month or purchase additional credits

---

### Scenario 11: User Downgrades from Pro to Free

**Month 1 (Pro Plan):**
- Starting balance: `1000 credits`
- Uses: `200 credits`
- Ending balance: `800 credits`

**User downgrades to Free:**
- Plan changed: `Pro` → `Free`
- **Balance preserved:** `800 credits` (kept from Pro plan)
- Daily counter reset: `credits_used_today = 0`
- Monthly counter reset: `credits_used_this_month = 0`

**Day 1 (Free Plan):**
- Starting balance: `800 credits` (from Pro plan)
- Uses: `1 credit` (1 chat message)
- Ending balance: `799 credits`

**Day 2 (after daily reset):**
- Credits used yesterday: `1`
- Credits added: `+1` ✅ (daily free credits restored)
- New balance: `800 credits` (799 + 1 = 800)

**Note:** User keeps all purchased credits, but now gets daily free credits again (up to 5 per day if used).

---

## 💬 Chat Message Credit Deduction Examples

### Example 1: Simple Chat Conversation

**User sends message:**
1. Check balance: `5 credits` ✅
2. Call OpenAI API
3. Get response
4. Deduct: `-1 credit`
5. New balance: `4 credits`

**User sends another message:**
1. Check balance: `4 credits` ✅
2. Call OpenAI API
3. Get response
4. Deduct: `-1 credit`
5. New balance: `3 credits`

---

### Example 2: Insufficient Credits

**User sends message:**
1. Check balance: `0 credits` ❌
2. **Response:** `402 Payment Required`
   ```json
   {
     "success": false,
     "error": "Insufficient credits",
     "message": "Daily credit limit exceeded",
     "daily_remaining": 0,
     "monthly_remaining": 0
   }
   ```
3. OpenAI API **NOT called** (saves costs)

---

### Example 3: OpenAI API Fails (Fallback)

**User sends message:**
1. Check balance: `5 credits` ✅
2. Call OpenAI API
3. **OpenAI fails** (timeout/error)
4. Use fallback response
5. **Credits NOT deducted** (no charge for failed requests)
6. Balance: `5 credits` (unchanged)

---

## 🔄 Daily Reset Process Flow

```
┌─────────────────────────────────────────┐
│  Daily Cron Job (runs at 00:00 UTC)    │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  reset_daily_credits()                  │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌──────────────┐      ┌──────────────────┐
│ Free Plan    │      │ Pro/Ultra Plans   │
│ Users        │      │ Users             │
└──────────────┘      └──────────────────┘
        │                       │
        ▼                       ▼
┌──────────────────┐  ┌──────────────────┐
│ Check usage:     │  │ Reset counter:   │
│ - Used >= 1?     │  │ credits_used_    │
│   → Add credits  │  │   today = 0      │
│ - Used 0?        │  │                   │
│   → Skip         │  │ (No credits      │
│                   │  │  added)          │
└──────────────────┘  └──────────────────┘
```

---

## 📝 Summary Table

| Credits Used Yesterday | Credits Added | New Balance (if was 5) | Status |
|------------------------|---------------|------------------------|--------|
| 0 | 0 | 5 | ❌ No replenishment |
| 1 | +1 | 5 | ✅ Restored |
| 2 | +2 | 5 | ✅ Restored |
| 3 | +3 | 5 | ✅ Restored |
| 4 | +4 | 5 | ✅ Restored |
| 5 | +5 | 5 | ✅ Restored |
| 6+ | +5 | 10+ | ✅ Restored (max 5 added) |

---

## 🎯 Key Points

### Free Plan:
1. **Daily replenishment:** Works only for free plan users
2. **Minimum usage required:** Must use at least 1 credit to get replenishment
3. **Restore to 5:** System always restores to 5 credits (not more)
4. **Daily limit:** 5 credits per day (if used)
5. **Monthly limit:** 30 credits per month

### Pro/Ultra Plans:
1. **No daily replenishment:** Pro/Ultra users don't get daily free credits
2. **Monthly allocation:** Credits added monthly (1000, 1500, 2000, etc.)
3. **No daily limit:** Can use all monthly credits in one day
4. **Balance preserved:** Existing credits kept when upgrading/downgrading
5. **Monthly reset:** Counter resets, new credits added if subscription active

### General:
1. **Chat costs:** 1 credit per chat message (fixed cost, all plans)
2. **No charge for failures:** Failed OpenAI requests don't deduct credits
3. **Balance check first:** Credits checked BEFORE OpenAI API call (saves costs)
4. **Balance preserved:** Credits balance kept when switching plans
