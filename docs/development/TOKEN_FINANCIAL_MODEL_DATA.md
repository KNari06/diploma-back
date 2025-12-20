# Token Financial Model - Source Data

## 📊 Credit System

### Conversion Rate

- **1 credit = 562.5 tokens**
- Formula: `credits = CEIL(tokens / 562.5)`
- Reverse: `tokens = credits * 562.5`

### Source

- Calculated from: $28.9/month = 1000 credits (Pro Plan)
- AI budget: $4.50 / $0.008 per 1K tokens = 562,500 tokens
- 562,500 tokens ÷ 1000 credits = 562.5 tokens per credit

---

## 💰 Pricing Plans

### Pro Plan

- **Price**: $28.9/month
- **Credits**: 1000 credits
- **Tokens**: 562,500 tokens (1000 × 562.5)

### Ultra Plan

- **Price**: $43.9/month
- **Credits**: 1000 credits
- **Tokens**: 562,500 tokens (1000 × 562.5)

### Minimum Purchase

- **Minimum**: 1000 credits per user

---

## 🤖 AI Models & Pricing

### GPT-4o-mini (Primary Model)

- **Input**: $0.00015 per 1K tokens
- **Output**: $0.0006 per 1K tokens
- **Usage**: Default for most operations (intent parsing, test plans, DOM analysis)

### GPT-4o

- **Input**: $0.005 per 1K tokens
- **Output**: $0.015 per 1K tokens
- **Usage**: Vision analysis, complex operations

### GPT-4o-vision

- **Input**: $0.0025 per 1K tokens
- **Output**: $0.01 per 1K tokens
- **Image Base**: $0.00425 per image
- **Image Per Tile**: $0.00085 per 512x512 tile
- **Usage**: Screenshot analysis

### Note on Pricing Discrepancy

- `TokenCalculatorService.MODEL_PRICING`: gpt-4o input $0.005, output $0.015
- `AICostManager.AI_PRICING`: gpt-4o input $0.0025, output $0.01
- **Use TokenCalculatorService pricing for financial model** (used in actual cost calculations)

---

## 🧪 Test Costs (Fixed Credits)

### Intelligent Test

- **Credits**: 20 credits (fixed)
- **Tokens**: ~11,250 tokens (20 × 562.5)
- **Usage**: All UI tests (standard mode removed)

### API Test

- **Credits**: 2 credits (fixed)
- **Tokens**: ~1,125 tokens (2 × 562.5)

### Chat

- **Credits**: 1 credit per message (fixed)
- **Tokens**: ~562.5 tokens (1 × 562.5)

### Standard Test

- **Deprecated**: Maps to intelligent (20 credits)

---

## 📈 Token Usage Estimates

### Per Page (Intelligent Test)

- **Tokens per page**: 1,400 tokens
  - Screenshot: 700 tokens
  - DOM: 300 tokens
  - Prompt: 200 tokens
  - Response: 200 tokens

### Report Generation

- **Tokens**: 1,400 tokens
  - Input: 800 tokens
  - Output: 600 tokens

### Screenshot Analysis

- **Tokens per screenshot**: 900 tokens
  - Input: 700 tokens
  - Output: 200 tokens
- **Model**: GPT-4o
- **Cost per screenshot**: Calculated via `calculateCostFromTokens(700, 200, 'gpt-4o')`

### Example: 10-Page Test

- Pages: 10 × 1,400 = 14,000 tokens
- Report: 1,400 tokens
- **Total**: 15,400 tokens
- **Credits**: CEIL(15,400 / 562.5) = 28 credits
- **Fixed cost**: 20 credits (actual charge)

---

## ⏱️ UI Test Limits (5 Minutes)

### Execution Limits

- **Max execution time**: 5 minutes (300,000 ms)
- **Max pages per run**: 10 pages
- **Max total pages**: 50 pages (across all continuation runs)
- **Max continuation runs**: 5 runs

### Typical Test Duration

- **Page scope**: 3-5 minutes
- **Form scope**: 3-5 minutes
- **Auth scope**: 3-5 minutes
- **Full scope**: 10-15 minutes
- **Element scope**: 2-3 minutes

### Exploration Timeout

- **Max exploration timeout**: 5 minutes
- **Default**: 5 minutes (configurable via env)

---

## 💵 Cost Calculation Examples

### Intelligent Test (10 pages, GPT-4o-mini)

- Input tokens: 10,000 (estimated)
- Output tokens: 4,000 (estimated)
- **Cost**: (10,000/1000 × $0.00015) + (4,000/1000 × $0.0006) = $0.0015 + $0.0024 = **$0.0039**
- **Credits charged**: 20 credits
- **User revenue**: (20/1000) × $28.9 = **$0.578**
- **Margin**: ($0.578 - $0.0039) / $0.578 = **99.3%**

### Intelligent Test (10 pages, GPT-4o)

- Input tokens: 10,000
- Output tokens: 4,000
- **Cost**: (10,000/1000 × $0.005) + (4,000/1000 × $0.015) = $0.05 + $0.06 = **$0.11**
- **Credits charged**: 20 credits
- **User revenue**: **$0.578**
- **Margin**: ($0.578 - $0.11) / $0.578 = **81.0%**

### Screenshot Analysis (1 screenshot, GPT-4o)

- Input tokens: 700
- Output tokens: 200
- **Cost**: (700/1000 × $0.005) + (200/1000 × $0.015) = $0.0035 + $0.003 = **$0.0065**

---

## 📋 Browser Costs (Manual Tests)

### Per Browser

- Chrome: 1 credit
- Firefox: 1 credit
- Safari: 1 credit
- Edge: 1 credit
- Mobile Chrome: 2 credits
- Mobile Safari: 2 credits

### Intelligent Mode

- Base browser cost + AI cost
- AI cost: Parsed from `estimatedCost` string or 2x multiplier
- Conversion: 1 credit = $0.01 (for manual test cost estimation)

---

## 🔄 Token Distribution (Typical)

- **Input tokens**: 70% of total
- **Output tokens**: 30% of total

Use this ratio for cost calculations when only total tokens are known.

---

## 📝 Notes

1. **Fixed vs Calculated**: Tests charge fixed credits (20 for intelligent) regardless of actual token usage
2. **Standard mode removed**: All UI tests use intelligent mode (20 credits)
3. **Pricing discrepancy**: Two pricing sources exist - use `TokenCalculatorService.MODEL_PRICING` for financial model
4. **Minimum purchase**: Users must buy at least 1000 credits
5. **Margin calculation**: Based on Pro Plan price ($28.9/1000 credits)

---

## 📊 Data Sources

- `src/services/core/token-calculator.service.ts` - Main conversion logic
- `src/services/core/credit-cost-tracker.service.ts` - Cost tracking
- `src/services/ai/ai-cost-manager.service.ts` - Budget management
- `src/config/testing/intelligent-test-limits.ts` - Test limits
- `src/services/testing/ui/manual/test-credits.ts` - Manual test costs
- `supabase-migrations/features/token-based-credits-system.sql` - DB functions
