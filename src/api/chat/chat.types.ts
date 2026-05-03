import { IntentResult } from '@/types';

export interface ChatAttachment {
  type: 'image' | 'document';
  name: string;
  mimeType: string;
  size: number;
  /** For images: base64 data URL (e.g. "data:image/png;base64,...") */
  base64?: string;
  /** For documents: extracted text content */
  extractedText?: string;
}

export interface ApiTestContext {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  assertions?: any[];
}

export interface ChatRequestContext {
  projectId?: string;
  action?: 'run_api_test' | string; // Explicit action keyword for fast path
  apiTest?: ApiTestContext; // API test data when action is 'run_api_test'
  // Editor mode fields (web)
  editorMode?: boolean; // Signals chat is from preview/editor
  previewSessionId?: string; // Active preview session ID
  pageContext?: {
    url?: string; // Current page URL in preview
    title?: string; // Page title
    domSummary?: string; // Compact DOM summary (~1500 tokens max)
    testSteps?: Array<{ id: string; type: string; description: string }>;
  };
  // Mobile editor mode fields — parallels the web editor block
  mobileEditorMode?: boolean; // Signals chat is from the mobile editor
  mobileSessionId?: string; // Active runner session ID on :4100
  [key: string]: any;
}

export interface ChatRequest {
  message: string;
  context?: string | ChatRequestContext; // For RAG integration with projectId and API test data
  sessionId?: string; // Optional: auto-resolved from workspace if not provided
  conversationId?: string; // For multi-turn conversations (questions/answers)
  answers?: Record<string, any>; // Answers to clarifying questions
  userId?: string; // Optional userId for testing/dev (when no auth token)
  mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
  executionStrategy?: 'standard' | 'exploration'; // Execution strategy (default: 'standard')
  /**
   * When present, scopes this chat to a test case. The controller resolves
   * (user_id, testCaseId) → a row in `test_case_chat_sessions`, lazily
   * creating it on the first user message. All persistence (history,
   * auto-title, future embeddings/summaries) goes to the per-test-case
   * tables — never the workspace-wide chat. When set, the `sessionId`
   * field is ignored — sessionId for test-case chats is owned by the
   * backend, not the client.
   */
  testCaseId?: string;
}

export interface ChatResponse {
  reply: string;
  timestamp: string; // Required: timestamp of AI reply
  userMessageTimestamp?: string; // Optional: timestamp when user message was saved
  parsedIntent?: IntentResult | null;
  needsMoreInfo?: boolean; // Autonomous mode: needs clarification
  questions?: any[]; // Clarifying questions
  conversationId?: string; // For tracking multi-turn conversations
  testPlan?: any; // Test plan awaiting confirmation
  activeProject?: { // Active project context (for frontend display)
    id: string;
    name: string;
  };
}

// Message with timestamp for display
export interface ChatMessageWithTimestamp {
  id: string;
  role: 'user' | 'ai';
  content: string;
  created_at: string;
  metadata?: any;
  author_id?: string; // Who sent this message (for shared workspace chat)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  userId?: string;
  message: string;
  context?: string | ChatRequestContext;
}
