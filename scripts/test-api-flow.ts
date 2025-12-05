#!/usr/bin/env ts-node
/**
 * API Testing Flow Script
 * Tests different API endpoints and shows detailed logs
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/test-api-flow.ts
 */

import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { ApiTestPlanService } from '@/services/testing/api/api-test-plan.service';
import { logger } from '@/utils/logger';

// Test scenarios
const TEST_SCENARIOS = [
  {
    name: 'GET Request - JSONPlaceholder Users',
    method: 'GET' as const,
    url: 'https://jsonplaceholder.typicode.com/users',
    expectedStatus: 200,
  },
  {
    name: 'GET Request - Single User',
    method: 'GET' as const,
    url: 'https://jsonplaceholder.typicode.com/users/1',
    expectedStatus: 200,
  },
  {
    name: 'POST Request - Create User',
    method: 'POST' as const,
    url: 'https://jsonplaceholder.typicode.com/users',
    body: {
      name: 'Test User',
      email: 'test@example.com',
      username: 'testuser',
    },
    headers: {
      'Content-Type': 'application/json',
    },
    expectedStatus: 201,
  },
  {
    name: 'PUT Request - Update User',
    method: 'PUT' as const,
    url: 'https://jsonplaceholder.typicode.com/users/1',
    body: {
      name: 'Updated User',
      email: 'updated@example.com',
    },
    headers: {
      'Content-Type': 'application/json',
    },
    expectedStatus: 200,
  },
  {
    name: 'DELETE Request - Delete User',
    method: 'DELETE' as const,
    url: 'https://jsonplaceholder.typicode.com/users/1',
    expectedStatus: 200,
  },
  {
    name: 'GET Request - 404 Not Found',
    method: 'GET' as const,
    url: 'https://jsonplaceholder.typicode.com/users/9999999',
    expectedStatus: 404,
  },
];

/**
 * Print separator
 */
function printSeparator(char: string = '=', length: number = 80) {
  console.log(char.repeat(length));
}

/**
 * Print test header
 */
function printTestHeader(testNum: number, totalTests: number, name: string) {
  printSeparator('=');
  console.log(`🧪 TEST ${testNum}/${totalTests}: ${name}`);
  printSeparator('=');
}

/**
 * Print test result
 */
function printTestResult(result: any, expected: number) {
  console.log('\n📊 РЕЗУЛЬТАТ:');
  console.log(`   ✓ Status: ${result.status} ${result.statusText}`);
  console.log(`   ✓ Duration: ${result.durationMs}ms`);
  console.log(`   ✓ Success: ${result.success ? '✅' : '❌'}`);
  console.log(`   ✓ Matches Expected: ${result.matchesExpected ? '✅' : '❌'} (expected ${expected})`);

  if (result.error) {
    console.log(`   ❌ Error: ${result.error}`);
  }

  if (result.responseBody) {
    const bodyStr = typeof result.responseBody === 'string'
      ? result.responseBody.substring(0, 200)
      : JSON.stringify(result.responseBody).substring(0, 200);
    console.log(`   ✓ Body: ${bodyStr}${bodyStr.length >= 200 ? '...' : ''}`);
  }
}

/**
 * Test API execution
 */
async function testApiExecution() {
  console.log('\n');
  printSeparator('█');
  console.log('🚀 API FLOW TESTING - executeApiTest()');
  printSeparator('█');
  console.log('\n');

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TEST_SCENARIOS.length; i++) {
    const scenario = TEST_SCENARIOS[i];

    printTestHeader(i + 1, TEST_SCENARIOS.length, scenario.name);

    console.log('\n📝 REQUEST:');
    console.log(`   Method: ${scenario.method}`);
    console.log(`   URL: ${scenario.url}`);
    if (scenario.headers) {
      console.log(`   Headers: ${JSON.stringify(scenario.headers)}`);
    }
    if (scenario.body) {
      console.log(`   Body: ${JSON.stringify(scenario.body)}`);
    }
    console.log(`   Expected Status: ${scenario.expectedStatus}`);

    try {
      console.log('\n⏳ Executing...\n');

      const result = await executeApiTest({
        method: scenario.method,
        url: scenario.url,
        body: scenario.body,
        headers: scenario.headers,
        expectedStatus: scenario.expectedStatus,
        timeout: 10000,
      });

      printTestResult(result, scenario.expectedStatus);

      // Check if test passed
      const testPassed = result.matchesExpected !== false && !result.error;

      if (testPassed) {
        console.log('\n✅ TEST PASSED\n');
        passed++;
      } else {
        console.log('\n❌ TEST FAILED\n');
        failed++;
      }

    } catch (error) {
      console.log('\n❌ EXCEPTION:');
      console.log(`   ${error instanceof Error ? error.message : String(error)}`);
      console.log('\n❌ TEST FAILED\n');
      failed++;
    }

    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Summary
  printSeparator('█');
  console.log('📈 SUMMARY');
  printSeparator('█');
  console.log(`Total Tests: ${TEST_SCENARIOS.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / TEST_SCENARIOS.length) * 100).toFixed(1)}%`);
  printSeparator('█');
}

/**
 * Test API Test Plan generation
 */
