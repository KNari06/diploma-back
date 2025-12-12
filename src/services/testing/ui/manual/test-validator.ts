import { BrowserType, TestRunRequest, ValidationError } from '@/types';

/**
 * Validate test request
 */
export function validateTestRequest(testRequest: TestRunRequest): void {
  if (!testRequest.url) {
    throw new ValidationError('URL is required');
  }

  if (!testRequest.browsers || testRequest.browsers.length === 0) {
    throw new ValidationError('At least one browser is required');
  }

  if (!testRequest.projectId) {
    throw new ValidationError('Project ID is required');
  }

  // Validate URL format
  try {
    new URL(testRequest.url);
  } catch {
    throw new ValidationError('Invalid URL format');
  }

  // Validate browsers
  const validBrowsers: BrowserType[] = ['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari'];
  for (const browser of testRequest.browsers) {
    if (!validBrowsers.includes(browser)) {
      throw new ValidationError(`Invalid browser: ${browser}`);
    }
  }
}
