/**
 * The credential-authoring flag is read by three surfaces that MUST agree — the
 * tool schema, the prompts, and the handler. The realistic failure is not "the
 * flag doesn't work", it is "someone flips one surface and not the others", so
 * these tests assert the surfaces together rather than the flag in isolation.
 *
 * NOTE ON THE SEAM: these mock `CredentialAuthoringFeature`, not the env var.
 * `src/test/jest.setup.ts` globally mocks `@/config/environment/env` with a
 * hand-written object listing only a handful of vars, so NO feature flag is
 * readable through the real env under Jest (`env.COMPANION_ENABLED` is
 * `undefined` there too). Setting `process.env` and calling `jest.resetModules()`
 * looks like it should work and silently does nothing.
 */

let flagEnabled = false;

jest.mock('@/config/features/credential-authoring', () => ({
  CredentialAuthoringFeature: { isEnabled: () => flagEnabled },
}));

// `qa.skill.ts` imports every handler, which transitively pulls in Supabase and
// Redis and makes this suite hang. The tool SCHEMA is what is under test, so
// stub the handler module — a Proxy covers all ~45 named exports without
// listing them.
jest.mock('@/services/skills/qa/qa-tool-handlers', () => new Proxy({}, {
  get: () => jest.fn(),
}));

const setFlag = (on: boolean): void => {
  flagEnabled = on;
  jest.resetModules();
};

const loadSkill = () =>
  require('@/services/skills/qa/qa.skill').QASkill as {
    tools: Array<{ type: string; function: { name: string; description?: string; parameters?: any } }>;
  };

const loadPrompt = () =>
  require('@/api/chat/general/sub-agents/prompts/executor-prompt').buildExecutorPrompt as
    (...a: unknown[]) => string;

const authorTool = (skill: ReturnType<typeof loadSkill>) =>
  skill.tools.find((t) => t.function?.name === 'qa_author_test_iteratively')!;

describe('credential authoring flag — OFF (explicitly disabled)', () => {
  beforeEach(() => setFlag(false));

  it('does not advertise credential_secret_name on the tool', () => {
    const tool = authorTool(loadSkill());
    expect(Object.keys(tool.function.parameters.properties)).not.toContain('credential_secret_name');
  });

  it('does not mention the credential parameter in the tool description', () => {
    expect(authorTool(loadSkill()).function.description).not.toContain('credential_secret_name');
  });

  it('keeps every other parameter of the tool intact', () => {
    const props = Object.keys(authorTool(loadSkill()).function.parameters.properties);
    expect(props).toEqual(expect.arrayContaining(['goal', 'suggested_name', 'confirm']));
  });

  it('leaves the other tools untouched', () => {
    const skill = loadSkill();
    expect(skill.tools.length).toBeGreaterThan(30);
    expect(skill.tools.find((t) => t.function?.name === 'qa_create_test_case')).toBeDefined();
  });

  it('tells the executor prompt to ASK instead of binding a saved login', () => {
    const prompt = loadPrompt()(undefined, 'p1', 'editor');
    expect(prompt).not.toContain('credential_secret_name');
    expect(prompt).toContain('Which account should this test log in with?');
  });

  it('still forbids fabricating credentials', () => {
    // The guard that must survive in BOTH states — the rule the whole grounding
    // block exists for.
    expect(loadPrompt()(undefined, 'p1', 'editor')).toContain('NEVER put a real credential VALUE in a step');
  });
});

describe('credential authoring flag — ON (the default)', () => {
  beforeEach(() => setFlag(true));

  it('advertises credential_secret_name on the tool', () => {
    const tool = authorTool(loadSkill());
    expect(Object.keys(tool.function.parameters.properties)).toContain('credential_secret_name');
    expect(tool.function.description).toContain('credential_secret_name');
  });

  it('tells the executor prompt to bind a saved login by name', () => {
    const prompt = loadPrompt()(undefined, 'p1', 'editor');
    expect(prompt).toContain('credential_secret_name');
    expect(prompt).toContain('Which saved login should this test use?');
  });

  it('still forbids fabricating credentials', () => {
    expect(loadPrompt()(undefined, 'p1', 'editor')).toContain('NEVER put a real credential VALUE in a step');
  });
});

/**
 * The default itself.
 *
 * Asserted against the REAL declaration in env.ts, read from source — NOT by
 * re-declaring the zod schema here. `src/test/jest.setup.ts` globally mocks
 * `@/config/environment/env`, so `env.*` is undefined for every flag under
 * Jest, and importing the module for real would run its process.exit-on-invalid
 * boot path. A re-declared copy of the schema would pass while env.ts said
 * something else entirely — the exact failure mode L-0031 records.
 */
describe('CREDENTIAL_AUTHORING_ENABLED default', () => {
  const declaration = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path');
    const src = readFileSync(join(__dirname, '../../environment/env.ts'), 'utf8');
    const line = src.split('\n').find((l: string) => l.includes('CREDENTIAL_AUTHORING_ENABLED:'));
    if (!line) throw new Error('CREDENTIAL_AUTHORING_ENABLED is not declared in env.ts');
    return line;
  };

  it('defaults to ON, so the feature works without any env wiring', () => {
    expect(declaration()).toContain(".default('true')");
  });

  it('uses the same === comparison as every other flag in the file', () => {
    // A `!== \'false\'` variant would read identically at a glance but behave
    // differently for a typo\'d value.
    expect(declaration()).toContain("v === 'true'");
  });
});
