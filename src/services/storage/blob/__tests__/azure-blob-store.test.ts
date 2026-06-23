/**
 * Unit tests for AzureBlobStore — the Azure SDK is fully mocked (Azurite does
 * not support user-delegation SAS, so the SAS path can't be integration-tested
 * there; see ADR-0008). Focus: the `mobile-apps/` prefix-stripping that keeps
 * objects out of `mobile-apps/mobile-apps/…`, not-found mapping, and SAS shape.
 */

jest.mock('@/config/environment/env', () => ({
  env: {
    AZURE_STORAGE_ACCOUNT: 'qaiprodapps',
    AZURE_STORAGE_CONTAINER: 'mobile-apps',
    AZURE_CLIENT_ID: 'client-123',
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getBlockBlobClient = jest.fn();
const getUserDelegationKey = jest.fn().mockResolvedValue({ signedObjectId: 'k' });

jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn().mockImplementation(() => ({
    getContainerClient: () => ({ getBlockBlobClient }),
    getUserDelegationKey,
  })),
  BlobSASPermissions: { parse: (perm: string) => ({ perm }) },
  generateBlobSASQueryParameters: jest.fn(() => ({ toString: () => 'sig=abc&se=later' })),
  SASProtocol: { Https: 'https' },
}));

import { AzureBlobStore } from '../azure-blob-store';
import { BlobNotFoundError } from '../blob-store';

const CANONICAL = 'mobile-apps/ws1/proj1/android/app_123.apk';
const EXPECTED_BLOB = 'ws1/proj1/android/app_123.apk';

function makeBlobClient(overrides: Record<string, unknown> = {}) {
  return {
    url: `https://qaiprodapps.blob.core.windows.net/mobile-apps/${EXPECTED_BLOB}`,
    uploadData: jest.fn().mockResolvedValue(undefined),
    downloadToBuffer: jest.fn().mockResolvedValue(Buffer.from('apk-bytes')),
    deleteIfExists: jest.fn().mockResolvedValue({ succeeded: true }),
    getProperties: jest.fn().mockResolvedValue({ contentLength: 42, contentType: 'application/vnd.android.package-archive' }),
    ...overrides,
  };
}

describe('AzureBlobStore', () => {
  beforeEach(() => {
    getBlockBlobClient.mockReset();
    getBlockBlobClient.mockImplementation(() => makeBlobClient());
  });

  it('strips the mobile-apps/ container prefix from the blob name', async () => {
    const store = new AzureBlobStore();
    await store.upload(CANONICAL, Buffer.from('x'), { contentType: 'application/vnd.android.package-archive' });
    expect(getBlockBlobClient).toHaveBeenCalledWith(EXPECTED_BLOB);
  });

  it('leaves an already-stripped path untouched', async () => {
    const store = new AzureBlobStore();
    await store.stat('ws1/proj1/android/app.apk');
    expect(getBlockBlobClient).toHaveBeenCalledWith('ws1/proj1/android/app.apk');
  });

  it('downloads the object as a Buffer', async () => {
    const store = new AzureBlobStore();
    const buf = await store.download(CANONICAL);
    expect(buf.toString()).toBe('apk-bytes');
  });

  it('maps a 404 download to BlobNotFoundError (so dual-read can fall back)', async () => {
    getBlockBlobClient.mockImplementation(() =>
      makeBlobClient({ downloadToBuffer: jest.fn().mockRejectedValue({ statusCode: 404 }) }),
    );
    const store = new AzureBlobStore();
    await expect(store.download(CANONICAL)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('returns null stat for a missing blob', async () => {
    getBlockBlobClient.mockImplementation(() =>
      makeBlobClient({ getProperties: jest.fn().mockRejectedValue({ code: 'BlobNotFound' }) }),
    );
    const store = new AzureBlobStore();
    expect(await store.stat(CANONICAL)).toBeNull();
  });

  it('returns "" for getDisplayUrl (private container — no public URL)', async () => {
    const store = new AzureBlobStore();
    expect(await store.getDisplayUrl(CANONICAL)).toBe('');
  });

  it('creates a SAS upload URL with an empty token and the blob URL + query', async () => {
    const store = new AzureBlobStore();
    const target = await store.createSignedUploadUrl(CANONICAL);
    expect(target.token).toBe('');
    expect(target.storagePath).toBe(CANONICAL);
    expect(target.uploadUrl).toContain(EXPECTED_BLOB);
    expect(target.uploadUrl).toContain('?sig=abc');
  });

  it('reuses one user-delegation key across multiple signings', async () => {
    const store = new AzureBlobStore();
    await store.createSignedDownloadUrl(CANONICAL, 600);
    await store.createSignedDownloadUrl(CANONICAL, 600);
    expect(getUserDelegationKey).toHaveBeenCalledTimes(1);
  });
});