async function testApiTestPlanGeneration() {
  console.log('\n\n');
  printSeparator('█');
  console.log('🧠 API TEST PLAN GENERATION - ApiTestPlanService');
  printSeparator('█');
  console.log('\n');

  const testCase = {
    name: 'Generate Test Plan for GET Request',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users',
    userMessage: 'Test the users API endpoint',
  };

  printTestHeader(1, 1, testCase.name);

  console.log('\n📝 INPUT:');
  console.log(`   Method: ${testCase.method}`);
  console.log(`   URL: ${testCase.url}`);
  console.log(`   User Message: ${testCase.userMessage}`);

  try {
    console.log('\n⏳ Generating test plan with AI...\n');

    const plan = await ApiTestPlanService.generateApiTestPlan({
      method: testCase.method,
      url: testCase.url,
      userMessage: testCase.userMessage,
    });

    console.log('\n📊 GENERATED PLAN:');
    console.log(`   ✓ ID: ${plan.id}`);
    console.log(`   ✓ Summary: ${plan.summary}`);
    console.log(`   ✓ Method: ${plan.method}`);
    console.log(`   ✓ URL: ${plan.url}`);
    console.log(`   ✓ Expected Status: ${plan.expected_status}`);
    console.log(`   ✓ Estimated Duration: ${plan.estimated_duration}`);
    console.log(`   ✓ Validation Steps: ${plan.validation_steps.length} steps`);
    plan.validation_steps.forEach((step, i) => {
      console.log(`      ${i + 1}. ${step}`);
    });
    console.log(`   ✓ What Will Be Tested: ${plan.what_will_be_tested.length} items`);
    plan.what_will_be_tested.forEach((item, i) => {
      console.log(`      ${i + 1}. ${item}`);
    });
    console.log(`   ✓ Potential Issues: ${plan.potential_issues.length} issues`);
    plan.potential_issues.forEach((issue, i) => {
      console.log(`      ${i + 1}. ${issue}`);
    });

    console.log('\n📋 FORMATTED CONFIRMATION:');
    const formatted = ApiTestPlanService.formatApiTestPlanForConfirmation(plan);
    console.log(formatted);

    console.log('\n✅ TEST PLAN GENERATION PASSED\n');

  } catch (error) {
    console.log('\n❌ EXCEPTION:');
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    console.log('\n❌ TEST PLAN GENERATION FAILED\n');
  }
}

/**
 * Test error handling
 */
async function testErrorHandling() {
  console.log('\n\n');
  printSeparator('█');
  console.log('🛡️ ERROR HANDLING TESTS');
  printSeparator('█');
  console.log('\n');

  const errorScenarios = [
    {
      name: 'Invalid URL',
      method: 'GET' as const,
      url: 'not-a-valid-url',
    },
    {
      name: 'Localhost URL (Blocked)',
      method: 'GET' as const,
      url: 'http://localhost:3000/api',
    },
    {
      name: 'Timeout (Very long request)',
      method: 'GET' as const,
      url: 'https://httpstat.us/200?sleep=60000', // Sleep for 60 seconds
      timeout: 2000, // 2 second timeout
    },
    {
      name: 'DNS Error (Non-existent domain)',
      method: 'GET' as const,
      url: 'https://this-domain-definitely-does-not-exist-12345.com/api',
    },
  ];

  for (let i = 0; i < errorScenarios.length; i++) {
    const scenario = errorScenarios[i];

    printTestHeader(i + 1, errorScenarios.length, scenario.name);

    console.log('\n📝 REQUEST:');
    console.log(`   Method: ${scenario.method}`);
    console.log(`   URL: ${scenario.url}`);
    if (scenario.timeout) {
      console.log(`   Timeout: ${scenario.timeout}ms`);
    }

    try {
      console.log('\n⏳ Executing (expecting error)...\n');

      const result = await executeApiTest({
        method: scenario.method,
        url: scenario.url,
        timeout: scenario.timeout || 10000,
      });

      console.log('\n📊 RESULT:');
      console.log(`   ✓ Status: ${result.status}`);
      console.log(`   ✓ Success: ${result.success ? '✅' : '❌'}`);
      console.log(`   ✓ Error: ${result.error || 'None'}`);
      console.log(`   ✓ Duration: ${result.durationMs}ms`);

      console.log('\n✅ ERROR HANDLED CORRECTLY\n');

    } catch (error) {
      console.log('\n❌ UNEXPECTED EXCEPTION:');
      console.log(`   ${error instanceof Error ? error.message : String(error)}`);
      console.log('\n❌ ERROR NOT HANDLED\n');
    }

    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Main function
 */
async function main() {
  console.clear();

  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║            🧪 API TESTING FLOW - COMPREHENSIVE TESTS              ║
║                                                                   ║
║  This script tests the API testing functionality locally.        ║
║  Watch the logs to verify everything works correctly.            ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
  `);

  try {
    // Test 1: API Execution
    await testApiExecution();

    // Test 2: Test Plan Generation (requires OpenAI)
    console.log('\n\n⚠️  Next test requires OpenAI API key...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await testApiTestPlanGeneration();
    } catch (error) {
      console.log('⚠️  Skipping test plan generation (requires OpenAI)');
      logger.warn('Test plan generation skipped', { error });
    }

    // Test 3: Error Handling
    await testErrorHandling();

    console.log('\n\n');
    printSeparator('█');
    console.log('🎉 ALL TESTS COMPLETED!');
    printSeparator('█');
    console.log('\n');

  } catch (error) {
    console.error('\n\n❌ CRITICAL ERROR:');
    console.error(error);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
