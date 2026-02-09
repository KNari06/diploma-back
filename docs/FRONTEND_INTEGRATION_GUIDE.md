# Frontend Integration Guide - Backend Changes

**Date:** 2026-02-09
**Backend Version:** After AI Infrastructure & Multilingual Support
**Impact:** Medium - API response types updated, new data fields available

---

## 📋 **Summary of Backend Changes**

### **What Changed:**

1. ✅ **AI-Powered Keyword Extraction** - Now supports 100+ languages (not just English)
2. ✅ **Quality Checks Added to Test Results** - Performance, accessibility, broken resources, API latency
3. ✅ **Multilingual Credential Detection** - Supports 14 languages (EN, RU, TR, KZ, UK, DE, FR, ES, PT, IT, PL, ZH, JA, AR)
4. ✅ **Enhanced Element Resolution** - Better multilingual support for step linting

---

## 🔴 **REQUIRED Frontend Changes**

### **1. Update TypeScript Types for Test Results**

**API Endpoint:** `GET /api/manual-test/:id/result`

**NEW Response Fields Added:**

```typescript
interface TestResult {
  // ... existing fields ...

  // ✅ NEW: Quality check results (added 2026-02-09)
  quality_checks?: QualityCheckReport;
}

interface QualityCheckReport {
  performance: {
    loadTime: number;                    // Page load time (ms)
    domContentLoaded: number;            // DOM ready time (ms)
    firstContentfulPaint: number;        // FCP (ms)
    largestContentfulPaint: number;      // LCP (ms) - Core Web Vital
    firstInputDelay: number;             // FID (ms) - always 0 in automation
    cumulativeLayoutShift: number;       // CLS - Core Web Vital (0-1 scale)
    totalBlockingTime: number;           // TBT (ms) - interaction blocking
  };

  brokenResources: Array<{
    type: 'broken_image' | 'failed_stylesheet' | 'failed_script';
    url: string;                         // Resource URL that failed
    element?: string;                    // CSS selector (if available)
  }>;

  accessibility: {
    warnings: Array<{
      message: string;                   // Human-readable warning
      selector?: string;                 // Element selector
      wcag?: string;                     // WCAG criterion ID (e.g., "1.1.1", "2.4.4")
    }>;
    totalWarnings: number;               // Count of all a11y issues
  };

  apiPerformance: {
    totalRequests: number;               // Total API calls made during test
    averageResponseTime: number;         // Average response time (ms)
    p95ResponseTime: number;             // 95th percentile response time (ms)
    slowCalls: Array<{                   // API calls slower than 2s
      url: string;
      method: string;                    // GET, POST, etc.
      status: number;                    // HTTP status code
      responseTime: number;              // Response time (ms)
    }>;
  };
}
```

**Action Required:**

1. Update your TypeScript interfaces:
   ```typescript
   // src/types/test-results.ts (or wherever you define types)

   // Add this interface
   export interface QualityCheckReport {
     performance: {
       loadTime: number;
       domContentLoaded: number;
       firstContentfulPaint: number;
       largestContentfulPaint: number;
       firstInputDelay: number;
       cumulativeLayoutShift: number;
       totalBlockingTime: number;
     };
     brokenResources: Array<{
       type: 'broken_image' | 'failed_stylesheet' | 'failed_script';
       url: string;
       element?: string;
     }>;
     accessibility: {
       warnings: Array<{
         message: string;
         selector?: string;
         wcag?: string;
       }>;
       totalWarnings: number;
     };
     apiPerformance: {
       totalRequests: number;
       averageResponseTime: number;
       p95ResponseTime: number;
       slowCalls: Array<{
         url: string;
         method: string;
         status: number;
         responseTime: number;
       }>;
     };
   }

   // Update existing TestResult interface
   export interface TestResult {
     // ... existing fields ...
     quality_checks?: QualityCheckReport; // NEW field
   }
   ```

2. **Backward Compatibility:** Field is optional (`?`), so existing code won't break.

---

### **2. UI Components for Quality Checks (Optional but Recommended)**

