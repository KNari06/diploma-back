/**
 * Azure Blob Storage implementation of {@link BlobStore}.
 *
 * Auth: Managed Identity via `DefaultAzureCredential` (+ `AZURE_CLIENT_ID` to
 * disambiguate the user-assigned identity on Azure Container Apps). Signed URLs
 * are **user-delegation SAS** — no account key in app config. See ADR-0008.
 *
 * Container mapping: the canonical `storagePath` begins with `mobile-apps/`,
 * which is also the Azure CONTAINER name, so the leading segment is stripped to
 * form the blob name (otherwise objects land at `mobile-apps/mobile-apps/…`).
 */

import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import {
  BlobNotFoundError,
  type BlobListEntry,
  type BlobStatResult,
  type BlobStore,
  type SignedUploadTarget,
} from './blob-store';

/** Leading segment of the canonical path that equals the Azure container. */
const CONTAINER_PREFIX = 'mobile-apps/';
/** Clock-skew guard applied to every SAS / delegation-key start time. */
const SKEW_MS = 5 * 60_000;
/** User-delegation key lifetime — one key signs many short-lived SAS. */
const DELEGATION_KEY_TTL_MS = 60 * 60_000;
/** Client-direct upload SAS lifetime (PUT the binary). */
const UPLOAD_SAS_TTL_SECONDS = 15 * 60;

export class AzureBlobStore implements BlobStore {
  readonly provider = 'azure' as const;
  private readonly account: string;
  private readonly container: string;
  private readonly service: BlobServiceClient;
  /** Cached user-delegation key, refreshed before expiry. */
  private delegationKey: { key: UserDelegationKey; expiresOn: Date } | null = null;

  constructor() {
    const account = env.AZURE_STORAGE_ACCOUNT;
    if (!account) {
      throw new Error('AZURE_STORAGE_ACCOUNT is required when MOBILE_APP_STORAGE_PROVIDER=azure');
    }
    this.account = account;
    this.container = env.AZURE_STORAGE_CONTAINER;
    const credential = new DefaultAzureCredential(
      env.AZURE_CLIENT_ID ? { managedIdentityClientId: env.AZURE_CLIENT_ID } : undefined,
    );
    this.service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
  }

  /**
   * Enumerate every blob under `prefix`, newest-agnostic, paged by the SDK.
   *
   * `prefix` is a canonical storagePath prefix (`mobile-apps/<ws>/<project>/`);
   * the container segment is stripped on the way in and restored on the way out
   * so callers only ever deal in canonical paths — the same mapping `blobName`
   * applies for single-object operations.
   */
  async *list(prefix: string): AsyncIterable<BlobListEntry> {
    const container = this.service.getContainerClient(this.container);
    for await (const blob of container.listBlobsFlat({ prefix: this.blobName(prefix) })) {
      yield {
        storagePath: `${CONTAINER_PREFIX}${blob.name}`,
        sizeBytes: Number(blob.properties.contentLength ?? 0),
        createdAt: blob.properties.createdOn ?? blob.properties.lastModified ?? null,
      };
    }
  }

  /** Map the canonical `storagePath` to an Azure blob name. */
  private blobName(storagePath: string): string {
    return storagePath.startsWith(CONTAINER_PREFIX)
      ? storagePath.slice(CONTAINER_PREFIX.length)
      : storagePath;
  }

  private blockClient(storagePath: string) {
    return this.service
      .getContainerClient(this.container)
      .getBlockBlobClient(this.blobName(storagePath));
  }

  async upload(
    storagePath: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    await this.blockClient(storagePath).uploadData(body, {
      blobHTTPHeaders: {
        blobContentType: opts.contentType,
        ...(opts.cacheControl ? { blobCacheControl: opts.cacheControl } : {}),
      },
    });
  }

  async download(storagePath: string): Promise<Buffer> {
    try {
      return await this.blockClient(storagePath).downloadToBuffer();
    } catch (err) {
      if (isNotFound(err)) throw new BlobNotFoundError(storagePath, this.provider);
      throw err;
    }
  }

  async remove(storagePaths: string[]): Promise<void> {
    await Promise.all(
      storagePaths.map(async (p) => {
        try {
          await this.blockClient(p).deleteIfExists();
        } catch (err) {
          logger.warn('[BLOB_STORE] azure delete failed', { path: p, error: errMessage(err) });
        }
      }),
    );
  }

  async stat(storagePath: string): Promise<BlobStatResult | null> {
    try {
      const props = await this.blockClient(storagePath).getProperties();
      return {
        sizeBytes: props.contentLength ?? 0,
        contentType: props.contentType ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // Private container → no permanent public URL. The UI mints a signed
  // download URL on demand; empty string signals "no public link".
  async getDisplayUrl(_storagePath: string): Promise<string> {
    return '';
  }

  async createSignedDownloadUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    return this.sign(storagePath, BlobSASPermissions.parse('r'), expiresInSeconds);
  }

  async createSignedUploadUrl(storagePath: string): Promise<SignedUploadTarget> {
    // Create + write so the client can PUT a new block blob directly.
    const uploadUrl = await this.sign(storagePath, BlobSASPermissions.parse('cw'), UPLOAD_SAS_TTL_SECONDS);
    // MANDATORY on a block-blob PUT — without it Azure answers
    // `400 MissingRequiredHeader` and the upload fails with no useful hint.
    return {
      uploadUrl,
      token: '',
      storagePath,
      requiredHeaders: { 'x-ms-blob-type': 'BlockBlob' },
    };
  }

  /** Fetch (or reuse) a user-delegation key that covers `coversUntil`. */
  private async getDelegationKey(coversUntil: Date): Promise<UserDelegationKey> {
    if (this.delegationKey && this.delegationKey.expiresOn.getTime() - 60_000 > coversUntil.getTime()) {
      return this.delegationKey.key;
    }
    const startsOn = new Date(Date.now() - SKEW_MS);
    const expiresOn = new Date(Date.now() + DELEGATION_KEY_TTL_MS);
    const key = await this.service.getUserDelegationKey(startsOn, expiresOn);
    this.delegationKey = { key, expiresOn };
    return key;
  }

  private async sign(
    storagePath: string,
    permissions: BlobSASPermissions,
    expiresInSeconds: number,
  ): Promise<string> {
    const startsOn = new Date(Date.now() - SKEW_MS);
    const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
    const delegationKey = await this.getDelegationKey(expiresOn);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.container,
        blobName: this.blobName(storagePath),
        permissions,
        startsOn,
        expiresOn,
        protocol: SASProtocol.Https,
      },
      delegationKey,
      this.account,
    ).toString();
    return `${this.blockClient(storagePath).url}?${sas}`;
  }
}

/** Azure surfaces a missing blob as a 404 / `BlobNotFound` RestError. */
function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string; details?: { errorCode?: string } };
  return e?.statusCode === 404 || e?.code === 'BlobNotFound' || e?.details?.errorCode === 'BlobNotFound';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
