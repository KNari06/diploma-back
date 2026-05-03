/**
 * V25 — locator plan token-chain enrichment tests.
 *
 * Verifies that buildCompiledPlan augments long-text + no-anchor nodes
 * with LLM-derived token chains, while:
 *   - leaving testId/role/href elements unchanged (no LLM call, no new entries)
 *   - skipping enrichment when LLM returns []
 *   - keeping all existing strategies as fallbacks
 */

jest.mock('@/services/ai/core/gemini.service', () => ({
  generateTextWithGemini: jest.fn(),
}));

import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { LocatorPlanBuilder } from '../locator-plan-builder.service';
import { _resetTokenCacheForTests } from '../stable-tokens-llm.service';
import type { InteractiveNode, IntentStep } from '../preview.types';

const mockGemini = generateTextWithGemini as jest.MockedFunction<typeof generateTextWithGemini>;

function geminiTokens(...tokens: string[]) {
  return {
    content: JSON.stringify({ tokens }),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, model: 'gemini-2.5-flash-lite' },
  };
}

function makeNode(overrides: Partial<InteractiveNode>): InteractiveNode {
  return {
    ref: 'e1',
    tag: 'a',
    role: 'link',
    text: '',
    bbox: { x: 0, y: 0, width: 100, height: 30 },
    ...overrides,
  } as InteractiveNode;
}

const step: IntentStep = {
  id: 'step-1',
  type: 'click',
  description: 'click card',
  options: {},
} as IntentStep;

beforeEach(() => {
  _resetTokenCacheForTests();
  mockGemini.mockReset();
});

