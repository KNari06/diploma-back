// Mock the endpoint whitelist so we can exercise the defensive drop branch.
// Logger is globally mocked in jest.setup.ts.
jest.mock('@/api/preview/quick-action-endpoints', () => ({ isWhitelistedQuickActionEndpoint: jest.fn() }));

import { injectQuickActions, type InjectorContext } from '../quick-actions-injector';
import { isWhitelistedQuickActionEndpoint } from '@/api/preview/quick-action-endpoints';
import { logger } from '@/utils/core/logger';
import type { ToolExecutionRecord } from '../types';

const whitelistMock = isWhitelistedQuickActionEndpoint as jest.Mock;

const editorCtx: InjectorContext = {
  mode: 'editor',
  previewSessionId: 'preview-1',
  chatSessionId: 'chat-1',
  userId: 'user-1',
};

const draftRun = (success = true): ToolExecutionRecord =>
  ({ toolName: 'qa_run_draft_steps', result: { success } } as unknown as ToolExecutionRecord);

beforeEach(() => {
  whitelistMock.mockReturnValue(true);
});

describe('injectQuickActions', () => {
  it('offers "Save as test case" after a successful draft run in editor mode', () => {
    const actions = injectQuickActions([draftRun(true)], editorCtx);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: 'save-draft-as-test-case',
      kind: 'api',
      endpoint: 'POST /api/v1/preview/draft/save-as-test-case',
      oneShot: true,
      params: { previewSessionId: '<ctx:previewSessionId>', chatSessionId: '<ctx:chatSessionId>' },
    });
  });

  it('returns nothing when the draft run failed', () => {
    expect(injectQuickActions([draftRun(false)], editorCtx)).toEqual([]);
  });

  it('returns nothing for an unrelated tool', () => {
    const rec = { toolName: 'qa_something_else', result: { success: true } } as unknown as ToolExecutionRecord;
    expect(injectQuickActions([rec], editorCtx)).toEqual([]);
  });

  it('returns nothing on an empty tool-results list', () => {
    expect(injectQuickActions([], editorCtx)).toEqual([]);
  });

  describe('editor-context gating', () => {
    it('suppresses editor actions outside editor mode', () => {
      expect(injectQuickActions([draftRun()], { ...editorCtx, mode: 'lite' })).toEqual([]);
    });

    it('suppresses editor actions when previewSessionId is missing', () => {
      expect(injectQuickActions([draftRun()], { ...editorCtx, previewSessionId: undefined })).toEqual([]);
    });

    it('suppresses editor actions when chatSessionId is missing', () => {
      expect(injectQuickActions([draftRun()], { ...editorCtx, chatSessionId: undefined })).toEqual([]);
    });
  });

  it('deduplicates actions with the same id across repeated tool results', () => {
    const actions = injectQuickActions([draftRun(), draftRun()], editorCtx);
    expect(actions).toHaveLength(1);
  });

  it('drops api actions whose endpoint is not whitelisted and logs a warning', () => {
    whitelistMock.mockReturnValue(false);
    const actions = injectQuickActions([draftRun()], editorCtx);
    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[QUICK_ACTIONS_INJECTOR] Dropping action with non-whitelisted endpoint',
      expect.objectContaining({ actionId: 'save-draft-as-test-case' }),
    );
  });

  it('only emits actions for the matching records in a mixed batch', () => {
    const other = { toolName: 'qa_other', result: { success: true } } as unknown as ToolExecutionRecord;
    const actions = injectQuickActions([other, draftRun(true), draftRun(false)], editorCtx);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('save-draft-as-test-case');
  });
});
