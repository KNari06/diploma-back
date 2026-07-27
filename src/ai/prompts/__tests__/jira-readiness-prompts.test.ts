import { buildJiraAnalysisMessages, JIRA_ANALYSIS_SYSTEM_PROMPT } from '../jira-readiness-prompts';

function baseInput(overrides: Partial<Parameters<typeof buildJiraAnalysisMessages>[0]> = {}) {
  return {
    issueSummary: 'Login returns 500',
    issueDescription: 'After deploy',
    kbContext: '',
    testCaseContext: '',
    pastBugsContext: '',
    memoryContext: '',
    integrationContext: '',
    relatedTicketsContext: '',
    coverageContext: '',
    ...overrides,
  };
}

describe('JIRA_ANALYSIS_SYSTEM_PROMPT', () => {
  it('defines all six readiness gap types', () => {
    for (const t of ['negative', 'boundary', 'related_flow', 'error_state', 'permission', 'data_variation']) {
      expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain(t);
    }
  });

  it('contains the anti-hallucination "empty is valid" instruction', () => {
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('"coverageGaps": []');
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT.toLowerCase()).toContain('never invent');
  });

  it('regression guard: keeps the original triage outcomes and few-shots', () => {
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('CAN_RUN_AUTO');
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('NEEDS_REWORK');
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('PREPARE_MANUAL');
    // The three original triage few-shots must survive the readiness merge.
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('Login page returns 500 after deploy');
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('Payment form validation broken');
    expect(JIRA_ANALYSIS_SYSTEM_PROMPT).toContain('Verify new brand colors across all pages');
  });
});

describe('buildJiraAnalysisMessages', () => {
  it('always includes the issue and knowledge-base sections', () => {
    const { user } = buildJiraAnalysisMessages(baseInput());
    expect(user).toContain('JIRA ISSUE:');
    expect(user).toContain('Login returns 500');
    expect(user).toContain('KNOWLEDGE BASE:');
  });

  it('folds related-tickets and coverage sections in only when non-empty', () => {
    const without = buildJiraAnalysisMessages(baseInput()).user;
    expect(without).not.toContain('RELATED TICKETS');
    expect(without).not.toContain('PROJECT COVERAGE SIGNALS');

    const withCtx = buildJiraAnalysisMessages(baseInput({
      relatedTicketsContext: 'blocks PROJ-88: Payment refactor',
      coverageContext: '- [HIGH] untested_url: /checkout',
    })).user;
    expect(withCtx).toContain('RELATED TICKETS / SUBTASKS:');
    expect(withCtx).toContain('PROJ-88');
    expect(withCtx).toContain('PROJECT COVERAGE SIGNALS');
  });
});
