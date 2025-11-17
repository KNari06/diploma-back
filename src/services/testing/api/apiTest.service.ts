import { ApiTestRequest, ApiTestResponse } from '@/types';
import { logger } from '@/utils/logger';
import { ChatProcessingStepPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';

// FIX #3: Centralized constants
const DEFAULT_TIMEOUT = 10000; // 10 seconds
const MAX_TIMEOUT = 30000; // 30 seconds max
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB max response size
const MAX_TEXT_PREVIEW = 1000; // 1KB for text responses

// WebSocket progress steps
const PROGRESS = {
  VALIDATING: 40,
  PREPARING: 50,
  SENDING: 60,
  RECEIVED: 65,
  ANALYZING: 90,
  COMPLETE: 100,
} as const;

/**
 * Validate URL - check if it's allowed
 * @param url - URL to validate
 * @returns true if URL is valid and allowed
 */
function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsedUrl = new URL(url);

    // Only allow http and https
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
    }

    // Block private/internal IPs for security
    const hostname = parsedUrl.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.') ||
      hostname === '::1'
    ) {
      return { valid: false, error: 'Local/internal IPs are not allowed for security reasons' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Sanitize headers - remove sensitive headers
 * @param headers - Headers to sanitize
 * @returns Sanitized headers
 */
function sanitizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const sensitiveHeaders = ['cookie', 'authorization', 'x-api-key', 'x-auth-token'];
  const sanitized: Record<string, string> = { ...headers };

  // Remove sensitive headers (keep them for the request but don't log)
  sensitiveHeaders.forEach(header => {
    if (sanitized[header.toLowerCase()]) {
      delete sanitized[header.toLowerCase()];
    }
  });

  return sanitized;
}

/**
 * FIX #6: Centralized WebSocket progress helper
 */
function emitApiTestProgress(
  chatSessionId: string | undefined,
  step: ChatProcessingStepPayload['step'],
  message: string,
  progress: number
): void {
  if (!chatSessionId) {
    logger.debug('[API_TEST] No chatSessionId, skipping WebSocket emit');
    return;
  }

  webSocketService.emitChatProcessingStep(chatSessionId, {
    sessionId: chatSessionId,
    step,
    message,
    progress,
    timestamp: new Date().toISOString(),
  });
}

/**
 * FIX #2: Extract response body parsing logic
 */
async function parseResponseBody(
  response: Response
): Promise<{ body: any; error?: string }> {
  try {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    // Check size
    if (text.length > MAX_RESPONSE_SIZE) {
      return {
        body: `[Response too large: ${text.length} bytes, truncated]`,
      };
    }

    // Try to parse as JSON
    if (contentType.includes('application/json')) {
      try {
        return { body: JSON.parse(text) };
      } catch {
        // Not valid JSON, return as text
        return { body: text };
      }
    }

    // For non-JSON, limit preview
    if (text.length > MAX_TEXT_PREVIEW) {
      return { body: text.substring(0, MAX_TEXT_PREVIEW) + '... [truncated]' };
    }

    return { body: text };
  } catch (error) {
    logger.warn('[API_TEST] Failed to parse response body', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      body: '[Unable to parse response]',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * FIX #5: Categorize error types
 */
function categorizeError(error: any): {
  type: 'timeout' | 'network' | 'dns' | 'ssl' | 'unknown';
  message: string;
} {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return {
      type: 'timeout',
      message: `Request timeout`,
    };
  }

  if (error.code === 'ENOTFOUND' || error.message?.includes('getaddrinfo')) {
    return {
      type: 'dns',
      message: 'DNS resolution failed - hostname not found',
    };
  }

  if (error.code === 'ECONNREFUSED') {
    return {
      type: 'network',
      message: 'Connection refused - server may be down',
    };
  }

  if (error.message?.includes('SSL') || error.message?.includes('certificate')) {
    return {
      type: 'ssl',
      message: 'SSL/TLS certificate error',
    };
  }

  return {
    type: 'unknown',
    message: error.message || 'Request failed',
  };
}

/**
 * Execute API test request (REFACTORED)
 * @param request - API test request parameters
 * @param chatSessionId - Optional chat session ID for WebSocket progress updates
 * @returns API test response
 */
export async function executeApiTest(
  request: ApiTestRequest,
  chatSessionId?: string
): Promise<ApiTestResponse> {
  const startTime = Date.now();

  logger.info('[API_TEST] Executing API test', {
    method: request.method,
    url: request.url,
    hasChatSession: !!chatSessionId,
  });

  try {
    // STEP 1: Validate request
    emitApiTestProgress(chatSessionId, 'executing_test', '🔍 Validating request...', PROGRESS.VALIDATING);

    const timeout = Math.min(request.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const urlValidation = validateUrl(request.url);

    if (!urlValidation.valid) {
      throw new Error(urlValidation.error || 'Invalid URL');
    }

    // STEP 2: Prepare request
    emitApiTestProgress(
      chatSessionId,
      'executing_test',
      `📦 Building ${request.method.toUpperCase()} request...`,
      PROGRESS.PREPARING
    );

    const method = request.method.toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'QAIT-Backend/1.0',
      ...request.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeout),
    };

    // Add body for POST, PUT, PATCH
    if (['POST', 'PUT', 'PATCH'].includes(method) && request.body) {
      fetchOptions.body = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);
    }

    // STEP 3: Execute request
    emitApiTestProgress(
      chatSessionId,
      'executing_test',
      `📡 Sending ${method} request to ${new URL(request.url).hostname}...`,
      PROGRESS.SENDING
    );

    const response = await fetch(request.url, fetchOptions);
    const durationMs = Date.now() - startTime;

    logger.info('[API_TEST] Request completed', {
      status: response.status,
      statusText: response.statusText,
      durationMs,
    });

    // STEP 4: Parse response
    emitApiTestProgress(
      chatSessionId,
      'executing_test',
      `📥 Response received: ${response.status} ${response.statusText}`,
      PROGRESS.RECEIVED
    );

    const { body: responseBody } = await parseResponseBody(response);

    // STEP 5: Build response
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const matchesExpected = request.expectedStatus
      ? response.status === request.expectedStatus
      : undefined;

    const result: ApiTestResponse = {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      responseHeaders: sanitizeHeaders(responseHeaders),
      responseBody,
      matchesExpected,
    };

    // STEP 6: Emit completion
    emitApiTestProgress(
      chatSessionId,
      'analyzing_results',
      `🔍 Validating response...`,
      PROGRESS.ANALYZING
    );

    emitApiTestProgress(
      chatSessionId,
      'analyzing_results',
      `✅ Test completed! Status: ${response.status} | Duration: ${durationMs}ms`,
      PROGRESS.COMPLETE
    );

    logger.info('[API_TEST] Test completed successfully', {
      status: response.status,
      durationMs,
      matchesExpected,
    });

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const timeout = Math.min(request.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // FIX #5: Categorize error for better debugging
    const errorInfo = categorizeError(error);

    logger.error('[API_TEST] Test failed', {
      url: request.url,
      errorType: errorInfo.type,
      errorMessage: errorInfo.message,
      durationMs,
    });

    // Emit error with detailed message
    const errorMessage = errorInfo.type === 'timeout'
      ? `⏱️ Request timeout after ${timeout}ms`
      : `❌ ${errorInfo.message}`;

    emitApiTestProgress(chatSessionId, 'analyzing_results', errorMessage, PROGRESS.COMPLETE);

    return {
      success: false,
      status: 0,
      durationMs,
      responseHeaders: {},
      responseBody: null,
      error: errorInfo.type === 'timeout'
        ? `Request timeout after ${timeout}ms`
        : errorInfo.message,
      matchesExpected: false,
    };
  }
}
