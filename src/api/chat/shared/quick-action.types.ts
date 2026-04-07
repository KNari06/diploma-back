/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUICK ACTION TYPES — Universal in-chat action framework
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * QuickActions are interactive buttons attached to chat messages via metadata.
 * The frontend renders them automatically and dispatches clicks through a
 * single universal handler — backend just declares what actions are available.
 *
 * Supported action kinds:
 * - api       Direct backend HTTP call (must be in the endpoint whitelist)
 * - chat      Send a chat message on the user's behalf
 * - navigate  Frontend route change
 * - copy      Copy text to clipboard
 * - websocket Emit a WebSocket event
 *
 * Placeholder syntax:
 * - Params and url fields can contain "<resolved at click>" sentinel values.
 *   The frontend resolves these from a fixed runtime context dictionary
 *   (previewSessionId, chatSessionId, projectId, userId, messageId).
 * - Resolution dictionary keys are referenced via "<ctx:keyName>".
 *
 * Security:
 * - For kind=api, the endpoint string MUST exist in the backend whitelist
 *   registry. Frontend rejects unknown endpoints. This prevents an LLM from
 *   smuggling arbitrary HTTP calls through generated actions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Action visual variants — frontend maps these to button styles. */
export type QuickActionVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

/** Action behavior categories. */
export type QuickActionKind = 'api' | 'chat' | 'navigate' | 'copy' | 'websocket';

/**
 * Common fields shared by every quick action.
 * Use the discriminated union `QuickAction` below for type-safe handling.
 */
interface QuickActionBase {
  /** Unique within a single message — used for "oneShot" tracking and analytics. */
  id: string;
  /** Visible label rendered on the button. */
  label: string;
  /** Lucide icon name. Frontend resolves the actual SVG. */
  icon?: string;
  /** Visual variant hint. Defaults to 'secondary' when omitted. */
  variant?: QuickActionVariant;
  /** Disable the button after the first successful click. */
  oneShot?: boolean;
  /** Show a native confirm() dialog before executing. */
  confirmRequired?: boolean;
  /** Confirm dialog text. Required when confirmRequired is true. */
  confirmText?: string;
  /**
   * Toast message shown on success. Supports `{{path.to.value}}` interpolation
   * against the response body. Example: `Saved as "{{testCase.name}}"`.
   */
  successMessage?: string;
  /** Optional follow-up action chained after this one succeeds. */
  successAction?: QuickAction;
}

/**
 * kind=api — direct HTTP call to a whitelisted backend endpoint.
 * The endpoint string MUST match an entry in the backend whitelist registry
 * (src/api/preview/quick-action-endpoints.ts) or the frontend will refuse it.
 */
export interface QuickActionApi extends QuickActionBase {
  kind: 'api';
  /** Format: "METHOD /path" — e.g., "POST /api/preview/draft/save-as-test-case". */
  endpoint: string;
  /**
   * Request body. Values may be literal or contain placeholder sentinels:
   * - "<ctx:previewSessionId>"  → resolved from frontend runtime context
   * - "<ctx:chatSessionId>"     → resolved from frontend runtime context
   * - "<ctx:projectId>"         → resolved from frontend runtime context
   * - "<ctx:userId>"            → resolved from frontend runtime context
   * - "<ctx:messageId>"         → ID of the message this action belongs to
   */
  params?: Record<string, unknown>;
}

/**
 * kind=chat — inject a chat message on the user's behalf and send it.
 * Useful for "Run again", "Why did it fail?", "Show me the report" — anything
 * that the AI can handle through a normal conversational turn.
 */
export interface QuickActionChat extends QuickActionBase {
  kind: 'chat';
  /** Text injected into the chat input as if the user typed it. */
  prompt: string;
}

/** kind=navigate — frontend route change. */
export interface QuickActionNavigate extends QuickActionBase {
  kind: 'navigate';
  /** Target URL — supports `{{path.to.value}}` interpolation against message metadata. */
  url: string;
  /** If true, opens in a new tab via window.open instead of in-app routing. */
  openInNewTab?: boolean;
}

/** kind=copy — write text to the clipboard. */
export interface QuickActionCopy extends QuickActionBase {
  kind: 'copy';
  /** Text to copy. Supports `{{path.to.value}}` interpolation against metadata. */
  text: string;
}

/** kind=websocket — emit a WebSocket event with payload. */
export interface QuickActionWebsocket extends QuickActionBase {
  kind: 'websocket';
  /** Event name to emit. */
  event: string;
  /** Event payload — same placeholder syntax as QuickActionApi.params. */
  params?: Record<string, unknown>;
}

/** Discriminated union of all action kinds. */
export type QuickAction =
  | QuickActionApi
  | QuickActionChat
  | QuickActionNavigate
  | QuickActionCopy
  | QuickActionWebsocket;

/**
 * Type guard helpers — useful in handlers and tests.
 */
export const isApiAction = (a: QuickAction): a is QuickActionApi => a.kind === 'api';
export const isChatAction = (a: QuickAction): a is QuickActionChat => a.kind === 'chat';
export const isNavigateAction = (a: QuickAction): a is QuickActionNavigate => a.kind === 'navigate';
export const isCopyAction = (a: QuickAction): a is QuickActionCopy => a.kind === 'copy';
export const isWebsocketAction = (a: QuickAction): a is QuickActionWebsocket => a.kind === 'websocket';
