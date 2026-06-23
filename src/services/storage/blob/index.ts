/**
 * Blob-store factory + dual-read composition. See ADR-0008.
 *
 * `MOBILE_APP_STORAGE_PROVIDER=supabase` (default) → plain Supabase.
 * `=azure` → Azure for writes; reads fall back to Supabase for objects not yet
 * migrated (a per-object dual-read, NOT a global switch — legacy `storage_path`
 * values still live in Supabase until they prune away).
 */

import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import {
  BlobNotFoundError,
  type BlobStatResult,
  type BlobStore,
  type SignedUploadTarget,
} from './blob-store';
import { SupabaseBlobStore } from './supabase-blob-store';
import { AzureBlobStore } from './azure-blob-store';

/**
 * Writes + new-upload URLs go to `primary` (Azure). Reads try `primary`, then
 * fall back to `fallback` (Supabase) for legacy objects.
 */
class DualReadBlobStore implements BlobStore {
  readonly provider = 'azure' as const;

  constructor(
    private readonly primary: BlobStore,
    private readonly fallback: BlobStore,
  ) {}

  upload(storagePath: string, body: Buffer, opts: { contentType: string; cacheControl?: string }): Promise<void> {
    return this.primary.upload(storagePath, body, opts);
  }

  remove(storagePaths: string[]): Promise<void> {
    // Remove from both — a build pruned post-cutover may still have its legacy
    // copy in Supabase. Both are best-effort and never throw on absence.
    return Promise.all([this.primary.remove(storagePaths), this.fallback.remove(storagePaths)]).then(() => undefined);
  }

  createSignedUploadUrl(storagePath: string): Promise<SignedUploadTarget> {
    return this.primary.createSignedUploadUrl(storagePath);
  }

  async download(storagePath: string): Promise<Buffer> {
    try {
      return await this.primary.download(storagePath);
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        logger.info('[BLOB_STORE] dual-read fallback to supabase', { op: 'download', storagePath });
        return this.fallback.download(storagePath);
      }
      throw err;
    }
  }

  async stat(storagePath: string): Promise<BlobStatResult | null> {
    return (await this.primary.stat(storagePath)) ?? this.fallback.stat(storagePath);
  }

  async getDisplayUrl(storagePath: string): Promise<string> {
    // Azure (primary) returns '' by design for objects it holds; only reach for
    // a Supabase public URL when the object is a legacy one Azure doesn't have.
    if (await this.primary.stat(storagePath)) return this.primary.getDisplayUrl(storagePath);
    return (await this.fallback.stat(storagePath)) ? this.fallback.getDisplayUrl(storagePath) : '';
  }

  async createSignedDownloadUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    if (await this.primary.stat(storagePath)) {
      return this.primary.createSignedDownloadUrl(storagePath, expiresInSeconds);
    }
    return this.fallback.createSignedDownloadUrl(storagePath, expiresInSeconds);
  }
}

let cached: BlobStore | null = null;

/** Process-wide blob store for mobile app binaries. */
export function getBlobStore(): BlobStore {
  if (cached) return cached;
  if (env.MOBILE_APP_STORAGE_PROVIDER === 'azure') {
    cached = new DualReadBlobStore(new AzureBlobStore(), new SupabaseBlobStore());
    logger.info('[BLOB_STORE] provider=azure (dual-read fallback: supabase)');
  } else {
    cached = new SupabaseBlobStore();
    logger.info('[BLOB_STORE] provider=supabase');
  }
  return cached;
}

/** Test seam — override / reset the cached store. */
export function __setBlobStoreForTests(store: BlobStore | null): void {
  cached = store;
}

export * from './blob-store';
