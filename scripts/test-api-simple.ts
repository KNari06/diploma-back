#!/usr/bin/env ts-node
/**
 * Simple API Test Script
 * Quick test of a single API endpoint with detailed logging
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts [URL] [METHOD]
 *
 * Examples:
 *   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts
 *   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts https://jsonplaceholder.typicode.com/users GET
 *   npx ts-node -r tsconfig-paths/register scripts/test-api-simple.ts https://jsonplaceholder.typicode.com/users POST
 */

import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { logger } from '@/utils/logger';

// Parse command line arguments
const args = process.argv.slice(2);
const url = args[0] || 'https://jsonplaceholder.typicode.com/users';
const method = (args[1]?.toUpperCase() || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// Request body for POST/PUT/PATCH
const requestBody = ['POST', 'PUT', 'PATCH'].includes(method) ? {
  name: 'Test User',
  email: 'test@example.com',
  username: 'testuser',
} : undefined;

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🧪 SIMPLE API TEST');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log('📝 REQUEST DETAILS:');
  console.log(`   Method:  ${method}`);
  console.log(`   URL:     ${url}`);
  if (requestBody) {
    console.log(`   Body:    ${JSON.stringify(requestBody, null, 2)}`);
  }
  console.log(`   Timeout: 10000ms\n`);

  console.log('⏳ Executing API test...\n');

  const startTime = Date.now();

  try {
    const result = await executeApiTest({
      method,
      url,
      body: requestBody,
      headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
      timeout: 10000,
    });

    const duration = Date.now() - startTime;

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('📊 RESULT');
    console.log('═══════════════════════════════════════════════════════════════════\n');

    console.log('✅ SUCCESS:', result.success);
    console.log('📡 STATUS:', result.status, result.statusText);
    console.log('⏱️  DURATION:', result.durationMs, 'ms');
    console.log('⏱️  TOTAL DURATION:', duration, 'ms (including overhead)');

    if (result.error) {
      console.log('❌ ERROR:', result.error);
    }

    console.log('\n📋 RESPONSE HEADERS:');
    Object.entries(result.responseHeaders).forEach(([key, value]) => {
      console.log(`   ${key}: ${value}`);
    });

    console.log('\n📦 RESPONSE BODY:');
    if (result.responseBody) {
      if (typeof result.responseBody === 'string') {
        console.log(result.responseBody.substring(0, 500));
        if (result.responseBody.length > 500) {
          console.log(`\n   ... (${result.responseBody.length - 500} more characters)`);
        }
      } else {
        console.log(JSON.stringify(result.responseBody, null, 2));
      }
    } else {
      console.log('   (empty)');
    }

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log(result.success ? '✅ TEST PASSED' : '❌ TEST FAILED');
    console.log('═══════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('❌ EXCEPTION');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    console.error(error);
    console.log('\n');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
