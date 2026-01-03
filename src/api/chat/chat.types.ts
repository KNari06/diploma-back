import { IntentResult } from '@/types';

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
  [key: string]: any;
}

export interface ChatRequest {
  message: string;
  context?: string | ChatRequestContext; // For RAG integration with projectId and API test data
  sessionId?: string; // Existing chat session ID
  conversationId?: string; // For multi-turn conversations (questions/answers)
  answers?: Record<string, any>; // Answers to clarifying questions
  userId?: string; // Optional userId for testing/dev (when no auth token)
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
}

export interface ChatResponse {
  reply: string;
  timestamp?: string;
  parsedIntent?: IntentResult | null;
  needsMoreInfo?: boolean; // Autonomous mode: needs clarification
  questions?: any[]; // Clarifying questions
  conversationId?: string; // For tracking multi-turn conversations
  testPlan?: any; // Test plan awaiting confirmation
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