**Where to Display:**

Show quality check results on the **Test Results Details** page.

**Recommended UI Structure:**

```tsx
// Example React component
import { QualityCheckReport } from '@/types/test-results';

interface QualityChecksPanelProps {
  qualityChecks?: QualityCheckReport;
}

export function QualityChecksPanel({ qualityChecks }: QualityChecksPanelProps) {
  if (!qualityChecks) return null;

  return (
    <div className="quality-checks-panel">
      {/* Performance Metrics */}
      <Section title="Performance (Web Vitals)">
        <Metric label="LCP" value={`${qualityChecks.performance.largestContentfulPaint}ms`}
                status={qualityChecks.performance.largestContentfulPaint < 2500 ? 'good' : 'warning'} />
        <Metric label="CLS" value={qualityChecks.performance.cumulativeLayoutShift.toFixed(3)}
                status={qualityChecks.performance.cumulativeLayoutShift < 0.1 ? 'good' : 'warning'} />
        <Metric label="TBT" value={`${qualityChecks.performance.totalBlockingTime}ms`}
                status={qualityChecks.performance.totalBlockingTime < 300 ? 'good' : 'warning'} />
      </Section>

      {/* Broken Resources */}
      {qualityChecks.brokenResources.length > 0 && (
        <Section title="Broken Resources" severity="warning">
          {qualityChecks.brokenResources.map((resource, idx) => (
            <ResourceItem key={idx} type={resource.type} url={resource.url} />
          ))}
        </Section>
      )}

      {/* Accessibility Warnings */}
      {qualityChecks.accessibility.totalWarnings > 0 && (
        <Section title="Accessibility Issues" severity="info">
          <p>{qualityChecks.accessibility.totalWarnings} warnings found</p>
          {qualityChecks.accessibility.warnings.slice(0, 5).map((warning, idx) => (
            <WarningItem key={idx} message={warning.message} wcag={warning.wcag} />
          ))}
        </Section>
      )}

      {/* Slow API Calls */}
      {qualityChecks.apiPerformance.slowCalls.length > 0 && (
        <Section title="Slow API Calls (>2s)" severity="warning">
          {qualityChecks.apiPerformance.slowCalls.map((call, idx) => (
            <ApiCallItem key={idx} method={call.method} url={call.url}
                         responseTime={call.responseTime} status={call.status} />
          ))}
        </Section>
      )}
    </div>
  );
}
```

**Design Guidelines:**

