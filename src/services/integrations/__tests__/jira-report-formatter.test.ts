import {
  buildCodeCommentADF,
  buildDescriptionADF,
  buildFixPromptCommentADF,
} from '../jira-report-formatter';
import type { FinalTestReport } from '@/types';

const report = (over: Partial<FinalTestReport> = {}): FinalTestReport => ({
  testId: 'test-1',
  testUrl: 'https://app.example.com/checkout',
  status: 'failed' as FinalTestReport['status'],
  executedAt: '2026-08-04T10:00:00.000Z',
  duration: 12_000,
  generatedCode: {
    language: 'typescript',
    framework: 'playwright',
    code: "await page.click('#pay');",
    steps: [],
    commands: [],
  },
  artifacts: { screenshots: [], logs: [], networkLogs: [] },
  analysis: {
    bugs: [
      { severity: 'critical', type: 'functional', message: 'Pay button dead', selector: '#pay', recommendation: 'Bind the handler' },
    ],
    severity: 'critical',
    recommendations: [],
    confidence: 0.9,
  },
  summary: { totalSteps: 4, passedSteps: 3, failedSteps: 1, bugsFound: 1, criticalBugs: 1 },
  ...over,
});

/** Depth-first search for the first node of a given ADF type. */
function findNode(node: any, type: string): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  for (const child of node.content || []) {
    const hit = findNode(child, type);
    if (hit) return hit;
  }
  return undefined;
}

describe('buildFixPromptCommentADF', () => {
  it('returns null when there is no prompt', () => {
    expect(buildFixPromptCommentADF(undefined)).toBeNull();
  });

  it('returns null for a blank prompt rather than emitting an empty text node', () => {
    // ADF rejects `{type:'text', text:''}` — emitting one would turn a
    // best-effort comment into a 400 from Jira.
    expect(buildFixPromptCommentADF('')).toBeNull();
    expect(buildFixPromptCommentADF('   \n  ')).toBeNull();
  });

  it('puts the prompt in a code block with no language attribute', () => {
    const doc = buildFixPromptCommentADF('## Bug: Pay button dead');

    const codeBlock = findNode(doc, 'codeBlock');
    expect(codeBlock).toBeDefined();
    // The prompt is markdown; an unrecognized language identifier risks a
    // Jira rejection, and `attrs` is optional in ADF.
    expect(codeBlock.attrs).toBeUndefined();
  });

  it('preserves multi-line markdown verbatim, including backticks', () => {
    const prompt = '## Bug\n\n- item\n\n```js\nfoo()\n```';

    const codeBlock = findNode(buildFixPromptCommentADF(prompt), 'codeBlock');

    expect(codeBlock.content).toEqual([{ type: 'text', text: prompt }]);
  });

  it('trims surrounding whitespace off the prompt', () => {
    const codeBlock = findNode(buildFixPromptCommentADF('\n\n## Bug\n\n'), 'codeBlock');

    expect(codeBlock.content[0].text).toBe('## Bug');
  });

  it('produces a valid ADF document with a heading', () => {
    const doc = buildFixPromptCommentADF('## Bug')!;

    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    expect(findNode(doc, 'heading').content[0].text).toContain('fix prompt');
  });
});

describe('buildCodeCommentADF', () => {
  it('returns null when there is no generated code', () => {
    expect(buildCodeCommentADF('')).toBeNull();
    expect(buildCodeCommentADF('  ')).toBeNull();
  });

  it('emits a typescript code block for generated code', () => {
    const codeBlock = findNode(buildCodeCommentADF("await page.click('#pay');"), 'codeBlock');

    expect(codeBlock.attrs).toEqual({ language: 'typescript' });
    expect(codeBlock.content[0].text).toBe("await page.click('#pay');");
  });
});

describe('buildDescriptionADF', () => {
  it('marks critical and high bugs with an error panel', () => {
    const doc = buildDescriptionADF(report());

    const bugPanel = (doc.content as any[]).filter((n) => n.type === 'panel')[1];
    expect(bugPanel.attrs.panelType).toBe('error');
  });

  it('marks lower-severity bugs with a warning panel', () => {
    const doc = buildDescriptionADF(report({
      analysis: {
        bugs: [{ severity: 'medium', type: 'visual', message: 'Misaligned', recommendation: 'Fix CSS' }],
        severity: 'medium',
        recommendations: [],
        confidence: 0.5,
      },
    }));

    const bugPanel = (doc.content as any[]).filter((n) => n.type === 'panel')[1];
    expect(bugPanel.attrs.panelType).toBe('warning');
  });

  it('omits the selector bullet when the bug has no selector', () => {
    const doc = buildDescriptionADF(report({
      analysis: {
        bugs: [{ severity: 'low', type: 'visual', message: 'No selector here', recommendation: 'n/a' }],
        severity: 'low',
        recommendations: [],
        confidence: 0.5,
      },
    }));

    expect(JSON.stringify(doc)).not.toContain('Selector: ');
  });
});
