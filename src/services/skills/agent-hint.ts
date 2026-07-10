/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AGENT HINTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns raw skill/tool failures into LLM-actionable "Agent Hints".
 *
 * When a tool call fails, the executor returns a bare failure message — an AI
 * agent reading that has no idea what to try next. An Agent Hint attaches a
 * short list of concrete next steps (what to check / do) to the message, so the
 * agent can recover on its own.
 *
 * Wired into the executor at the single convergence point where EVERY result
 * (returned `{success:false}` AND caught-throw) has been normalized. Because
 * that path also carries results we must NOT touch (confirm-preview guards,
 * already-actionable messages, terminal aborts), enrichment is:
 *   - gated by `shouldEnrichWithHint` (skip anything already actionable / protected), and
 *   - CONSERVATIVE — `buildAgentHint` only decorates messages it can actually
 *     classify (not-found / auth / validation). Unrecognized → NO suggestions,
 *     so the message renders unchanged (no noise on unknown errors).
 *
 * Adapted from the lucius-mcp Allure MCP server's typed-error pattern (base
 * error + suggestions + subclasses + a fallback handler), rewritten for QAIT's
 * domain (test cases / plans / modules) and its `SkillResult.message` contract —
 * the hint rides inside the existing message string, so nothing downstream
 * changes shape.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Coarse error category, used to pick default suggestions. */
export type AgentHintCode = 'NOT_FOUND' | 'VALIDATION' | 'AUTH' | 'GENERIC';

/** A rendered hint: the human message plus concrete next steps for the agent. */
export interface AgentHint {
  message: string;
  suggestions: string[];
}

// ── Default Suggestions ──────────────────────────────────────────────────────

/**
 * Default suggestions per classifiable category. Kept generic to QAIT's domain
 * (tests / plans / modules) rather than any single tool. GENERIC has none: on
 * the enrichment path an unrecognized error is left alone (see `buildAgentHint`).
 */
const DEFAULT_SUGGESTIONS: Record<AgentHintCode, string[]> = {
  NOT_FOUND: [
    'Verify the ID or name is correct',
    'List the available items to find valid ones',
    'Check that you have access to the project',
  ],
  VALIDATION: [
    'Check that all required fields are present',
    'Check the expected format of each argument',
  ],
  AUTH: [
    'Check that the integration is connected and the token is valid',
    'Verify you have permission for this operation',
  ],
  GENERIC: [],
};

/**
 * Substrings that mean a message is already actionable OR must not be decorated.
 * All matched case-insensitively. Anchor forms, not an exhaustive list.
 */
const SKIP_ENRICHMENT_MARKERS = [
  // Confirm-preview / write-guards — never decorate (Hard invariant #13).
  'requires confirmation',
  'confirm=true',
  'confirm: true',
  // Already carries actionable guidance.
  'suggestions:',
  'try a different',
  'specify the exact',
  'please specify',
  'this could mean',
  // Terminal aborts — nothing to suggest.
  'request aborted',
] as const;

// ── Error Class ──────────────────────────────────────────────────────────────

/**
 * An error that carries agent-actionable suggestions alongside its message.
 *
 * Throw this from a skill/tool when you know what the agent should try next.
 * Its explicit suggestions are always used (passed through verbatim); anything
 * that is NOT an AgentHintError is classified heuristically by `buildAgentHint`.
 */
export class AgentHintError extends Error {
  readonly code: AgentHintCode;
  readonly suggestions: string[];

  constructor(message: string, suggestions?: string[], code: AgentHintCode = 'GENERIC') {
    super(message);
    this.name = 'AgentHintError';
    this.code = code;
    // Fall back to the category defaults when the caller omits suggestions.
    this.suggestions = suggestions && suggestions.length > 0 ? suggestions : DEFAULT_SUGGESTIONS[code];
    // Restore prototype chain for `instanceof` after transpilation to ES5-ish targets.
    Object.setPrototypeOf(this, AgentHintError.prototype);
  }
}

// ── Factory Helpers ──────────────────────────────────────────────────────────

/** A resource (test case / plan / module) could not be found. */
export function notFoundHint(message: string, suggestions?: string[]): AgentHintError {
  return new AgentHintError(message, suggestions, 'NOT_FOUND');
}

/** Input validation failed (missing required field, bad format, etc.). */
export function validationHint(message: string, suggestions?: string[]): AgentHintError {
  return new AgentHintError(message, suggestions, 'VALIDATION');
}

/** Authentication / authorization failed. */
export function authHint(message: string, suggestions?: string[]): AgentHintError {
  return new AgentHintError(message, suggestions, 'AUTH');
}

// ── Heuristic Mapping ─────────────────────────────────────────────────────────

/**
 * Classify an arbitrary error message into a hint category by keyword/status.
 * Mirrors the lucius fallback chain (not-found → auth → validation → generic).
 * GENERIC means "unrecognized" — on the enrichment path it yields no suggestions.
 */
function classifyMessage(message: string): AgentHintCode {
  const m = message.toLowerCase();
  if (m.includes('not found') || m.includes('404') || m.includes('does not exist')) {
    return 'NOT_FOUND';
  }
  if (m.includes('unauthor') || m.includes('forbidden') || m.includes('401') || m.includes('403')) {
    return 'AUTH';
  }
  if (m.includes('valid') || m.includes('required') || m.includes('400')) {
    return 'VALIDATION';
  }
  return 'GENERIC';
}

/**
 * Turn any caught error (or an error message string) into an Agent Hint.
 *
 * - An `AgentHintError` is passed through verbatim (its own suggestions win).
 * - Any other Error / value is classified by its message heuristically.
 *   CONSERVATIVE: an unrecognized message gets NO suggestions, so callers on the
 *   enrichment path leave it unchanged (only classifiable errors get decorated).
 *
 * Pure and total: never throws, always returns a hint.
 */
export function buildAgentHint(error: unknown): AgentHint {
  if (error instanceof AgentHintError) {
    return { message: error.message, suggestions: error.suggestions };
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = classifyMessage(message);
  return { message, suggestions: DEFAULT_SUGGESTIONS[code] };
}

// ── Enrichment Gate ─────────────────────────────────────────────────────────────

/**
 * Whether a failure message should be run through the hint enricher.
 *
 * Returns FALSE (skip) for empty messages, confirm-preview / write-guard
 * messages, messages that already carry actionable guidance, and terminal
 * aborts. Returns TRUE otherwise — the conservative `buildAgentHint` is the
 * second gate, so a "true" here still only decorates classifiable messages.
 */
export function shouldEnrichWithHint(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (SKIP_ENRICHMENT_MARKERS.some(marker => m.includes(marker))) return false;
  // Numbered enumerated hints (e.g. "(1) ...") are already guidance — skip.
  if (/\(\d+\)/.test(message)) return false;
  return true;
}

// ── Rendering ──────────────────────────────────────────────────────────────────

/**
 * Render a hint into a single LLM-friendly string: the message followed by a
 * bulleted "Suggestions:" list. With no suggestions the message is returned
 * UNCHANGED (no header) — so an unclassified failure passes through untouched.
 */
export function formatAgentHint(hint: AgentHint): string {
  if (hint.suggestions.length === 0) {
    return hint.message;
  }
  const lines = [hint.message, '', 'Suggestions:'];
  for (const suggestion of hint.suggestions) {
    lines.push(`- ${suggestion}`);
  }
  return lines.join('\n');
}
