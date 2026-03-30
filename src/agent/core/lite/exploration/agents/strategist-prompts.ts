/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STRATEGIST AGENT — Prompts & Parsers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds prompts for the Strategist agent — the strategic brain of exploration.
 * Strategist sees the COMPLETE exploration state and makes informed decisions
 * about what to explore next, in what order, and when to stop.
 *
 * Key design: NO static priority formula. AI reasons about priorities
 * with full context of the application, discovered pages, and execution results.
 */

import type {
  StrategistInput,
  StrategistOutput,
  StrategistFlowPlan,
  AuthPlan,
  CartographerInsight,
  FlowSummary,
  BlockedFlowSummary,
  ScoutDiscovery,
  SentinelAssessment,
  ExplorationTreeSummary,
} from './agent-types';

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export const STRATEGIST_SYSTEM_PROMPT = `You are a QA test strategy planner (Strategist) for autonomous web application exploration. You see the COMPLETE exploration state — all discovered pages, entry points, execution results, and coverage gaps — and decide what to explore next.

Your responsibilities:
1. PRIORITIZE flows for maximum test coverage with limited budget
2. PLAN auth strategy (login first if credentials available)
3. IDENTIFY dependencies between flows ("login before profile edit")
4. DECIDE whether more pages need surveying
5. SKIP flows that are redundant or low-value given budget constraints
6. RESPOND to user directives (focus areas, skip requests)

PRINCIPLES:
- Auth flows must run BEFORE auth-gated flows — always place login at priority 1
- Prioritize DIVERSE category coverage over depth in one category (1 checkout + 1 search beats 3 checkout)
- Critical business flows (login, checkout, registration) before secondary features
- Pages with more interactive areas deserve more flows allocated to them
- Respect the user's scope hint — flows matching scope get priority boost
- Be budget-aware — if only 5 flows remain, pick the 5 most valuable across different categories

WHEN TO continueSurvey:
- Set continueSurvey: true if: fewer than 3 pages discovered AND there are UNVISITED NAV LINKS available, OR a specific unexplored URL was mentioned in page insights
- When setting continueSurvey: true, populate surveyTargets with SPECIFIC URLs from the UNVISITED NAV LINKS section — never use already-visited page URLs
- Do NOT set continueSurvey: true just because coverage is low — explore what's already discovered first
- Do NOT put already-visited URLs in surveyTargets — they will be skipped

WHEN TO skipFlows:
- Skip if same category has 3+ completed flows and coverage there is already good
- Skip navigation-only flows (just clicking a link) if deeper flows on that page exist
- Skip if budget is critically low (≤2 flows) — save for highest priority only
- Skip flows that reference external/third-party services (e.g., "Log in to Udemy", "Buy on Amazon") — these navigate away from the app under test and waste budget

strategyReasoning MUST explain:
1. Why auth flows are ordered first (if applicable)
2. Which categories you're prioritizing and why
3. What you're skipping and the reason

Respond with valid JSON only.`;

// ═══════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

