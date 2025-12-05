API TESTING SCRIPTS
===================

1. test-api-flow.ts
   Comprehensive testing of all API functionality
   
   Usage:
   npx ts-node -r tsconfig-paths/register scripts/test-api-flow.ts
   
   Tests:
   - GET, POST, PUT, DELETE requests
   - Status code validation
   - Response parsing
   - Error handling (invalid URL, localhost block, timeout, DNS)
   - Test plan generation (requires OpenAI)
   
   Output:
   - Detailed logs for each test
   - Summary with pass/fail statistics


2. test-api-simple.ts
   Quick test of a single API endpoint
   
   Usage:
   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts [URL] [METHOD]
   
   Examples:
   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts
   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts https://jsonplaceholder.typicode.com/users GET
   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts https://api.github.com/users/octocat GET
   
   Output:
   - Request details
   - Response status, headers, body
   - Execution time


WHAT TO WATCH:
==============

Console Output:
- ✅/❌ Test results
- Response times
- Error messages
- Summary statistics

Logs (logs/app.log):
- [API_TEST] Executing API test
- [API_TEST] Request completed
- [API_TEST] Test failed
- Detailed error information

Common Issues:
- Timeout errors (> 10s)
- DNS resolution failures
- Localhost blocking (security)
- Invalid URLs


TIPS:
=====

1. Watch both console AND logs/app.log for full picture
2. Use test-api-simple.ts for quick checks
3. Use test-api-flow.ts for comprehensive testing
4. Check response times (should be < 5s for most APIs)
5. Verify error handling works correctly

