/**
 * Unit tests for the variant-management service. Collaborators (ProjectService,
 * storage) are mocked at the boundary — we assert the guard branches and that
 * the right storage + settings mutations are invoked.
 */

import { deleteMobileAppVariant, renameMobileAppVariant, setDefaultMobileVariant } from '@/services/mobile/mobile-app-variant.service';
import { ProjectService } from '@/services/core/project.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';

jest.mock('@/services/core/project.service');
jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    listVariantLabels: jest.fn(),
    deleteVariantBuilds: jest.fn(),
    renameVariantBuilds: jest.fn(),
  },
}));

const mockedProject = ProjectService as jest.Mocked<typeof ProjectService>;
const mockedStorage = MobileAppStorageService as jest.Mocked<typeof MobileAppStorageService>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedProject.getProject.mockResolvedValue({ id: 'p1', workspace_id: 'w1', settings: {} } as any);
  mockedProject.updateProject.mockResolvedValue({} as any);
});

describe('deleteMobileAppVariant', () => {
  it('refuses to delete the default lane', async () => {
    const res = await deleteMobileAppVariant('p1', 'u1', 'android', 'default');
    expect(res).toEqual({ kind: 'cannot_modify_default_variant' });
    expect(mockedStorage.deleteVariantBuilds).not.toHaveBeenCalled();
  });

  it('404s when the variant does not exist', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging']);
    const res = await deleteMobileAppVariant('p1', 'u1', 'android', 'Prod');
    expect(res).toEqual({ kind: 'variant_not_found', label: 'Prod' });
    expect(mockedStorage.deleteVariantBuilds).not.toHaveBeenCalled();
  });

  it('deletes builds + writes the registry-removal patch on success', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging']);
    mockedStorage.deleteVariantBuilds.mockResolvedValue(3);
    const res = await deleteMobileAppVariant('p1', 'u1', 'android', 'Staging');
    expect(res).toEqual({ deletedBuilds: 3 });
    expect(mockedStorage.deleteVariantBuilds).toHaveBeenCalledWith('p1', 'android', 'Staging');
    expect(mockedProject.updateProject).toHaveBeenCalledTimes(1);
  });
});

describe('renameMobileAppVariant', () => {
  it('refuses to rename the default lane', async () => {
    const res = await renameMobileAppVariant('p1', 'u1', 'android', 'default', 'Prod');
    expect(res).toEqual({ kind: 'cannot_modify_default_variant' });
  });

  it('refuses an empty target name', async () => {
    const res = await renameMobileAppVariant('p1', 'u1', 'android', 'Staging', '   ');
    expect(res).toEqual({ kind: 'invalid_variant_name' });
  });

  it('rejects when the target name is already taken', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging', 'Prod']);
    const res = await renameMobileAppVariant('p1', 'u1', 'android', 'Staging', 'Prod');
    expect(res).toEqual({ kind: 'variant_name_taken', label: 'Prod' });
    expect(mockedStorage.renameVariantBuilds).not.toHaveBeenCalled();
  });

  it('renames builds + writes the rename patch on success', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging']);
    mockedStorage.renameVariantBuilds.mockResolvedValue(2);
    const res = await renameMobileAppVariant('p1', 'u1', 'android', 'Staging', 'Prod');
    expect(res).toEqual({ renamedBuilds: 2, label: 'Prod' });
    expect(mockedStorage.renameVariantBuilds).toHaveBeenCalledWith('p1', 'android', 'Staging', 'Prod');
    expect(mockedProject.updateProject).toHaveBeenCalledTimes(1);
  });
});

describe('setDefaultMobileVariant', () => {
  it('404s when the target variant has no builds', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default']);
    const res = await setDefaultMobileVariant('p1', 'u1', 'android', 'Staging');
    expect(res).toEqual({ kind: 'variant_not_found', label: 'Staging' });
    expect(mockedProject.updateProject).not.toHaveBeenCalled();
  });

  it('promotes an existing variant and writes the default-pointer patch', async () => {
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging']);
    const res = await setDefaultMobileVariant('p1', 'u1', 'android', 'Staging');
    expect(res).toEqual({ defaultVariant: 'Staging' });
    expect(mockedProject.updateProject).toHaveBeenCalledWith('p1', 'u1', {
      settings: { mobileDefaultVariant: { android: 'Staging' } },
    });
  });

  it('reverts to the default lane without requiring a build', async () => {
    const res = await setDefaultMobileVariant('p1', 'u1', 'android', 'default');
    expect(res).toEqual({ defaultVariant: 'default' });
    // No build check for the revert path.
    expect(mockedStorage.listVariantLabels).not.toHaveBeenCalled();
    expect(mockedProject.updateProject).toHaveBeenCalledWith('p1', 'u1', {
      settings: { mobileDefaultVariant: { android: 'default' } },
    });
  });

  it('treats a blank label as a revert to the default lane', async () => {
    const res = await setDefaultMobileVariant('p1', 'u1', 'android', '   ');
    expect(res).toEqual({ defaultVariant: 'default' });
    expect(mockedStorage.listVariantLabels).not.toHaveBeenCalled();
  });

  it('preserves another platform pointer when promoting one platform', async () => {
    mockedProject.getProject.mockResolvedValue({
      id: 'p1', workspace_id: 'w1', settings: { mobileDefaultVariant: { ios: 'Beta' } },
    } as any);
    mockedStorage.listVariantLabels.mockResolvedValue(['default', 'Staging']);
    await setDefaultMobileVariant('p1', 'u1', 'android', 'Staging');
    expect(mockedProject.updateProject).toHaveBeenCalledWith('p1', 'u1', {
      settings: { mobileDefaultVariant: { ios: 'Beta', android: 'Staging' } },
    });
  });

  it('404s when the project is not found', async () => {
    mockedProject.getProject.mockResolvedValue(null as any);
    const res = await setDefaultMobileVariant('p1', 'u1', 'android', 'Staging');
    expect(res).toEqual({ kind: 'project_not_found' });
    expect(mockedProject.updateProject).not.toHaveBeenCalled();
  });
});