export function buildStrategistPrompt(input: StrategistInput): string {
  const sections: string[] = [];

  // Scope hint
  if (input.scopeHint) {
    sections.push(`USER SCOPE: "${input.scopeHint}" — prioritize flows related to this area.`);
  }

  // User directive (WebSocket intervention)
  if (input.userDirective) {
    sections.push(`USER DIRECTIVE (just received): "${input.userDirective}"
Apply this directive to your planning decisions.`);
  }

  // Credentials
  if (input.hasCredentials) {
    sections.push(`CREDENTIALS: Available. Auth flows should run first if login pages were detected.`);
  }

  // Budget
  sections.push(`BUDGET REMAINING:
- Time: ${Math.round(input.budget.timeRemainingMs / 1000)}s
- Flows: ${input.budget.flowsRemaining} remaining
- Pipeline rounds: ${input.budget.roundsRemaining} remaining`);

  // Tree summary
  const tree = input.tree;
  sections.push(`DISCOVERED PAGES (${tree.totalPages} pages, ${tree.totalEntryPoints} total entry points):`);
  for (const page of tree.pages) {
    sections.push(`  [${page.id}] ${page.url} — ${page.pageType}, ${page.entryPointCount} entry points${page.requiresAuth ? ' [AUTH REQUIRED]' : ''}, depth=${page.depth}`);
  }

  // Page insights (condensed summary to save tokens)
  if (input.pageInsights.length > 0) {
    sections.push(`\nPAGE INSIGHTS:`);
    for (const insight of input.pageInsights) {
      const summary: string[] = [];
      if (insight.interactiveAreas.length > 0) summary.push(`${insight.interactiveAreas.length} interactive areas`);
      if (insight.forms?.length > 0) summary.push(`${insight.forms.length} forms`);
      if (insight.dataEntities.length > 0) summary.push(`data: ${insight.dataEntities.slice(0, 3).join(', ')}${insight.dataEntities.length > 3 ? '...' : ''}`);
      if (insight.stateIndicators.length > 0) summary.push(`state: ${insight.stateIndicators.slice(0, 2).join(', ')}${insight.stateIndicators.length > 2 ? '...' : ''}`);
      summary.push(insight.complexity);
      sections.push(`  ${insight.pageId} (${insight.pageType}): ${summary.join(' | ')}`);
    }
  }

  // Unvisited nav links — concrete URLs the Strategist can suggest as surveyTargets
  if (input.unvisitedNavLinks.length > 0) {
    sections.push(`\nUNVISITED NAV LINKS (${input.unvisitedNavLinks.length} — discovered but not yet surveyed):`);
    for (const link of input.unvisitedNavLinks.slice(0, 15)) {
      sections.push(`  "${link.label}" → ${link.url} (found on ${link.sourcePageUrl})`);
    }
    if (input.unvisitedNavLinks.length > 15) {
      sections.push(`  ... and ${input.unvisitedNavLinks.length - 15} more`);
    }
  }

  // All entry points — condense goal for large lists to save tokens
  sections.push(`\nALL ENTRY POINTS (${input.allEntryPoints.length}):`);
  const showFullGoal = input.allEntryPoints.length <= 20;
  for (const ep of input.allEntryPoints) {
    const goalText = showFullGoal
      ? `\n    Goal: ${ep.goal}`
      : `  | goal: ${ep.goal.slice(0, 60)}${ep.goal.length > 60 ? '…' : ''}`;
    sections.push(`  [${ep.id}] "${ep.name}" — ${ep.category}, ${ep.priority}${ep.requiresAuth ? ' [AUTH]' : ''}${ep.dependsOn ? ` [depends: ${ep.dependsOn}]` : ''}${goalText}`);
  }

  // Completed flows (if re-evaluating)
  if (input.completedFlows.length > 0) {
    sections.push(`\nCOMPLETED FLOWS (${input.completedFlows.length}):`);
    for (const f of input.completedFlows) {
      sections.push(`  "${f.name}" — ${f.status}${f.goalAchieved ? ' (goal achieved)' : ''}, ${f.stepsCount} steps, ${f.errorsCount} errors`);
    }
  }

  // Blocked flows
  if (input.blockedFlows.length > 0) {
    sections.push(`\nBLOCKED FLOWS:`);
    for (const f of input.blockedFlows) {
      sections.push(`  "${f.name}" — blocked by ${f.blockerType}: ${f.reason}${f.canUserHelp ? ' (user can help)' : ''}`);
    }
  }

  // Scout discoveries
  if (input.recentDiscoveries.length > 0) {
    sections.push(`\nRECENT DISCOVERIES (from Scout):`);
    for (const d of input.recentDiscoveries) {
      sections.push(`  After "${d.sourceFlowName}": ${d.newEntryPoints.length} new flows, ${d.newPages.length} new pages`);
      sections.push(`  Insight: ${d.insight}`);
    }
  }

  // Coverage assessment (if available)
  if (input.coverageAssessment) {
    sections.push(`\nCOVERAGE ASSESSMENT (from Sentinel):
- Score: ${input.coverageAssessment.coverageScore}/100
- Gaps: ${input.coverageAssessment.gaps.join(', ')}
- Summary: ${input.coverageAssessment.qualitySummary}`);
  }

  sections.push(`\nRESPONSE FORMAT (JSON):
{
  "plan": [
    {
      "entryPointId": "ep-123",
      "name": "User Login",
      "priority": 1,
      "reason": "Auth flow must run first — 5 other flows depend on being logged in",
      "dependsOn": null
    }
  ],
  "authPlan": {
    "loginFirst": true,
    "loginEntryPointId": "ep-123",
    "loginUrl": "/login",
    "authGatedFlows": ["ep-456", "ep-789"]
  },
  "continueSurvey": false,
  "surveyTargets": [],
  "skipFlows": [
    {"id": "ep-999", "reason": "Low-value content page, not worth budget"}
  ],
  "focusAreas": ["authentication", "e_commerce"],
  "strategyReasoning": "Prioritizing login → checkout flow. 3 auth-gated flows need login first. Skipping 2 low-priority content flows to save budget for checkout."
}`);

  return sections.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSER
// ═══════════════════════════════════════════════════════════════════════════

export function parseStrategistResponse(raw: string): StrategistOutput | null {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const plan: StrategistFlowPlan[] = Array.isArray(parsed.plan)
      ? parsed.plan
          .filter((p: any) => p && typeof p.entryPointId === 'string')
          .map((p: any, idx: number): StrategistFlowPlan => ({
            entryPointId: String(p.entryPointId),
            name: String(p.name || ''),
            priority: typeof p.priority === 'number' ? p.priority : idx + 1,
            reason: String(p.reason || ''),
            dependsOn: typeof p.dependsOn === 'string' ? p.dependsOn : undefined,
          }))
      : [];

    const authPlan: AuthPlan = parsed.authPlan
      ? {
          loginFirst: Boolean(parsed.authPlan.loginFirst),
          loginEntryPointId: typeof parsed.authPlan.loginEntryPointId === 'string'
            ? parsed.authPlan.loginEntryPointId : undefined,
          loginUrl: typeof parsed.authPlan.loginUrl === 'string'
            ? parsed.authPlan.loginUrl : undefined,
          authGatedFlows: Array.isArray(parsed.authPlan.authGatedFlows)
            ? parsed.authPlan.authGatedFlows.filter((id: any) => typeof id === 'string')
            : [],
        }
      : { loginFirst: false, authGatedFlows: [] };

    const skipFlows = Array.isArray(parsed.skipFlows)
      ? parsed.skipFlows
          .filter((s: any) => s && typeof s.id === 'string')
          .map((s: any) => ({ id: String(s.id), reason: String(s.reason || '') }))
      : [];

    const focusAreas = Array.isArray(parsed.focusAreas)
      ? parsed.focusAreas.map(String)
      : [];

    return {
      plan,
      authPlan,
      continueSurvey: Boolean(parsed.continueSurvey),
      surveyTargets: Array.isArray(parsed.surveyTargets)
        ? parsed.surveyTargets.map(String)
        : undefined,
      skipFlows,
      focusAreas,
      strategyReasoning: typeof parsed.strategyReasoning === 'string'
        ? parsed.strategyReasoning
        : 'No reasoning provided',
    };
  } catch {
    return null;
  }
}
