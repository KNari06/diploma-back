import { resolveEnvironmentBinding } from '../environment-binding.service';
import { getResource } from '@/services/test-resource/test-resource.service';

jest.mock('@/services/test-resource/test-resource.service', () => ({
  getResource: jest.fn(),
}));

const mockedGetResource = getResource as jest.MockedFunction<typeof getResource>;

describe('resolveEnvironmentBinding', () => {
  const params = { userId: 'u-1', projectId: 'p-1', environmentResourceId: 'e-1' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an environment binding for a valid environment in the project', async () => {
    mockedGetResource.mockResolvedValue({ id: 'e-1', kind: 'environment', projectId: 'p-1' } as any);

    await expect(resolveEnvironmentBinding(params)).resolves.toEqual({
      ok: true,
      binding: { kind: 'environment', resource_id: 'e-1' },
    });
    // Scoped by the requesting user, matching how the dialog lists environments.
    expect(mockedGetResource).toHaveBeenCalledWith('e-1', 'u-1');
  });

  it('rejects when the resource does not exist (or is not the user\'s)', async () => {
    mockedGetResource.mockResolvedValue(null);

    await expect(resolveEnvironmentBinding(params)).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('rejects a resource of a different kind', async () => {
    mockedGetResource.mockResolvedValue({ id: 'e-1', kind: 'secret', projectId: 'p-1' } as any);

    await expect(resolveEnvironmentBinding(params)).resolves.toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
  });

  it('rejects an environment that belongs to another project', async () => {
    mockedGetResource.mockResolvedValue({ id: 'e-1', kind: 'environment', projectId: 'p-2' } as any);

    await expect(resolveEnvironmentBinding(params)).resolves.toEqual({
      ok: false,
      reason: 'wrong_project',
    });
  });
});
