import { logger } from '@/utils/logger';
import { ApiTestRequest, ApiTestResponse } from '@/types';
import { webSocketService } from '@/websocket/websocket.service';
import { ChatProcessingStepPayload } from '@/websocket/types';

const DEFAULT_TIMEOUT = 10000; // 10 seconds
const MAX_TIMEOUT = 30000; // 30 seconds max
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB max response size

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
 * Execute API test request
 * @param request - API test request parameters
 * @param chatSessionId - Optional chat session ID for WebSocket progress updates
 * @returns API test response
 */
export async function executeApiTest(
  request: ApiTestRequest,
  chatSessionId?: string
): Promise<ApiTestResponse> {
  const startTime = Date.now();

  // Helper to emit WebSocket progress
  const emitProgress = (step: ChatProcessingStepPayload['step'], message: string, progress: number) => {
    if (chatSessionId) {
      webSocketService.emitChatProcessingStep(chatSessionId, {
        sessionId: chatSessionId,
        step,
        message,
        progress,
        timestamp: new Date().toISOString(),
      });
    }
  };

  try {
    // Validate timeout
    const timeout = Math.min(
      request.timeout || DEFAULT_TIMEOUT,
      MAX_TIMEOUT
    );

    // Validate URL
    const urlValidation = validateUrl(request.url);
    if (!urlValidation.valid) {
      throw new Error(urlValidation.error || 'Invalid URL');
    }

    // Prepare request options
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

    // Add body for POST, PUT, PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(method) && request.body) {
      fetchOptions.body = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);
    }

    logger.info('Executing API test', {
      method,
      url: request.url,
      timeout,
      hasBody: !!request.body,
    });

    // Emit: Sending request
    emitProgress('executing_test', `📡 Sending ${method} request...`, 72);

    // Execute request
    const response = await fetch(request.url, fetchOptions);
    const durationMs = Date.now() - startTime;

    // Emit: Processing response
    emitProgress('executing_test', `📥 Processing response (${response.status})...`, 80);

    // Read response body (with size limit)
    let responseBody: any;
    const contentType = response.headers.get('content-type') || '';

    try {
      const text = await response.text();

      // Check size
      if (text.length > MAX_RESPONSE_SIZE) {
        responseBody = `[Response too large: ${text.length} bytes, truncated]`;
      } else if (contentType.includes('application/json')) {
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
      } else {
        responseBody = text.substring(0, 1000); // Limit text responses to 1KB
      }
    } catch (parseError) {
      logger.warn('Failed to parse response body', parseError);
      responseBody = '[Unable to parse response]';
    }

    // Convert headers to plain object
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Check if status matches expected
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

    logger.info('API test completed', {
      method,
      url: request.url,
      status: response.status,
      durationMs,
      matchesExpected,
    });

    // Emit: Completed
    emitProgress('executing_test', `✅ API test completed (${durationMs}ms)`, 90);

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;

    // Handle timeout
    const timeout = Math.min(request.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      logger.warn('API test timeout', { url: request.url, timeout });
      emitProgress('executing_test', `⏱️ Request timeout after ${timeout}ms`, 90);
      return {
        success: false,
        status: 0,
        durationMs,
        responseHeaders: {},
        responseBody: null,
        error: `Request timeout after ${timeout}ms`,
        matchesExpected: false,
      };
    }

    // Handle other errors
    logger.error('API test failed', { error, url: request.url });
    emitProgress('executing_test', `❌ API test failed: ${error.message}`, 90);
    return {
      success: false,
      status: 0,
      durationMs,
      responseHeaders: {},
      responseBody: null,
      error: error.message || 'Request failed',
      matchesExpected: false,
    };
  }
}
