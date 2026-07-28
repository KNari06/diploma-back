/**
 * Supabase Storage implementation of {@link BlobStore} — the legacy backend.
 *
 * Uses the canonical `storagePath` verbatim as the object key inside the
 * `qai-assets` bucket (i.e. `mobile-apps/{ws}/…`). This is a thin data-access
 * adapter, so importing `supabaseAdmin` directly here is correct (it IS the
 * storage boundary, the same role a `db/` file plays for SQL).
 */

import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import {
  BlobNotFoundError,
  type BlobStatResult,
  type BlobStore,
  type SignedUploadTarget,
} from './blob-store';

const BUCKET = env.SUPABASE_BUCKET_NAME; // 'qai-assets'

export class SupabaseBlobStore implements BlobStore {
  readonly provider = 'supabase' as const;

  async upload(
    storagePath: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, body, {
      contentType: opts.contentType,
      upsert: false,
      ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
    });
    if (error) throw new Error(`Failed to upload app: ${error.message}`);
  }

  async download(storagePath: string): Promise<Buffer> {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(storagePath);
    if (error || !data) throw new BlobNotFoundError(storagePath, this.provider);
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(storagePaths: string[]): Promise<void> {
    if (storagePaths.length === 0) return;
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(storagePaths);
    if (error) {
      logger.warn('[BLOB_STORE] supabase remove failed', { error: error.message, count: storagePaths.length });
    }
  }

  async stat(storagePath: string): Promise<BlobStatResult | null> {
    // Supabase JS SDK doesn't expose HEAD; list the parent prefix filtered by
    // the basename. Cheap (one row) and avoids downloading.
    const parent = storagePath.includes('/') ? storagePath.slice(0, storagePath.lastIndexOf('/')) : '';
    const name = storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath;

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(parent, { search: name, limit: 1 });
    if (error) {
      logger.warn('[BLOB_STORE] supabase stat list failed', { error: error.message, storagePath });
      return null;
    }
    const row = (data || []).find((r) => r.name === name);
    if (!row) return null;
    return {
      sizeBytes: Number((row.metadata as any)?.size ?? 0),
      contentType: ((row.metadata as any)?.mimetype as string | undefined) ?? null,
    };
  }

  async getDisplayUrl(storagePath: string): Promise<string> {
    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  }

  async createSignedDownloadUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(storagePath, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new Error(`Failed to create signed URL: ${error?.message || 'Unknown error'}`);
    }
    return data.signedUrl;
  }

  async createSignedUploadUrl(storagePath: string): Promise<SignedUploadTarget> {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data?.signedUrl || !data?.token) {
      throw new Error(`Failed to create signed upload URL: ${error?.message || 'Unknown error'}`);
    }
    // `x-upsert: false` refuses an overwrite. The backend always mints a unique
    // timestamped path, so this is belt-and-braces against a replayed URL.
    return {
      uploadUrl: data.signedUrl,
      token: data.token,
      storagePath,
      requiredHeaders: { 'x-upsert': 'false' },
    };
  }
}
