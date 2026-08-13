import { FlowService } from '../flow.service';
import { searchFlowsByProjectQuery } from '../db/flow.db';

jest.mock('../db/flow.db', () => ({
  searchFlowsByProjectQuery: jest.fn(),
}));

const mockedQuery = searchFlowsByProjectQuery as jest.MockedFunction<
  typeof searchFlowsByProjectQuery
>;

describe('FlowService.searchByProject', () => {
  const projectId = 'p-1';
  const userId = 'u-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty list for a blank query without hitting the db', async () => {
    await expect(FlowService.searchByProject(projectId, userId, '   ', 100)).resolves.toEqual([]);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('maps matching rows to flow objects (module id + name preserved)', async () => {
    mockedQuery.mockResolvedValue({
      data: [
        {
          id: 'f-1',
          module_id: 'm-1',
          user_id: userId,
          name: 'Login flow',
          description: null,
          order_index: null,
          flow_type: 'ui',
          platform: 'web',
          tags: ['smoke'],
          priority: null,
          mobile_variant_label: null,
          created_at: 't1',
          updated_at: 't2',
        },
      ],
      error: null,
    } as any);

    const result = await FlowService.searchByProject(projectId, userId, 'login', 100);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'f-1',
      moduleId: 'm-1',
      name: 'Login flow',
      flowType: 'ui',
      platform: 'web',
      tags: ['smoke'],
    });
    expect(mockedQuery).toHaveBeenCalledWith({
      projectId,
      userId,
      pattern: 'login',
      limit: 100,
    });
  });

  it('escapes ilike wildcards so % and _ match literally', async () => {
    mockedQuery.mockResolvedValue({ data: [], error: null } as any);

    await FlowService.searchByProject(projectId, userId, '50%_off', 50);

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '50\\%\\_off', limit: 50 }),
    );
  });

  it('throws when the db query returns an error', async () => {
    mockedQuery.mockResolvedValue({ data: null, error: { message: 'boom' } } as any);

    await expect(FlowService.searchByProject(projectId, userId, 'x', 100)).rejects.toThrow(
      /Failed to search flows: boom/,
    );
  });
});
