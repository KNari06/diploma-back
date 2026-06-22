/**
 * Spec parser — Python detection.
 * Ensures Python scripts are detected as 'python' while real specs are not
 * misclassified (no regression on JSON/YAML/cURL detection).
 */

import { SpecParserService, isPythonScript } from '../spec-parser.service';

describe('isPythonScript', () => {
  test('detects requests scripts', () => {
    expect(isPythonScript('import requests\nrequests.get("https://api.x/users")')).toBe(true);
  });

  test('detects httpx scripts', () => {
    expect(isPythonScript('import httpx\nr = httpx.post("https://api.x/login", json={})')).toBe(true);
  });

  test('detects aiohttp scripts', () => {
    expect(isPythonScript('import aiohttp\nasync with aiohttp.ClientSession() as s:\n  await s.get("https://x")')).toBe(true);
  });

  test('detects pytest test files', () => {
    expect(
      isPythonScript('import requests\n\ndef test_health():\n    r = requests.get("https://x/health")\n    assert r.status_code == 200'),
    ).toBe(true);
  });

  test('does NOT match an OpenAPI JSON spec', () => {
    expect(isPythonScript('{"openapi":"3.0.0","paths":{"/x":{}}}')).toBe(false);
  });

  test('does NOT match prose mentioning requests', () => {
    expect(isPythonScript('We get a lot of requests for this API endpoint.')).toBe(false);
  });
});

describe('SpecParserService.detectFormat — python', () => {
  test('.py extension wins', () => {
    expect(SpecParserService.detectFormat('whatever', 'client.py')).toBe('python');
  });

  test('requests content detected as python', () => {
    expect(SpecParserService.detectFormat('import requests\nrequests.get("https://x")')).toBe('python');
  });

  test('OpenAPI 3 JSON still detected as openapi_file (no regression)', () => {
    expect(SpecParserService.detectFormat('{"openapi":"3.0.1","info":{},"paths":{}}')).toBe('openapi_file');
  });

  test('cURL still detected as curl (no regression)', () => {
    expect(SpecParserService.detectFormat('curl https://api.x/users -H "Authorization: Bearer t"')).toBe('curl');
  });
});
