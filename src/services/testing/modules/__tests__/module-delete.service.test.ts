/**
 * Unit tests for ModuleService.delete — the subtree test-case cleanup that
 * keeps the CASCADE on modules/flows from orphaning intent_test_cases (whose
 * flow_id fk is SET NULL). Rows are tombstoned, not dropped. DB stubbed at the `db/module.db` boundary.
 */

import { ModuleService } from '@/services/testing/modules/module.service';
import * as moduleDb from '@/services/testing/modules/db/module.db';
import { emitTestCaseMutated } from '@/websocket/helpers/project-mutation-emit';

jest.mock('@/services/testing/modules/db/module.db', () => ({
  deleteModuleRow: jest.fn(),
  getModuleProjectId: jest.fn(),
  getChildModuleIds: jest.fn(),
  getTestCaseIdsForModules: jest.fn(),
  softDeleteTestCasesByIds: jest.fn(),
}));

jest.mock('@/websocket/helpers/project-mutation-emit', () => ({
  emitTestCaseMutated: jest.fn(),
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn().mockResolvedValue(undefined) },
}));

const mockedDb = moduleDb as jest.Mocked<typeof moduleDb>;
const mockedEmit = emitTestCaseMutated as jest.MockedFunction<typeof emitTestCaseMutated>;

describe('ModuleService.delete', () => {
  const moduleId = 'm-1';
  const userId = 'u-1';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb.getModuleProjectId.mockResolvedValue('p-1');
    mockedDb.getChildModuleIds.mockResolvedValue([]);
    mockedDb.getTestCaseIdsForModules.mockResolvedValue([]);
    mockedDb.softDeleteTestCasesByIds.mockResolvedValue(undefined);
    mockedDb.deleteModuleRow.mockResolvedValue(undefined);
  });

  it('tombstones the test cases of the module being removed', async () => {
    mockedDb.getTestCaseIdsForModules.mockResolvedValue(['tc-1', 'tc-2']);

    await ModuleService.delete(moduleId, userId);

    expect(mockedDb.softDeleteTestCasesByIds).toHaveBeenCalledWith(['tc-1', 'tc-2']);
  });

  it('covers nested folders, not just direct children', async () => {
    // m-1 → m-2 → m-3
    mockedDb.getChildModuleIds.mockImplementation(async (id: string) => {
      if (id === 'm-1') return ['m-2'];
      if (id === 'm-2') return ['m-3'];
      return [];
    });

    await ModuleService.delete(moduleId, userId);

    expect(mockedDb.getTestCaseIdsForModules).toHaveBeenCalledWith(['m-1', 'm-2', 'm-3']);
  });

  it('tombstones the test cases before removing the module row', async () => {
    const order: string[] = [];
    mockedDb.getTestCaseIdsForModules.mockResolvedValue(['tc-1']);
    mockedDb.softDeleteTestCasesByIds.mockImplementation(async () => {
      order.push('cases');
    });
    mockedDb.deleteModuleRow.mockImplementation(async () => {
      order.push('module');
    });

    await ModuleService.delete(moduleId, userId);

    expect(order).toEqual(['cases', 'module']);
  });

  it('keeps the module when its test cases could not be tombstoned', async () => {
    mockedDb.getTestCaseIdsForModules.mockResolvedValue(['tc-1']);
    mockedDb.softDeleteTestCasesByIds.mockRejectedValue(new Error('boom'));

    await expect(ModuleService.delete(moduleId, userId)).rejects.toThrow('boom');
    expect(mockedDb.deleteModuleRow).not.toHaveBeenCalled();
  });

  it('announces each deleted test case so open pickers drop it', async () => {
    mockedDb.getTestCaseIdsForModules.mockResolvedValue(['tc-1', 'tc-2']);

    await ModuleService.delete(moduleId, userId);

    expect(mockedEmit).toHaveBeenCalledTimes(2);
    expect(mockedEmit).toHaveBeenCalledWith({
      projectId: 'p-1',
      action: 'deleted',
      id: 'tc-1',
    });
  });

  it('skips the cleanup entirely for a module with no test cases', async () => {
    await ModuleService.delete(moduleId, userId);

    expect(mockedDb.softDeleteTestCasesByIds).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
    expect(mockedDb.deleteModuleRow).toHaveBeenCalledWith(moduleId, userId);
  });

  it('does not spin when a parent cycle exists in corrupt data', async () => {
    mockedDb.getChildModuleIds.mockImplementation(async (id: string) => {
      if (id === 'm-1') return ['m-2'];
      if (id === 'm-2') return ['m-1'];
      return [];
    });

    await ModuleService.delete(moduleId, userId);

    expect(mockedDb.getTestCaseIdsForModules).toHaveBeenCalledWith(['m-1', 'm-2']);
  });
});
