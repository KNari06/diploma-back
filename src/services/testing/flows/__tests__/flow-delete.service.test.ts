import { FlowService } from '../flow.service';
import {
  selectTestCaseIdsForFlowQuery,
  softDeleteTestCasesForFlowQuery,
} from '../db/flow.db';
import { emitTestCaseMutated } from '@/websocket/helpers/project-mutation-emit';

jest.mock('../db/flow.db', () => ({
  searchFlowsByProjectQuery: jest.fn(),
  selectTestCaseIdsForFlowQuery: jest.fn(),
  softDeleteTestCasesForFlowQuery: jest.fn(),
}));

jest.mock('@/websocket/helpers/project-mutation-emit', () => ({
  emitTestCaseMutated: jest.fn(),
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn().mockResolvedValue(undefined) },
}));

const flowRowDelete = jest.fn();
const planItemsDelete = jest.fn();

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'regression_plan_items') {
        return { delete: () => ({ eq: (...a: unknown[]) => planItemsDelete(...a) }) };
      }
      // test_flows: the pre-delete select, then the delete.
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { module_id: 'm-1', test_modules: { project_id: 'p-1' } },
                  error: null,
                }),
            }),
          }),
        }),
        delete: () => ({ eq: () => ({ eq: (...a: unknown[]) => flowRowDelete(...a) }) }),
      };
    },
  },
}));

const mockedSelectIds = selectTestCaseIdsForFlowQuery as jest.MockedFunction<
  typeof selectTestCaseIdsForFlowQuery
>;
const mockedDeleteCases = softDeleteTestCasesForFlowQuery as jest.MockedFunction<
  typeof softDeleteTestCasesForFlowQuery
>;
const mockedEmit = emitTestCaseMutated as jest.MockedFunction<typeof emitTestCaseMutated>;

describe('FlowService.delete', () => {
  const flowId = 'f-1';
  const userId = 'u-1';

  beforeEach(() => {
    jest.clearAllMocks();
    planItemsDelete.mockResolvedValue({ error: null });
    flowRowDelete.mockResolvedValue({ error: null });
    mockedDeleteCases.mockResolvedValue({ error: null } as any);
  });

  it('tombstones the flow test cases so they are not orphaned by the SET NULL fk', async () => {
    mockedSelectIds.mockResolvedValue({
      data: [{ id: 'tc-1' }, { id: 'tc-2' }],
      error: null,
    } as any);

    await FlowService.delete(flowId, userId);

    expect(mockedDeleteCases).toHaveBeenCalledWith(flowId);
  });

  it('tombstones the test cases before dropping the flow row', async () => {
    const order: string[] = [];
    mockedSelectIds.mockResolvedValue({ data: [{ id: 'tc-1' }], error: null } as any);
    mockedDeleteCases.mockImplementation((() => {
      order.push('cases');
      return Promise.resolve({ error: null });
    }) as any);
    flowRowDelete.mockImplementation(() => {
      order.push('flow');
      return Promise.resolve({ error: null });
    });

    await FlowService.delete(flowId, userId);

    expect(order).toEqual(['cases', 'flow']);
  });

  it('leaves regression plan items intact — the tombstoned rows still exist', async () => {
    mockedSelectIds.mockResolvedValue({
      data: [{ id: 'tc-1' }, { id: 'tc-2' }],
      error: null,
    } as any);

    await FlowService.delete(flowId, userId);

    // Only the flow-level cleanup runs; nothing deletes items by test case id.
    expect(planItemsDelete).toHaveBeenCalledTimes(1);
  });

  it('announces each deleted test case so open pickers drop it', async () => {
    mockedSelectIds.mockResolvedValue({
      data: [{ id: 'tc-1' }, { id: 'tc-2' }],
      error: null,
    } as any);

    await FlowService.delete(flowId, userId);

    expect(mockedEmit).toHaveBeenCalledTimes(2);
    expect(mockedEmit).toHaveBeenCalledWith({
      projectId: 'p-1',
      action: 'deleted',
      id: 'tc-1',
      flowId,
    });
  });

  it('keeps the flow when its test cases could not be tombstoned', async () => {
    mockedSelectIds.mockResolvedValue({ data: [{ id: 'tc-1' }], error: null } as any);
    mockedDeleteCases.mockResolvedValue({ error: { message: 'boom' } } as any);

    await expect(FlowService.delete(flowId, userId)).rejects.toThrow(
      /Failed to delete flow test cases/,
    );
    expect(flowRowDelete).not.toHaveBeenCalled();
  });

  it('skips the test-case cleanup entirely for an empty flow', async () => {
    mockedSelectIds.mockResolvedValue({ data: [], error: null } as any);

    await FlowService.delete(flowId, userId);

    expect(mockedDeleteCases).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
    expect(flowRowDelete).toHaveBeenCalled();
  });
});