describe('long-text + no-anchor → token chain enrichment', () => {
  it('inserts CSS chain as first locator for juz40-style card', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART', 'Бекнұр'));
    const node = makeNode({
      tag: 'a',
      role: 'link',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://juz40-edu.kz/curator/archive',
    });
    expect(plan.locatorPlan.length).toBeGreaterThan(0);
    const chain = plan.locatorPlan[0];
    expect(chain.strategy).toBe('css');
    expect(chain.value).toContain('a:has-text');
    expect(chain.value).toContain('МАТ-SMART');
    expect(chain.value).toContain('Бекнұр');
    expect(chain.confidence).toBe(0.82);
  });

  it('augments role strategy with partial-name token entry', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART', 'Бекнұр'));
    const node = makeNode({
      tag: 'a',
      role: 'link',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    const roleEntries = plan.locatorPlan.filter(l => l.strategy === 'role');
    expect(roleEntries.length).toBeGreaterThanOrEqual(2);
    // Full-name entry — keeps original confidence 0.9.
    const fullName = roleEntries.find(r => r.value === node.text);
    expect(fullName?.confidence).toBe(0.9);
    // Token-partial entry — confidence 0.65 (last-resort rescue; substring
    // match on a11y name is ambiguous on multi-card pages).
    const partial = roleEntries.find(r => r.value === 'МАТ-SMART');
    expect(partial).toBeDefined();
    expect(partial?.confidence).toBe(0.65);
  });

  // Note: builder DEDUPS the bare-text strategy when role already used the
  // same text as accessible name (existing behaviour predating V25). The
  // scope blocks (landmark / containerTitles) gate on `textStrategyAdded`,
  // so they only activate when bare-text was actually pushed. With a node
  // whose `text` IS the role's accessible name, scopes don't fire — and
  // that's intentional: role strategy already targets that exact name.
  //
  // To verify token-chain integration in scopes, use a node where text is
  // distinct from accessibleName (no role / generic role / explicit
  // labelText that wins over text).

  it('inserts token-chain inside landmark scope when scoped fallbacks are active', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART', 'Бекнұр'));
    const node = makeNode({
      tag: 'a',
      // Generic role so role-strategy is skipped → text strategy fires →
      // landmark scope activates.
      role: 'generic',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
      nearestLandmark: 'main',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    const landmarkChain = plan.locatorPlan.find(
      l => l.strategy === 'css' && l.value.startsWith('[role="main"]') && l.value.includes(':has-text'),
    );
    const landmarkFullText = plan.locatorPlan.find(
      l => l.strategy === 'css' && l.value.startsWith('[role="main"]') && l.value.includes('text="'),
    );
    expect(landmarkChain).toBeDefined();
    expect(landmarkFullText).toBeDefined();
    expect(landmarkChain!.confidence).toBeGreaterThan(landmarkFullText!.confidence ?? 0);
  });

  it('inserts token-chain inside containerTitles scope when scoped fallbacks are active', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART', 'Бекнұр'));
    const node = makeNode({
      tag: 'a',
      role: 'generic', // skip role strategy → bare text → scope activates
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
      containerTitles: ['Архивтегі курстар'],
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    const containerChain = plan.locatorPlan.find(
      l => l.strategy === 'css'
        && l.value.includes('Архивтегі')
        && l.value.includes(':has-text("МАТ-SMART"):has-text("Бекнұр")'),
    );
    expect(containerChain).toBeDefined();
  });

  it('keeps either role(full) OR text(full) as final fallback', async () => {
    // Builder's existing dedup: if role used `text` as accessibleName,
    // text strategy is skipped (only role variant kept). Either way the
    // full string is reachable — assert that ONE of them is present at
    // the canonical 0.9/0.7 confidence.
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART', 'Бекнұр'));
    const node = makeNode({
      tag: 'a',
      role: 'link',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    const fullRole = plan.locatorPlan.find(
      l => l.strategy === 'role' && l.value === node.text && l.confidence === 0.9,
    );
    const fullText = plan.locatorPlan.find(
      l => l.strategy === 'text' && l.value === node.text,
    );
    expect(fullRole || fullText).toBeDefined();
  });
});

describe('skipped when structural anchor present', () => {
  it('does NOT call LLM when testId is present', async () => {
    const node = makeNode({
      tag: 'a',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
      testIdAttr: 'mat-smart-card',
    });
    await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('does NOT call LLM when id is present (and not dynamic)', async () => {
    const node = makeNode({
      tag: 'a',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
      id: 'course-card-mat-smart',
      isDynamicId: false,
    });
    await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('does NOT call LLM when href is present', async () => {
    const node = makeNode({
      tag: 'a',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ href: '#mat-smart' } as any),
    });
    await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    expect(mockGemini).not.toHaveBeenCalled();
  });
});

describe('skipped when text is short', () => {
  it('does NOT call LLM for short labels', async () => {
    const node = makeNode({
      tag: 'button',
      role: 'button',
      text: 'Save',
    });
    await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    expect(mockGemini).not.toHaveBeenCalled();
  });
});

describe('LLM returned [] (fully dynamic / failure)', () => {
  it('falls back to existing strategies, no chain added', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens()); // empty tokens array
    const node = makeNode({
      tag: 'div',
      text: 'Order #492837 placed at 14:32:15 by user_8273',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    // No CSS chain entries with :has-text(:has-text(... pattern.
    const chain = plan.locatorPlan.find(
      l => l.strategy === 'css' && /:has-text\(.*\):has-text\(/.test(l.value),
    );
    expect(chain).toBeUndefined();
    // But existing strategies (text fallback) still present.
    expect(plan.locatorPlan.length).toBeGreaterThan(0);
  });

  it('falls back when LLM throws', async () => {
    mockGemini.mockRejectedValueOnce(new Error('Gemini timeout'));
    const node = makeNode({
      tag: 'a',
      role: 'link',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    const chain = plan.locatorPlan.find(
      l => l.strategy === 'css' && /:has-text\(.*\):has-text\(/.test(l.value),
    );
    expect(chain).toBeUndefined();
    // Plan still produced — full-text strategies present.
    expect(plan.locatorPlan.length).toBeGreaterThan(0);
  });
});

describe('1 token returned (chain skipped, partials still added)', () => {
  it('does not build chain but still augments role partial', async () => {
    mockGemini.mockResolvedValueOnce(geminiTokens('МАТ-SMART'));
    const node = makeNode({
      tag: 'a',
      role: 'link',
      text: 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    });
    const plan = await LocatorPlanBuilder.buildCompiledPlan({
      step,
      resolvedNode: node,
      pageUrl: 'https://x.kz',
    });
    // No chain (needs ≥2 tokens).
    const chain = plan.locatorPlan.find(
      l => l.strategy === 'css' && /:has-text\(.*\):has-text\(/.test(l.value),
    );
    expect(chain).toBeUndefined();
    // Role partial still added.
    const rolePartial = plan.locatorPlan.find(
      l => l.strategy === 'role' && l.value === 'МАТ-SMART',
    );
    expect(rolePartial).toBeDefined();
  });
});
