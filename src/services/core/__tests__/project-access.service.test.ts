import { hasProjectAccess } from '../project-access.service';

const fetchRow = jest.fn();
const getRole = jest.fn();

jest.mock('../db/project-access.db', () => ({
  fetchProjectAccessRow: (...a: unknown[]) => fetchRow(...a),
}));
jest.mock('../workspace-access.service', () => ({
  WorkspaceAccessService: { getRole: (...a: unknown[]) => getRole(...a) },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  fetchRow.mockReset();
  getRole.mockReset();
});

describe('hasProjectAccess', () => {
  it('allows the project owner', async () => {
    fetchRow.mockResolvedValue({ userId: 'u1', workspaceId: null });

    await expect(hasProjectAccess('p1', 'u1')).resolves.toBe(true);
    expect(getRole).not.toHaveBeenCalled();
  });

  it('allows any member of the project workspace', async () => {
    fetchRow.mockResolvedValue({ userId: 'owner', workspaceId: 'w1' });
    getRole.mockResolvedValue('member');

    await expect(hasProjectAccess('p1', 'u2')).resolves.toBe(true);
    // Argument ORDER is load-bearing and invisible to a mock that ignores it:
    // swapped, every test here still passes green while a fail-closed security
    // gate silently mis-decides. Real signature: getRole(userId, workspaceId).
    expect(getRole).toHaveBeenCalledWith('u2', 'w1');
  });

  it('denies a non-owner who is not in the workspace', async () => {
    fetchRow.mockResolvedValue({ userId: 'owner', workspaceId: 'w1' });
    getRole.mockResolvedValue(null);

    await expect(hasProjectAccess('p1', 'stranger')).resolves.toBe(false);
  });

  it('denies a non-owner when the project has no workspace', async () => {
    fetchRow.mockResolvedValue({ userId: 'owner', workspaceId: null });

    await expect(hasProjectAccess('p1', 'stranger')).resolves.toBe(false);
  });

  it('denies a project that does not exist', async () => {
    fetchRow.mockResolvedValue(null);

    await expect(hasProjectAccess('nope', 'u1')).resolves.toBe(false);
  });

  it('fails CLOSED when the lookup throws', async () => {
    fetchRow.mockRejectedValue(new Error('db down'));

    await expect(hasProjectAccess('p1', 'u1')).resolves.toBe(false);
  });
});
