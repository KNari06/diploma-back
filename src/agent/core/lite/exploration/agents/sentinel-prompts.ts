/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SENTINEL AGENT — Prompts & Parsers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds prompts for the Sentinel agent — the coverage evaluator.
 * Sentinel sees ALL exploration results and page insights to produce
 * an intelligent coverage assessment.
 */

import type {
  SentinelInput,
  SentinelAssessment,
  CartographerInsight,
  FlowSummary,
  BlockedFlowSummary,
} from './agent-types';

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export const SENTINEL_SYSTEM_PROMPT = `You are a QA coverage evaluator (Sentinel) for autonomous web application exploration. You see the COMPLETE exploration results — all discovered pages, their capabilities, all executed test flows, and what was skipped or blocked.

Your job is to:
1. ESTIMATE coverage score (0-100) based on what was tested vs what exists
2. IDENTIFY gaps — areas that exist but weren't tested
3. DECIDE whether to continue exploring or stop
4. PRODUCE a user-facing quality summary
5. FLAG risk areas where errors were found
6. RECOMMEND actionable improvements

COVERAGE SCORING GUIDELINES:
- 90-100: Excellent — all major flows tested, all categories covered
- 70-89: Good — most major flows tested, minor gaps
- 50-69: Fair — key flows tested but significant areas untouched
- 30-49: Partial — only some areas covered, important gaps
- 0-29: Minimal — very few flows tested

CONTINUE EXPLORING when:
- Coverage score < 70 AND budget allows
- Critical categories (auth, checkout) haven't been tested
- Pages with many entry points were discovered but not explored

STOP EXPLORING when:
- Coverage score >= 80
- Budget is nearly exhausted
- Remaining flows are low-priority
- All critical and high-priority flows have been tested

Respond with valid JSON only.`;

// ═══════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

export function buildSentinelPrompt(input: SentinelInput): string {
  const sections: string[] = [];

  if (input.scopeHint) {
    sections.push(`USER SCOPE: "${input.scopeHint}" — evaluate coverage relative to this scope.`);
  }

  // Budget
  sections.push(`BUDGET REMAINING:
- Time: ${Math.round(input.budget.timeRemainingMs / 1000)}s
- Flows: ${input.budget.flowsRemaining} remaining`);

  // Pages discovered
  sections.push(`PAGES DISCOVERED: ${input.pagesDiscovered}`);

  // Page insights — what EXISTS in the app
  if (input.pageInsights.length > 0) {
    sections.push(`\nWHAT EXISTS IN THE APP (from page analysis):`);
    for (const insight of input.pageInsights) {
      const parts: string[] = [];
      parts.push(`  ${insight.pageType} page (${insight.complexity}):`);
      if (insight.interactiveAreas.length > 0) parts.push(`    Areas: ${insight.interactiveAreas.join(', ')}`);
      if (insight.dataEntities.length > 0) parts.push(`    Data: ${insight.dataEntities.join(', ')}`);
      if (insight.forms.length > 0) parts.push(`    Forms: ${insight.forms.length} detected`);
      sections.push(parts.join('\n'));
    }
  }

  // What was TESTED
  if (input.completedFlows.length > 0) {
    sections.push(`\nWHAT WAS TESTED (${input.completedFlows.length} flows):`);
    for (const f of input.completedFlows) {
      const status = f.goalAchieved ? 'PASSED' : f.status.toUpperCase();
      sections.push(`  "${f.name}" [${f.category}] — ${status}, ${f.stepsCount} steps, ${f.errorsCount} errors`);
    }
  }

  // What was BLOCKED
  if (input.blockedFlows.length > 0) {
    sections.push(`\nBLOCKED FLOWS:`);
    for (const f of input.blockedFlows) {
      sections.push(`  "${f.name}" — ${f.blockerType}: ${f.reason}`);
    }
  }

  // What was SKIPPED
  if (input.skippedFlows.length > 0) {
    sections.push(`\nSKIPPED FLOWS (${input.skippedFlows.length}):`);
    for (const f of input.skippedFlows) {
      sections.push(`  "${f.name}" [${f.category}] — ${f.reason}`);
    }
  }

  // Summary stats
  sections.push(`\nSUMMARY STATS:
- Categories covered: ${input.categoriesCovered.join(', ') || 'none'}
- Total steps executed: ${input.totalStepsExecuted}
- Total errors found: ${input.errorsFound}`);

  sections.push(`\nRESPONSE FORMAT (JSON):
{
  "coverageScore": 72,
  "gaps": ["Search functionality not tested", "Settings page has 5 flows, none explored"],
  "continueExploring": true,
  "focusNext": ["search", "settings"],
  "qualitySummary": "Good coverage of authentication and e-commerce flows. Missing: search functionality and user settings. 3 console errors found in checkout.",
  "recommendations": ["Test search with various query types", "Explore settings page — 5 entry points found but none tested"],
  "riskAreas": ["Checkout page has 3 console errors", "Login fails intermittently"]
}`);

  return sections.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSER
// ═══════════════════════════════════════════════════════════════════════════

export function parseSentinelResponse(raw: string): SentinelAssessment | null {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      coverageScore: typeof parsed.coverageScore === 'number'
        ? Math.max(0, Math.min(100, Math.round(parsed.coverageScore)))
        : 0,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
      continueExploring: Boolean(parsed.continueExploring),
      focusNext: Array.isArray(parsed.focusNext) ? parsed.focusNext.map(String) : undefined,
      qualitySummary: typeof parsed.qualitySummary === 'string'
        ? parsed.qualitySummary
        : 'No summary available',
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map(String) : [],
      riskAreas: Array.isArray(parsed.riskAreas)
        ? parsed.riskAreas.map(String) : [],
    };
  } catch {
    return null;
  }
}
