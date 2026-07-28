/**
 * Tests for the CI publish orchestration.
 *
 * What this service exists to get right, and therefore what is locked here:
 *   - The lane defaults to the project's CONFIGURED default variant, not the
 *     literal 'default' lane. Getting this wrong is the bug that made a
 *     project which promoted `Production` write CI uploads into `default` and
 *     resolve from `Production` — never seeing its own CI builds.
 *   - Write access is checked UP FRONT. `updateProject` throws on a denied
 *     write and runs after the build row is inserted.
 *   - `source: 'ci'` reaches `recordBuild`.
 *   - A failed finalize deletes its orphaned object — EXCEPT when the path is
 *     not ours, where deleting would be a cross-tenant delete primitive.
 *
 * `mobile-app.service.ts` is stubbed: its waterfall has its own tests, and the
 * boundary under test is what this service passes to it.
 */

jest.mock('@/services/core/workspace-access.service', () => ({
  PERMISSIONS: { PROJECT_WRITE: 'project:write' },
  WorkspaceAccessService: { hasPermission: jest.fn() },
}));

jest.mock('@/services/mobile/mobile-app.service', () => ({
  createMobileAppUploadUrl: jest.fn(),
  finalizeMobileAppUpload: jest.fn(),
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    getProjectDefaultVariant: jest.fn(),
    deleteApp: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import * as MobileAppService from '@/services/mobile/mobile-app.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { createCiUploadUrl, finalizeCiUpload } from '../ci-app-publish.service';

const hasPermissionMock = WorkspaceAccessService.hasPermission as jest.Mock;
const createUrlMock = MobileAppService.createMobileAppUploadUrl as jest.Mock;
const finalizeMock = MobileAppService.finalizeMobileAppUpload as jest.Mock;
const defaultVariantMock = MobileAppStorageService.getProjectDefaultVariant as jest.Mock;
const deleteAppMock = MobileAppStorageService.deleteApp as jest.Mock;

const PROJECT = {
  id: 'proj-1',
  user_id: 'owner-9',
  workspace_id: 'ws-1',
  settings: {},
};
const STORAGE_PATH = 'mobile-apps/ws-1/proj-1/android/app_123.apk';

const FINALIZE_OK = {
  mobileApp: { storagePath: STORAGE_PATH, platform: 'android' },
  build: { id: 'build-1' },
  shouldAutoBoot: true as const,
  platform: 'android',
  variantLabel: 'Production',
};

beforeEach(() => {
  jest.clearAllMocks();
  hasPermissionMock.mockResolvedValue(true);
  defaultVariantMock.mockResolvedValue('Production');
  createUrlMock.mockResolvedValue({
    uploadUrl: 'https://storage.example/put',
    token: 'tok',
    storagePath: STORAGE_PATH,
    requiredHeaders: { 'x-ms-blob-type': 'BlockBlob' },
  });
  finalizeMock.mockResolvedValue(FINALIZE_OK);
  deleteAppMock.mockResolvedValue(undefined);
});

describe('createCiUploadUrl', () => {
  it("defaults the lane to the project's configured default variant", async () => {
    await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: 1000,
    });

    expect(defaultVariantMock).toHaveBeenCalledWith('proj-1', 'android');
    expect(createUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ variantLabel: 'Production' }),
    );
  });

  it('honours an explicitly requested variant over the project default', async () => {
    await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: null,
      variantLabel: 'Staging',
    });

    expect(createUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ variantLabel: 'Staging' }),
    );
  });

  it('takes projectId and userId from the project, never from caller input', async () => {
    await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: null,
    });

    expect(createUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', userId: 'owner-9' }),
    );
  });

  it('returns the provider requiredHeaders so the PUT does not have to guess', async () => {
    const result = await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: null,
    });

    expect(result).toEqual(
      expect.objectContaining({ requiredHeaders: { 'x-ms-blob-type': 'BlockBlob' } }),
    );
  });

  it('does not leak the Supabase upload token to a CI caller', async () => {
    const result = await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: null,
    });

    expect(result).not.toHaveProperty('token');
  });

  it('refuses when the key owner no longer has PROJECT_WRITE', async () => {
    hasPermissionMock.mockResolvedValue(false);

    const result = await createCiUploadUrl({
      project: PROJECT,
      filename: 'app.apk',
      platform: 'android',
      declaredSize: null,
    });

    expect(result).toEqual({ kind: 'write_denied' });
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('passes a service error tag straight through', async () => {
    createUrlMock.mockResolvedValue({ kind: 'invalid_filename', ext: '.txt' });

    const result = await createCiUploadUrl({
      project: PROJECT,
      filename: 'notes.txt',
      platform: 'android',
      declaredSize: null,
    });

    expect(result).toEqual({ kind: 'invalid_filename', ext: '.txt' });
  });
});