- **Performance:** Green if good (LCP < 2.5s, CLS < 0.1, TBT < 300ms), yellow if warning
- **Broken Resources:** Show as warnings (yellow), not errors (don't fail test)
- **Accessibility:** Show as info/suggestions, link to WCAG docs if `wcag` field present
- **Slow APIs:** Show as warnings, help users identify performance bottlenecks

---

## 🟡 **OPTIONAL Frontend Changes**

### **3. Language Support Indicators**

**Backend Now Supports:**

The following languages are fully supported for:
- Keyword extraction (test step descriptions)
- Credential field detection
- Element resolution

| Language | Code | Supported |
|----------|------|-----------|
| English | en | ✅ |
| Russian | ru | ✅ |
| Turkish | tr | ✅ |
| Kazakh | kk | ✅ |
| Ukrainian | uk | ✅ |
| German | de | ✅ |
| French | fr | ✅ |
| Spanish | es | ✅ |
| Portuguese | pt | ✅ |
| Italian | it | ✅ |
| Polish | pl | ✅ |
| Chinese | zh | ✅ |
| Japanese | ja | ✅ |
| Arabic | ar | ✅ |

**Recommended UI Change:**

If you have a language selector or documentation, update it to show these languages are supported.

```tsx
// Example language selector
const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'kk', name: 'Қазақша', flag: '🇰🇿' },
  { code: 'uk', name: 'Українська', flag: '🇺🇦' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹' },
  { code: 'pl', name: 'Polski', flag: '🇵🇱' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
  { code: 'ar', name: 'العربية', flag: '🇦🇪' },
];
```

**Note:** You DON'T need to send language preference to backend - it auto-detects from test step descriptions.

---

### **4. Enhanced Error Messages**

**No Action Required** - but be aware:

- Error messages from AI-powered features may now appear in multiple languages
- If you're parsing/displaying error messages, ensure UTF-8 encoding support
- Test with non-Latin characters (Cyrillic, Arabic, Chinese, etc.)

---

## ❌ **NO Changes Required For**

### **These Backend Changes Don't Affect Frontend:**

1. ✅ **AI Provider Infrastructure** - Internal backend only
2. ✅ **Gemini API Integration** - Backend AI provider, transparent to frontend
3. ✅ **Keyword Extraction Logic** - Happens server-side, no API changes
4. ✅ **Credential Pattern Expansion** - Backend detection only

---

## 🧪 **Testing Checklist**

### **For Frontend Developers:**

- [ ] Verify `quality_checks` field appears in test result responses (use browser DevTools → Network tab)
- [ ] Test with a completed test result - ensure `quality_checks` renders correctly (or is safely ignored if not implemented)
- [ ] Test with an old test result (before 2026-02-09) - ensure no crashes when `quality_checks` is `undefined`
- [ ] Verify TypeScript types compile without errors
- [ ] Test with non-English test descriptions (Russian, Chinese, etc.) - ensure they work
- [ ] Check that UTF-8 characters display correctly in test results

---

## 📊 **Example API Response**

**Before (old format):**
```json
{
  "id": "test-123",
  "status": "completed",
  "errors": [],
  "performance": {
    "loadTime": 1234,
    "domContentLoaded": 567
  }
}
```

**After (new format):**
```json
{
  "id": "test-123",
  "status": "completed",
  "errors": [],
  "performance": {
    "loadTime": 1234,
    "domContentLoaded": 567,
    "firstContentfulPaint": 890,
    "largestContentfulPaint": 1456,
    "firstInputDelay": 0,
    "cumulativeLayoutShift": 0.05,
    "totalBlockingTime": 125
  },
  "quality_checks": {
    "performance": {
      "loadTime": 1234,
      "domContentLoaded": 567,
      "firstContentfulPaint": 890,
      "largestContentfulPaint": 1456,
      "firstInputDelay": 0,
      "cumulativeLayoutShift": 0.05,
      "totalBlockingTime": 125
    },
    "brokenResources": [
      {
        "type": "broken_image",
        "url": "https://example.com/logo.png",
        "element": "img#header-logo"
      }
    ],
    "accessibility": {
      "warnings": [
        {
          "message": "3 images without alt text",
          "selector": "img:not([alt])",
          "wcag": "1.1.1"
        },
        {
          "message": "Page missing lang attribute on <html>",
          "selector": "html",
          "wcag": "3.1.1"
        }
      ],
      "totalWarnings": 2
    },
    "apiPerformance": {
      "totalRequests": 15,
      "averageResponseTime": 234,
      "p95ResponseTime": 1234,
      "slowCalls": [
        {
          "url": "https://api.example.com/slow-endpoint",
          "method": "GET",
          "status": 200,
          "responseTime": 3456
        }
      ]
    }
  }
}
```

---

## 🔗 **Related Documentation**

- [AI Provider Guide](./AI_PROVIDER_GUIDE.md) - Backend AI infrastructure details
- [Quality Checks Implementation](../supabase-migrations/20260209_test_results_quality_checks.sql) - Database schema

---

## 📞 **Questions?**

- **Backend Team:** Ask about `quality_checks` implementation, AI providers, multilingual support
- **Frontend Team:** Implement UI for quality checks display, update TypeScript types

---

## 🚀 **Deployment Timeline**

| Date | Change | Frontend Action |
|------|--------|-----------------|
| 2026-02-09 | Backend deployed with `quality_checks` | Update TypeScript types (required) |
| TBD | Frontend UI for quality checks | Implement UI components (optional) |

---

**Last Updated:** 2026-02-09
**Maintained By:** Backend Team
