// Mock the db/ boundary — the queries themselves are integration-tested.
jest.mock('@/services/testing/regression/db/regression-report.db', () => ({
  getTestResultsByTestIds: jest.fn(async () => []),
  getMobileTestResultsByTestIds: jest.fn(async () => []),
}));

import { resolveFixPromptForTestId } from '../resolve-fix-prompt.util';
import {
  getMobileTestResultsByTestIds,
  getTestResultsByTestIds,
} from '@/services/testing/regression/db/regression-report.db';

const web = getTestResultsByTestIds as jest.Mock;
const mobile = getMobileTestResultsByTestIds as jest.Mock;

const row = (fixPrompt?: unknown) => ({ test_id: 'test-1', ai_summary: { fixPrompt } });

beforeEach(() => {
  jest.clearAllMocks();
  web.mockResolvedValue([]);
  mobile.mockResolvedValue([]);
});

describe('resolveFixPromptForTestId', () => {
  it('returns the fix prompt from the web result table', async () => {
    web.mockResolvedValue([row('## Bug: Pay button dead')]);

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBe('## Bug: Pay button dead');
    expect(mobile).not.toHaveBeenCalled();
  });

  it('falls back to the mobile result table when the web table has none', async () => {
    // Mobile runs persist ai_summary to the forked mobile_test_results table;
    // reading only test_results returns undefined for every mobile run.
    mobile.mockResolvedValue([row('## Bug: tap missed')]);

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBe('## Bug: tap missed');
    expect(mobile).toHaveBeenCalledWith(['test-1']);
  });

  it('takes the newest row when several results share a test id', async () => {
    // Both readers order newest-first, so the first hit is the newest run.
    web.mockResolvedValue([row('newest'), row('older')]);

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBe('newest');
  });

  it('skips rows whose prompt is missing, blank, or not a string', async () => {
    web.mockResolvedValue([{ test_id: 'test-1' }, row(''), row('   '), row(42), row('real one')]);

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBe('real one');
  });

  it('returns undefined when neither table has a prompt', async () => {
    web.mockResolvedValue([row(undefined)]);
    mobile.mockResolvedValue([row(undefined)]);

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBeUndefined();
  });

  it('fails open when the query throws', async () => {
    // A metadata lookup must never block filing the Jira issue.
    web.mockRejectedValue(new Error('RLS denied'));

    await expect(resolveFixPromptForTestId('test-1')).resolves.toBeUndefined();
  });

  it('returns undefined without querying when the test id is empty', async () => {
    await expect(resolveFixPromptForTestId('')).resolves.toBeUndefined();
    expect(web).not.toHaveBeenCalled();
  });
});
