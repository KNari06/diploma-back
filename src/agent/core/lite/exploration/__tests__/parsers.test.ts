/**
 * Prompt parsers tests — scout / sentinel / strategist
 * Tests resilience against malformed AI output, type coercion, and edge cases.
 */

import { parseScoutResponse } from '../agents/scout-prompts';
import { parseSentinelResponse } from '../agents/sentinel-prompts';
import { parseStrategistResponse } from '../agents/strategist-prompts';

describe('parseScoutResponse', () => {
  it('parses valid JSON', () => {
    const raw = JSON.stringify({
      newEntryPoints: [
        { name: 'Edit Profile', goal: 'Navigate to profile and edit fields', category: 'user_management', priority: 'high', requiresAuth: true, estimatedComplexity: 'medium', relatedElements: [] },
      ],
      newPages: ['/settings'],
      insight: 'Dashboard revealed profile link',
    });
    const out = parseScoutResponse(raw);
    expect(out.newEntryPoints).toHaveLength(1);
    expect(out.newEntryPoints[0].category).toBe('user_management');
    expect(out.newPages).toEqual(['/settings']);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"newEntryPoints":[],"newPages":[],"insight":"none"}\n```';
    const out = parseScoutResponse(raw);
    expect(out.insight).toBe('none');
  });

  it('returns safe defaults when category is invalid', () => {
    const raw = JSON.stringify({
      newEntryPoints: [{ name: 'X', goal: 'Y', category: 'garbage', priority: 'alien', estimatedComplexity: 'nope' }],
      newPages: [],
      insight: '',
    });
    const out = parseScoutResponse(raw);
    expect(out.newEntryPoints[0].category).toBe('other');
    expect(out.newEntryPoints[0].priority).toBe('medium');
    expect(out.newEntryPoints[0].estimatedComplexity).toBe('medium');
  });

  it('filters entries missing required fields (name, goal)', () => {
    const raw = JSON.stringify({
      newEntryPoints: [
        { name: 'Valid', goal: 'Do valid thing' },
        { name: 'NoGoal' }, // missing goal — should be filtered
        { goal: 'NoName' }, // missing name — should be filtered
        null,
      ],
      newPages: [],
      insight: '',
    });
    const out = parseScoutResponse(raw);
    expect(out.newEntryPoints).toHaveLength(1);
    expect(out.newEntryPoints[0].name).toBe('Valid');
  });

  it('returns empty defaults on invalid JSON', () => {
    const out = parseScoutResponse('not json at all {');
    expect(out.newEntryPoints).toEqual([]);
    expect(out.newPages).toEqual([]);
    expect(out.insight).toContain('Failed');
  });

  it('handles non-array fields gracefully', () => {
    const raw = JSON.stringify({
      newEntryPoints: 'not an array',
      newPages: null,
      insight: 42,
    });
    const out = parseScoutResponse(raw);
    expect(out.newEntryPoints).toEqual([]);
    expect(out.newPages).toEqual([]);
    expect(out.insight).toBe('No additional insight');
  });

  it('filters non-string entries in newPages', () => {
    const raw = JSON.stringify({
      newEntryPoints: [],
      newPages: ['/a', 42, null, '/b'],
      insight: '',
    });
    const out = parseScoutResponse(raw);
    expect(out.newPages).toEqual(['/a', '/b']);
  });
});

describe('parseSentinelResponse', () => {
  it('parses valid JSON', () => {
    const raw = JSON.stringify({
      coverageScore: 72,
      gaps: ['search untested'],
      continueExploring: true,
      focusNext: ['search'],
      qualitySummary: 'Good core coverage, missing search',
      recommendations: ['Test search'],
      riskAreas: ['error:checkout — 3 errors'],
    });
    const out = parseSentinelResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.coverageScore).toBe(72);
    expect(out!.gaps).toEqual(['search untested']);
    expect(out!.continueExploring).toBe(true);
  });

  it('clamps coverageScore to [0, 100]', () => {
    const r1 = parseSentinelResponse(JSON.stringify({ coverageScore: 150, gaps: [], continueExploring: false, qualitySummary: '', recommendations: [], riskAreas: [] }));
    const r2 = parseSentinelResponse(JSON.stringify({ coverageScore: -10, gaps: [], continueExploring: false, qualitySummary: '', recommendations: [], riskAreas: [] }));
    expect(r1!.coverageScore).toBe(100);
    expect(r2!.coverageScore).toBe(0);
  });

  it('rounds fractional coverageScore', () => {
    const out = parseSentinelResponse(JSON.stringify({ coverageScore: 72.7, gaps: [], continueExploring: false, qualitySummary: '', recommendations: [], riskAreas: [] }));
    expect(out!.coverageScore).toBe(73);
  });

  it('returns null on invalid JSON', () => {
    expect(parseSentinelResponse('nope')).toBeNull();
  });

  it('coerces invalid types to safe defaults', () => {
    const raw = JSON.stringify({
      coverageScore: 'not a number',
      gaps: 'not an array',
      continueExploring: 'truthy',
      qualitySummary: null,
      recommendations: null,
      riskAreas: null,
    });
    const out = parseSentinelResponse(raw);
    expect(out!.coverageScore).toBe(0);
    expect(out!.gaps).toEqual([]);
    expect(out!.qualitySummary).toBe('No summary available');
  });
});

describe('parseStrategistResponse', () => {
  it('parses full valid strategy', () => {
    const raw = JSON.stringify({
      plan: [
        { entryPointId: 'ep-1', name: 'Login', priority: 1, reason: 'Auth first' },
        { entryPointId: 'ep-2', name: 'Profile', priority: 2, reason: 'Needs auth', dependsOn: 'ep-1' },
      ],
      authPlan: {
        loginFirst: true,
        loginEntryPointId: 'ep-1',
        authGatedFlows: ['ep-2'],
      },
      continueSurvey: false,
      skipFlows: [{ id: 'ep-99', reason: 'redundant' }],
      focusAreas: ['authentication'],
      strategyReasoning: 'Login first, then auth-gated.',
    });
    const out = parseStrategistResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.plan).toHaveLength(2);
    expect(out!.plan[1].dependsOn).toBe('ep-1');
    expect(out!.authPlan.loginFirst).toBe(true);
    expect(out!.skipFlows).toEqual([{ id: 'ep-99', reason: 'redundant' }]);
  });

  it('returns null on invalid JSON', () => {
    expect(parseStrategistResponse('{"broken":')).toBeNull();
  });

  it('fills authPlan with safe defaults when missing', () => {
    const raw = JSON.stringify({ plan: [], strategyReasoning: 'none' });
    const out = parseStrategistResponse(raw);
    expect(out!.authPlan.loginFirst).toBe(false);
    expect(out!.authPlan.authGatedFlows).toEqual([]);
  });

  it('filters plan entries missing entryPointId', () => {
    const raw = JSON.stringify({
      plan: [
        { entryPointId: 'ep-1', name: 'Valid', priority: 1 },
        { name: 'No ID' }, // should be filtered
        null,
      ],
    });
    const out = parseStrategistResponse(raw);
    expect(out!.plan).toHaveLength(1);
  });

  it('filters skipFlows missing id', () => {
    const raw = JSON.stringify({
      plan: [],
      skipFlows: [{ id: 'ep-1', reason: 'ok' }, { reason: 'no id' }, null],
    });
    const out = parseStrategistResponse(raw);
    expect(out!.skipFlows).toHaveLength(1);
    expect(out!.skipFlows[0].id).toBe('ep-1');
  });

  it('treats missing surveyTargets as undefined', () => {
    const raw = JSON.stringify({ plan: [], continueSurvey: true });
    const out = parseStrategistResponse(raw);
    expect(out!.surveyTargets).toBeUndefined();
  });

  it('auto-assigns priority when not provided', () => {
    const raw = JSON.stringify({
      plan: [
        { entryPointId: 'ep-1', name: 'A' },
        { entryPointId: 'ep-2', name: 'B' },
      ],
    });
    const out = parseStrategistResponse(raw);
    expect(out!.plan[0].priority).toBe(1);
    expect(out!.plan[1].priority).toBe(2);
  });
});
