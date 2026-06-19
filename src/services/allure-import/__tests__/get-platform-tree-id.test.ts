/**
 * Tests for getPlatformTreeId — resolves which platform-tree node imported
 * Modules/Flows are placed under. Web tests go under the web_ui node; all
 * three mobile variants share the single `mobile` node (the specific variant
 * lives on each test case's `platform` field, not the tree).
 */

const mockEnsurePlatformsExist = jest.fn();

jest.mock('@/services/testing/platforms/platform.service', () => ({
  PlatformService: {
    ensurePlatformsExist: (...args: unknown[]) => mockEnsurePlatformsExist(...args),
  },
}));

// The mapper imports these at module load; stub so import doesn't fail.
jest.mock('@/services/testing/modules/module.service', () => ({ ModuleService: {} }));
jest.mock('@/services/testing/flows/flow.service', () => ({ FlowService: {} }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getPlatformTreeId } from '../allure-mapper';

beforeEach(() => {
  mockEnsurePlatformsExist.mockReset();
  mockEnsurePlatformsExist.mockResolvedValue({
    webUi: { id: 'web-node' },
    api: { id: 'api-node' },
    mobile: { id: 'mobile-node' },
  });
});

describe('getPlatformTreeId', () => {
  it('routes web to the web_ui tree node', async () => {
    await expect(getPlatformTreeId('p1', 'u1', 'web')).resolves.toBe('web-node');
  });

  it.each(['mobile_android', 'mobile_ios', 'mobile_flutter'] as const)(
    'routes %s to the single mobile tree node',
    async (platform) => {
      await expect(getPlatformTreeId('p1', 'u1', platform)).resolves.toBe('mobile-node');
    },
  );

  it('passes the project and user through to ensurePlatformsExist', async () => {
    await getPlatformTreeId('proj-42', 'user-7', 'mobile_android');
    expect(mockEnsurePlatformsExist).toHaveBeenCalledWith('proj-42', 'user-7');
  });
});