describe('finalizeCiUpload', () => {
  it("records the build with source 'ci' in the project's default lane", async () => {
    await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
      commitSha: 'abc123',
    });

    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ci',
        variantLabel: 'Production',
        projectId: 'proj-1',
        userId: 'owner-9',
        commitSha: 'abc123',
      }),
    );
  });

  it('returns the lane the build actually landed in, for the caller to prune', async () => {
    const result = await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(result).toEqual(
      expect.objectContaining({ variant: 'Production', platform: 'android' }),
    );
  });

  it('refuses when the key owner no longer has PROJECT_WRITE, before any work', async () => {
    hasPermissionMock.mockResolvedValue(false);

    const result = await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(result).toEqual({ kind: 'write_denied' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('cleans up the already-uploaded binary when write access was revoked mid-flow', async () => {
    // upload-url granted access, the customer PUT the binary, access was
    // revoked, finalize refuses — nothing will ever record it.
    hasPermissionMock.mockResolvedValue(false);

    await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(deleteAppMock).toHaveBeenCalledWith(STORAGE_PATH);
  });

  it('still refuses to delete an out-of-tree path when write access is denied', async () => {
    hasPermissionMock.mockResolvedValue(false);

    await finalizeCiUpload({
      project: PROJECT,
      storagePath: 'mobile-apps/ws-OTHER/proj-OTHER/android/victim.apk',
      platform: 'android',
      originalName: 'victim.apk',
    });

    expect(deleteAppMock).not.toHaveBeenCalled();
  });
});

describe('finalizeCiUpload — orphan cleanup', () => {
  it.each([
    ['build_record_failed (duplicate commit)', { kind: 'build_record_failed', code: '23505' }],
    ['package_name_required', { kind: 'package_name_required' }],
    ['object_empty', { kind: 'object_empty' }],
    ['variant_limit', { kind: 'variant_limit', max: 3, platform: 'android' }],
  ])('deletes the orphaned object when finalize fails with %s', async (_label, err) => {
    finalizeMock.mockResolvedValue(err);

    await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    // Nothing else garbage-collects it: paths are unique per call, and
    // pruneOldBuilds only reclaims storage for ROWS it prunes.
    expect(deleteAppMock).toHaveBeenCalledWith(STORAGE_PATH);
  });

  it('does NOT delete when the path is outside this project — that would be a cross-tenant delete', async () => {
    const otherTenantPath = 'mobile-apps/ws-OTHER/proj-OTHER/android/victim.apk';
    finalizeMock.mockResolvedValue({ kind: 'invalid_storage_path' });

    const result = await finalizeCiUpload({
      project: PROJECT,
      storagePath: otherTenantPath,
      platform: 'android',
      originalName: 'victim.apk',
    });

    expect(result).toEqual({ kind: 'invalid_storage_path' });
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it('does not delete when the object was never there', async () => {
    finalizeMock.mockResolvedValue({ kind: 'object_missing' });

    await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it('does not delete on success', async () => {
    await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it('still returns the original error when cleanup itself fails', async () => {
    finalizeMock.mockResolvedValue({ kind: 'package_name_required' });
    deleteAppMock.mockRejectedValue(new Error('storage down'));

    const result = await finalizeCiUpload({
      project: PROJECT,
      storagePath: STORAGE_PATH,
      platform: 'android',
      originalName: 'app.apk',
    });

    expect(result).toEqual({ kind: 'package_name_required' });
  });
});
