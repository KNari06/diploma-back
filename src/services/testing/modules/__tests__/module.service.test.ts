/**
 * Unit tests for ModuleService nesting rules — depth cap, cross-project guard,
 * cycle prevention on move, and filter/reorder pass-through. Folders are
 * platform-agnostic (platform_id nullable, cross-platform moves allowed). DB
 * stubbed at the `db/module.db` boundary; cache stubbed.
 */

import { ModuleService } from '@/services/testing/modules/module.service';
import { ValidationError } from '@/types';
import { MAX_MODULE_DEPTH, type TestModule } from '@/types/testing.types';

jest.mock('@/services/testing/modules/db/module.db', () => ({
  insertModule: jest.fn(),
  updateModuleRow: jest.fn(),
  deleteModuleRow: jest.fn(),
  setModuleOrderIndexes: jest.fn(),
  getModuleById: jest.fn(),
  getModuleCore: jest.fn(),
  getModuleProjectId: jest.fn(),
  getChildModuleIds: jest.fn(),
  listModules: jest.fn(),
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn().mockResolvedValue(undefined) },
}));

import * as moduleDb from '@/services/testing/modules/db/module.db';
import { cache } from '@/utils/core/redis-cache';

const PLATFORM = 'platform-1';
const PROJECT = 'project-1';
const USER = 'user-1';

type Core = { id: string; parentModuleId: string | null; platformId: string | null; projectId: string };

/** Wire getModuleCore to resolve from a fixture map (or null if absent). */
function useCores(cores: Record<string, Core>) {
  (moduleDb.getModuleCore as jest.Mock).mockImplementation(async (id: string) => cores[id] ?? null);
}

/** Wire getChildModuleIds from a parent→children map. */
function useChildren(children: Record<string, string[]>) {
  (moduleDb.getChildModuleIds as jest.Mock).mockImplementation(async (id: string) => children[id] ?? []);
}

const fakeModule = (overrides: Partial<TestModule> = {}): TestModule => ({
  id: 'm-new',
  projectId: PROJECT,
  userId: USER,
  platformId: PLATFORM,
  parentModuleId: null,
  name: 'Folder',
  tags: [],
  orderIndex: null,
  createdAt: 'now',
  updatedAt: 'now',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  (moduleDb.insertModule as jest.Mock).mockResolvedValue(fakeModule());
  (moduleDb.updateModuleRow as jest.Mock).mockResolvedValue(fakeModule());
});

describe('ModuleService.create nesting', () => {
  it('creates a top-level folder (no parent) and invalidates the tree cache', async () => {
    await ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, name: 'Auth' });

    expect(moduleDb.insertModule).toHaveBeenCalledWith(
      expect.objectContaining({ parent_module_id: null, platform_id: PLATFORM }),
    );
    expect(cache.delByPattern).toHaveBeenCalledWith(`qait:cache:ptree:base:${PROJECT}:*`);
  });

  it('rejects when the parent folder does not exist', async () => {
    useCores({});
    await expect(
      ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, parentModuleId: 'missing', name: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(moduleDb.insertModule).not.toHaveBeenCalled();
  });

  it('creates a platform-agnostic folder (platform_id null) when no platformId given', async () => {
    await ModuleService.create({ projectId: PROJECT, userId: USER, name: 'Mixed' });
    expect(moduleDb.insertModule).toHaveBeenCalledWith(
      expect.objectContaining({ parent_module_id: null, platform_id: null }),
    );
  });

  it('allows a parent on a different platform (folders are platform-agnostic)', async () => {
    useCores({ p: { id: 'p', parentModuleId: null, platformId: 'other-platform', projectId: PROJECT } });
    await ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, parentModuleId: 'p', name: 'x' });
    expect(moduleDb.insertModule).toHaveBeenCalledWith(expect.objectContaining({ parent_module_id: 'p' }));
  });

  it('rejects a parent in a different project', async () => {
    useCores({ p: { id: 'p', parentModuleId: null, platformId: PLATFORM, projectId: 'other-project' } });
    await expect(
      ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, parentModuleId: 'p', name: 'x' }),
    ).rejects.toThrow(/different project/);
    expect(moduleDb.insertModule).not.toHaveBeenCalled();
  });

  it(`rejects when nesting would exceed depth ${MAX_MODULE_DEPTH}`, async () => {
    // gp (1) <- p1 (2) <- p2 (3). Creating under p2 → depth 4 > 3.
    useCores({
      gp: { id: 'gp', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      p1: { id: 'p1', parentModuleId: 'gp', platformId: PLATFORM, projectId: PROJECT },
      p2: { id: 'p2', parentModuleId: 'p1', platformId: PLATFORM, projectId: PROJECT },
    });
    await expect(
      ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, parentModuleId: 'p2', name: 'x' }),
    ).rejects.toThrow(/nesting depth/);
    expect(moduleDb.insertModule).not.toHaveBeenCalled();
  });

  it('allows nesting at the depth boundary (parent depth 2 → new depth 3)', async () => {
    useCores({
      gp: { id: 'gp', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      p1: { id: 'p1', parentModuleId: 'gp', platformId: PLATFORM, projectId: PROJECT },
    });
    await ModuleService.create({ projectId: PROJECT, userId: USER, platformId: PLATFORM, parentModuleId: 'p1', name: 'x' });
    expect(moduleDb.insertModule).toHaveBeenCalledWith(expect.objectContaining({ parent_module_id: 'p1' }));
  });
});

