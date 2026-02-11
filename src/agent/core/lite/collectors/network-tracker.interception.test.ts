/**
 * Tests for Network Request Interception (P1 Feature)
 * Validates full request/response body capture, error parsing, rate limit detection
 */

import { chromium, Page, Browser } from 'playwright';
import { NetworkTracker } from './network-tracker';
import type { NetworkValidationError } from '../lite-types';

describe('NetworkTracker - Request Interception (P1)', () => {
  let browser: Browser;
  let page: Page;
  let tracker: NetworkTracker;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    tracker = new NetworkTracker(page);
    tracker.setIteration(1);
  });

  afterEach(async () => {
    tracker.stopTracking();
    await page.close();
  });

  describe('Request Body Capture', () => {
    it('should capture POST request body (JSON)', async () => {
      await page.route('**/api/users', async (route) => {
        // Simulate validation error with request body captured
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Validation failed',
            errors: { email: 'Invalid email format' },
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/users', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'invalid-email', password: '123' })
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const error = errors[0];
      expect(error.requestBody).toBeDefined();
      expect(error.requestBody.email).toBe('invalid-email');
      expect(error.requestBody.password).toBe('123');
    });

    it('should capture PUT request body', async () => {
      await page.route('**/api/users/123', async (route) => {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Name is required',
          }),
        });
      });

      await page.setContent(`
        <button id="update">Update</button>
        <script>
          document.getElementById('update').addEventListener('click', async () => {
            await fetch('/api/users/123', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: '' })
            });
          });
        </script>
      `);

      await page.click('#update');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].requestBody).toEqual({ name: '' });
    });

    it('should capture PATCH request body', async () => {
      await page.route('**/api/profile', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Invalid bio' }),
        });
      });

      await page.setContent(`
        <button id="patch">Patch</button>
        <script>
          document.getElementById('patch').addEventListener('click', async () => {
            await fetch('/api/profile', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bio: 'x'.repeat(1000) })
            });
          });
        </script>
      `);

      await page.click('#patch');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].requestBody.bio).toBeDefined();
      expect(errors[0].requestBody.bio.length).toBe(1000);
    });
  });

  describe('Response Body Capture', () => {
    it('should capture full response body (JSON)', async () => {
      await page.route('**/api/submit', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Validation failed',
            errors: {
              email: ['Invalid format', 'Already exists'],
              password: ['Too short'],
            },
            code: 'VALIDATION_ERROR',
            timestamp: Date.now(),
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/submit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'test', password: '12' })
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const error = errors[0];
      expect(error.responseBody).toBeDefined();
      expect(error.responseBody.message).toBe('Validation failed');
      expect(error.responseBody.code).toBe('VALIDATION_ERROR');
      expect(error.responseBody.timestamp).toBeDefined();
    });

    it('should handle non-JSON response body', async () => {
      await page.route('**/api/legacy', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'text/plain',
          body: 'Bad Request: Invalid input',
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/legacy', { method: 'POST', body: 'data' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].responseBody).toBe('Bad Request: Invalid input');
    });
  });

  describe('Field-Level Error Parsing', () => {
    it('should parse object-based errors: { email: "invalid", password: "too short" }', async () => {
      await page.route('**/api/register', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Validation failed',
            errors: {
              email: 'Invalid email format',
              password: 'Password too short',
            },
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'bad', password: '123' })
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const fieldErrors = errors[0].fieldErrors;
      expect(fieldErrors).toBeDefined();
      expect(fieldErrors?.length).toBe(2);
      expect(fieldErrors?.find((e) => e.field === 'email')).toEqual({
        field: 'email',
        message: 'Invalid email format',
      });
      expect(fieldErrors?.find((e) => e.field === 'password')).toEqual({
        field: 'password',
        message: 'Password too short',
      });
    });

    it('should parse Laravel/Rails format: { email: ["invalid", "required"] }', async () => {
      await page.route('**/api/validate', async (route) => {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'The given data was invalid',
            errors: {
              email: ['The email field is required.', 'The email must be a valid email address.'],
              name: ['The name field is required.'],
            },
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const fieldErrors = errors[0].fieldErrors;
      expect(fieldErrors).toBeDefined();
      expect(fieldErrors?.length).toBe(3); // 2 for email, 1 for name

      const emailErrors = fieldErrors?.filter((e) => e.field === 'email');
      expect(emailErrors?.length).toBe(2);
      expect(emailErrors?.[0].message).toBe('The email field is required.');
      expect(emailErrors?.[1].message).toBe('The email must be a valid email address.');
    });

    it('should parse array-based format: [{ field: "email", message: "invalid" }]', async () => {
      await page.route('**/api/check', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Validation errors',
            errors: [
              { field: 'email', message: 'Invalid email' },
              { field: 'password', message: 'Too weak' },
            ],
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/check', { method: 'POST', body: '{}' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const fieldErrors = errors[0].fieldErrors;
      expect(fieldErrors).toBeDefined();
      expect(fieldErrors?.length).toBe(2);
      expect(fieldErrors).toEqual([
        { field: 'email', message: 'Invalid email' },
        { field: 'password', message: 'Too weak' },
      ]);
    });
  });

  describe('Rate Limit Detection', () => {
    it('should detect retry-after header', async () => {
      await page.route('**/api/rate-limited', async (route) => {
        await route.fulfill({
          status: 429,
          headers: {
            'retry-after': '60',
          },
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Too many requests' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/rate-limited', { method: 'POST' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const rateLimitInfo = errors[0].rateLimitInfo;
      expect(rateLimitInfo).toBeDefined();
      expect(rateLimitInfo?.retryAfter).toBe(60);
    });

    it('should detect x-ratelimit-* headers', async () => {
      await page.route('**/api/limited', async (route) => {
        await route.fulfill({
          status: 429,
          headers: {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1234567890',
          },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Rate limit exceeded' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/limited', { method: 'POST' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const rateLimitInfo = errors[0].rateLimitInfo;
      expect(rateLimitInfo).toBeDefined();
      expect(rateLimitInfo?.limit).toBe(100);
      expect(rateLimitInfo?.remaining).toBe(0);
      expect(rateLimitInfo?.reset).toBe(1234567890);
    });

    it('should detect ratelimit-* headers (without x- prefix)', async () => {
      await page.route('**/api/throttled', async (route) => {
        await route.fulfill({
          status: 429,
          headers: {
            'ratelimit-limit': '50',
            'ratelimit-remaining': '5',
          },
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Throttled' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/throttled', { method: 'POST' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const rateLimitInfo = errors[0].rateLimitInfo;
      expect(rateLimitInfo).toBeDefined();
      expect(rateLimitInfo?.limit).toBe(50);
      expect(rateLimitInfo?.remaining).toBe(5);
    });
  });

  describe('Authentication Error Detection', () => {
    it('should detect token_expired hint', async () => {
      await page.route('**/api/protected', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Token expired',
            code: 'TOKEN_EXPIRED',
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/protected', { method: 'GET' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].authErrorHint).toBe('token_expired');
    });

    it('should detect invalid_credentials hint', async () => {
      await page.route('**/api/login', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Invalid credentials',
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/login', {
              method: 'POST',
              body: JSON.stringify({ username: 'test', password: 'wrong' })
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].authErrorHint).toBe('invalid_credentials');
    });

    it('should detect error code-based hints', async () => {
      await page.route('**/api/resource', async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error_code: 'FORBIDDEN_RESOURCE',
            message: 'Access denied',
          }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/resource', { method: 'GET' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].authErrorHint).toBe('FORBIDDEN_RESOURCE');
    });

    it('should not detect auth hint for non-auth errors', async () => {
      await page.route('**/api/validate', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Invalid input' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/validate', { method: 'POST', body: '{}' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].authErrorHint).toBeUndefined();
    });
  });

  describe('Analytics Filtering', () => {
    it('should not capture validation errors for analytics domains', async () => {
      await page.route('**/google-analytics.com/collect', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Invalid event' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('https://google-analytics.com/collect', {
              method: 'POST',
              body: 'event=pageview'
            });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      // Should be filtered out
      const analyticsErrors = errors.filter((e) => e.url.includes('google-analytics.com'));
      expect(analyticsErrors.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing request body gracefully', async () => {
      await page.route('**/api/get-error', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Bad request' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/get-error', { method: 'GET' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].requestBody).toBeNull();
    });

    it('should handle empty response body', async () => {
      await page.route('**/api/empty', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: '',
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/empty', { method: 'POST', body: '{}' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].responseBody).toBe('');
    });

    it('should handle malformed JSON gracefully', async () => {
      await page.route('**/api/malformed', async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: '{invalid json',
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/malformed', { method: 'POST', body: '{}' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].responseBody).toBe('{invalid json');
    });
  });

  describe('Headers Capture', () => {
    it('should capture all response headers', async () => {
      await page.route('**/api/headers', async (route) => {
        await route.fulfill({
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'abc123',
            'x-custom-header': 'test-value',
          },
          body: JSON.stringify({ error: 'Test' }),
        });
      });

      await page.setContent(`
        <button id="submit">Submit</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            await fetch('/api/headers', { method: 'POST', body: '{}' });
          });
        </script>
      `);

      await page.click('#submit');
      await page.waitForTimeout(500);

      const errors = tracker.getValidationErrorsSince(0);
      expect(errors.length).toBeGreaterThan(0);

      const headers = errors[0].headers;
      expect(headers).toBeDefined();
      expect(headers?.['content-type']).toBe('application/json');
      expect(headers?.['x-request-id']).toBe('abc123');
      expect(headers?.['x-custom-header']).toBe('test-value');
    });
  });
});
