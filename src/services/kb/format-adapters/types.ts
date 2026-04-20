/**
 * Format adapter contract for project KB ingestion.
 *
 * Each adapter converts a raw uploaded file into retrieval-friendly chunks,
 * structured according to the file's semantics. Generic markdown/text flows
 * through the fallback adapter (existing chunkMarkdown/chunkText).
 *
 * Why per-format adapters?
 *   An OpenAPI spec has 30 endpoints. A generic text chunker would produce
 *   800-token slabs that straddle endpoint boundaries — a query for "POST /users"
 *   matches noisy chunks. One chunk per endpoint gives precise retrieval: a
 *   query for the endpoint lands exactly on that endpoint's section.
 */

// 'auto:trace' is produced by the Phase 5 auto-learn pipeline (not by a
// format adapter). Typing it here keeps all callers that read `format` back
// from project_kb_chunks type-safe.
export type ProjectKBFormat = 'openapi' | 'postman' | 'generic' | 'auto:trace';

export interface AdapterChunk {
  /** The text that will be embedded AND sent to the LLM. */
  content: string;
  /** Human-friendly title for the chunk (e.g. "POST /api/users"). Stored in metadata. */
  sectionTitle?: string;
  /** Extra structured metadata for filtering/debugging (e.g. http method, path). */
  metadata?: Record<string, unknown>;
}

export interface AdapterResult {
  format: ProjectKBFormat;
  chunks: AdapterChunk[];
  /** Summary for logs and UI (e.g. "OpenAPI 3.1 · 18 endpoints · 2 schemas"). */
  summary: string;
}

export interface FormatAdapter {
  name: ProjectKBFormat;

  /**
   * Quick test: does this adapter recognise the file? Should not throw.
   * Called in order of specificity (structured formats first, generic last).
   */
  detect(fileName: string, raw: string): boolean;

  /**
   * Produce structured chunks from the already-read file content.
   * Must not perform IO — file reading is done once up-front by the router.
   */
  extract(fileName: string, raw: string): AdapterResult;
}