describe('ModuleService.update re-parent', () => {
  it('rejects a folder becoming its own parent', async () => {
    await expect(
      ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'M' }),
    ).rejects.toThrow(/its own parent/);
    expect(moduleDb.updateModuleRow).not.toHaveBeenCalled();
  });

  it('rejects moving a folder into one of its own sub-folders (cycle)', async () => {
    // M -> C (C is a child of M). Moving M under C is a cycle.
    useCores({
      M: { id: 'M', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      C: { id: 'C', parentModuleId: 'M', platformId: PLATFORM, projectId: PROJECT },
    });
    await expect(
      ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'C' }),
    ).rejects.toThrow(/own sub-folders/);
  });

  it('rejects a move that would push the subtree past the depth cap', async () => {
    // Target P has depth 2; moved folder M has a child (subtree height 2) → 4 > 3.
    useCores({
      P0: { id: 'P0', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      P: { id: 'P', parentModuleId: 'P0', platformId: PLATFORM, projectId: PROJECT },
      M: { id: 'M', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      Mc: { id: 'Mc', parentModuleId: 'M', platformId: PLATFORM, projectId: PROJECT },
    });
    useChildren({ M: ['Mc'], Mc: [] });
    await expect(
      ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'P' }),
    ).rejects.toThrow(/nesting depth/);
  });

  it('applies a valid move and writes parent_module_id', async () => {
    useCores({
      P: { id: 'P', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
      M: { id: 'M', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
    });
    useChildren({ M: [] });
    await ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'P' });
    expect(moduleDb.updateModuleRow).toHaveBeenCalledWith(
      'M',
      USER,
      expect.objectContaining({ parent_module_id: 'P' }),
    );
  });

  it('allows moving a folder under a parent that was on a different platform', async () => {
    useCores({
      P: { id: 'P', parentModuleId: null, platformId: 'platform-web', projectId: PROJECT },
      M: { id: 'M', parentModuleId: null, platformId: 'platform-mobile', projectId: PROJECT },
    });
    useChildren({ M: [] });
    await ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'P' });
    expect(moduleDb.updateModuleRow).toHaveBeenCalledWith(
      'M',
      USER,
      expect.objectContaining({ parent_module_id: 'P' }),
    );
  });

  it('rejects moving a folder under a parent in a different project', async () => {
    useCores({
      P: { id: 'P', parentModuleId: null, platformId: PLATFORM, projectId: 'other-project' },
      M: { id: 'M', parentModuleId: null, platformId: PLATFORM, projectId: PROJECT },
    });
    useChildren({ M: [] });
    await expect(
      ModuleService.update({ id: 'M', userId: USER, parentModuleId: 'P' }),
    ).rejects.toThrow(/different project/);
    expect(moduleDb.updateModuleRow).not.toHaveBeenCalled();
  });

  it('moving to top level (null) skips the parent lookup', async () => {
    await ModuleService.update({ id: 'M', userId: USER, parentModuleId: null });
    expect(moduleDb.getModuleCore).not.toHaveBeenCalled();
    expect(moduleDb.updateModuleRow).toHaveBeenCalledWith('M', USER, { parent_module_id: null });
  });
});

describe('ModuleService list & reorder pass-through', () => {
  it('forwards the parentModuleId filter to the db layer', async () => {
    (moduleDb.listModules as jest.Mock).mockResolvedValue({ items: [], total: 0 });
    await ModuleService.listByProject(PROJECT, USER, { platformId: PLATFORM, parentModuleId: null });
    expect(moduleDb.listModules).toHaveBeenCalledWith(
      PROJECT,
      USER,
      expect.objectContaining({ parentModuleId: null }),
    );
  });

  it('reorders siblings (project-scoped) and invalidates the cache', async () => {
    await ModuleService.reorder(PROJECT, ['a', 'b', 'c'], USER);
    expect(moduleDb.setModuleOrderIndexes).toHaveBeenCalledWith(['a', 'b', 'c'], PROJECT, USER);
    expect(cache.delByPattern).toHaveBeenCalledWith(`qait:cache:ptree:base:${PROJECT}:*`);
  });
});
