/**
 * Blob storage abstraction for mobile app binaries (APK/IPA/AAB).
 *
 * Decouples `MobileAppStorageService` from the concrete backend so the same
 * service works against Supabase Storage or Azure Blob Storage, selected by
 * `MOBILE_APP_STORAGE_PROVIDER`. See DECISIONS.md ADR-0008.
 *
 * The canonical `storagePath` is always
 * `mobile-apps/{workspaceId}/{projectId}/{platform}/{file}` (the historical
 * Supabase bucket-internal path). Each implementation maps it to its own
 * namespace — Supabase uses it verbatim inside the `qai-assets` bucket; Azure
 * strips the leading `mobile-apps/` because the Azure CONTAINER is already
 * `mobile-apps` (otherwise the object would land at `mobile-apps/mobile-apps/…`).
 */

export interface BlobStatResult {
  sizeBytes: number;
  contentType: string | null;
}

export interface SignedUploadTarget {
  /** URL the client PUTs/uploads the binary to directly. */
  uploadUrl: string;
  /**
   * Supabase signed-upload token (consumed by the client's `uploadToSignedUrl`).
   * Azure SAS embeds auth in the URL, so it returns `''`. Kept on the contract
   * so the existing finalize/route response shape is preserved.
   */
  token: string;
  storagePath: string;
  /**
   * Headers the direct PUT to `uploadUrl` MUST carry for this provider.
   *
   * Azure rejects a block-blob PUT without `x-ms-blob-type` with
   * `400 MissingRequiredHeader`; Supabase uses `x-upsert` to refuse an
   * overwrite. The provider that minted the URL is the only thing that knows
   * which applies, so it says so here — a caller (the web client, a customer's
   * CI job) must never have to infer it from the URL's hostname.
   */
  requiredHeaders: Record<string, string>;
}

export interface BlobStore {
  /** Provider id — for logging / diagnostics. */
  readonly provider: 'supabase' | 'azure';

  /** Upload a binary. Overwrites are not expected (a new file per upload). */
  upload(
    storagePath: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void>;

  /** Download the whole object into memory (proxied to the runner). */
  download(storagePath: string): Promise<Buffer>;

  /** Delete objects. Best-effort per path; never throws on a missing object. */
  remove(storagePaths: string[]): Promise<void>;

  /** Object size + content-type, or null when absent. */
  stat(storagePath: string): Promise<BlobStatResult | null>;

  /**
   * Long-lived display URL for the Settings UI. Supabase returns a public URL;
   * Azure (private container) returns `''` — callers must treat empty as "no
   * public link" and mint a signed URL on demand if a download is needed.
   */
  getDisplayUrl(storagePath: string): Promise<string>;

  /** Short-lived download URL (server-minted, e.g. for a UI download click). */
  createSignedDownloadUrl(storagePath: string, expiresInSeconds: number): Promise<string>;

  /** One-time client-direct upload target (bypasses the API request-size limit). */
  createSignedUploadUrl(storagePath: string): Promise<SignedUploadTarget>;
}

/**
 * Thrown by `download`/`stat` when an object is absent — drives the dual-read
 * fallback (try Azure, then Supabase for legacy objects).
 */
export class BlobNotFoundError extends Error {
  constructor(
    public readonly storagePath: string,
    public readonly provider: string,
  ) {
    super(`Blob not found at ${storagePath} (${provider})`);
    this.name = 'BlobNotFoundError';
  }
}
