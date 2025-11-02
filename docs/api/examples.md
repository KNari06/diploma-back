# 📚 QAI Backend API Examples

## Base URL
```
http://localhost:3000/api/v1
```

## Authentication
Currently, the API uses a simple header-based authentication. In production, this would be replaced with JWT tokens.

```bash
# Add user ID header to requests
-H "X-User-ID: your-user-id"
```

## 🧪 Test Management

### 1. Create and Run a Test

```bash
curl -X POST http://localhost:3000/api/v1/tests/run \
  -H "Content-Type: application/json" \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome", "firefox"],
    "projectId": "00000000-0000-0000-0000-000000000001",
    "options": {
      "mobile": false,
      "viewport": {
        "width": 1920,
        "height": 1080
      },
      "timeout": 30000,
      "retries": 2,
      "waitForSelector": ".main-content",
      "headers": {
        "User-Agent": "QAI Test Bot"
      }
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid-here",
    "url": "https://example.com",
    "project_id": "00000000-0000-0000-0000-000000000001",
    "user_id": "00000000-0000-0000-0000-000000000002",
    "status": "pending",
    "browsers": ["chrome", "firefox"],
    "options": { ... },
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z"
  },
  "message": "Test created successfully",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 2. Get Test Details

```bash
curl -X GET http://localhost:3000/api/v1/tests/test-uuid-here \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid-here",
    "url": "https://example.com",
    "status": "running",
    "browsers": ["chrome", "firefox"],
    "results": [
      {
        "id": "result-uuid-1",
        "browser": "chrome",
        "status": "completed",
        "ai_summary": {
          "summary": "Test completed successfully with 2 minor issues found",
          "bugs": [...],
          "recommendations": [...],
          "severity": "low",
          "confidence": 85
        }
      }
    ],
    "created_at": "2024-01-01T00:00:00.000Z"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 3. Get Test Results

```bash
curl -X GET http://localhost:3000/api/v1/tests/test-uuid-here/result \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "result-uuid-1",
      "test_id": "test-uuid-here",
      "browser": "chrome",
      "status": "completed",
      "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
      "dom": "<html><head>...</head><body>...</body></html>",
      "logs": [
        "Console log message 1",
        "Console log message 2"
      ],
      "network_logs": [
        {
          "url": "https://example.com/api/data",
          "method": "GET",
          "status": 200,
          "responseTime": 150
        }
      ],
      "errors": [],
      "performance": {
        "loadTime": 1200,
        "firstContentfulPaint": 800
      },
      "ai_summary": {
        "summary": "Test completed with minor issues",
        "bugs": [
          {
            "id": "bug-1",
            "title": "Slow loading time",
            "description": "Page takes longer than expected to load",
            "severity": "medium",
            "category": "performance"
          }
        ],
        "recommendations": [
          "Optimize images",
          "Minify CSS and JavaScript"
        ],
        "severity": "low",
        "confidence": 85
      },
      "created_at": "2024-01-01T00:00:00.000Z",
      "completed_at": "2024-01-01T00:02:00.000Z"
    }
  ],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 4. Get Test Status (Lightweight)

```bash
curl -X GET http://localhost:3000/api/v1/tests/test-uuid-here/status \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid-here",
    "status": "running",
    "progress": 1,
    "totalBrowsers": 2
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 5. Get Test Summary

```bash
curl -X GET http://localhost:3000/api/v1/tests/test-uuid-here/summary \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "test": {
      "id": "test-uuid-here",
      "url": "https://example.com",
      "status": "completed",
      "browsers": ["chrome", "firefox"],
      "createdAt": "2024-01-01T00:00:00.000Z",
      "completedAt": "2024-01-01T00:05:00.000Z"
    },
    "results": [
      {
        "id": "result-uuid-1",
        "browser": "chrome",
        "status": "completed",
        "bugsCount": 2,
        "severity": "low",
        "confidence": 85,
        "completedAt": "2024-01-01T00:02:00.000Z"
      },
      {
        "id": "result-uuid-2",
        "browser": "firefox",
        "status": "completed",
        "bugsCount": 1,
        "severity": "medium",
        "confidence": 90,
        "completedAt": "2024-01-01T00:03:00.000Z"
      }
    ],
    "overallStats": {
      "totalBrowsers": 2,
      "completedBrowsers": 2,
      "failedBrowsers": 0,
      "totalBugs": 3,
      "criticalBugs": 0
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 6. Cancel a Test

```bash
curl -X POST http://localhost:3000/api/v1/tests/test-uuid-here/cancel \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid-here",
    "status": "cancelled",
    "completed_at": "2024-01-01T00:01:00.000Z"
  },
  "message": "Test cancelled successfully",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 7. Retry a Failed Test

```bash
curl -X POST http://localhost:3000/api/v1/tests/test-uuid-here/retry \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid-here",
    "status": "pending"
  },
  "message": "Test retry initiated successfully",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 📊 Project Management

### 1. Get Tests by Project

```bash
curl -X GET "http://localhost:3000/api/v1/tests/project/00000000-0000-0000-0000-000000000001?page=1&limit=10" \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "test-uuid-1",
      "url": "https://example.com",
      "status": "completed",
      "browsers": ["chrome"],
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "totalPages": 3
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 2. Get Project Statistics

```bash
curl -X GET http://localhost:3000/api/v1/tests/project/00000000-0000-0000-0000-000000000001/stats \
  -H "X-User-ID: 00000000-0000-0000-0000-000000000002"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total_tests": 25,
    "completed_tests": 20,
    "failed_tests": 3,
    "pending_tests": 1,
    "running_tests": 1,
    "last_test_at": "2024-01-01T00:00:00.000Z"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 🔧 Agent Integration

### Receive Test Result from Agent

```bash
curl -X POST http://localhost:3000/api/v1/tests/result \
  -H "Content-Type: application/json" \
  -d '{
    "testId": "test-uuid-here",
    "browser": "chrome",
    "status": "completed",
    "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
    "dom": "<html><head>...</head><body>...</body></html>",
    "logs": [
      "Console log message 1",
      "Console log message 2"
    ],
    "networkLogs": [
      {
        "url": "https://example.com/api/data",
        "method": "GET",
        "status": 200,
        "responseTime": 150,
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ],
    "errors": [
      {
        "type": "javascript",
        "message": "ReferenceError: undefined is not defined",
        "stack": "at line 42 in script.js",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ],
    "performance": {
      "loadTime": 1200,
      "firstContentfulPaint": 800,
      "largestContentfulPaint": 1000
    }
  }'
```

## 🏥 Health Check

### System Health

```bash
curl -X GET http://localhost:3000/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "services": {
    "database": "healthy",
    "queue": "healthy"
  },
  "version": "1.0.0",
  "environment": "development"
}
```

## ❌ Error Responses

### Validation Error

```json
{
  "success": false,
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "field": "url",
      "message": "Invalid URL format"
    }
  ],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Not Found Error

```json
{
  "success": false,
  "error": "Test with id test-uuid-here not found",
  "code": "NOT_FOUND",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Rate Limit Error

```json
{
  "success": false,
  "error": "Too many requests, please try again later",
  "code": "RATE_LIMIT_EXCEEDED",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 🚀 JavaScript/Node.js Examples

### Using Fetch API

```javascript
// Create a test
const createTest = async (testData) => {
  const response = await fetch('http://localhost:3000/api/v1/tests/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-ID': 'your-user-id'
    },
    body: JSON.stringify(testData)
  });

  return await response.json();
};

// Get test status
const getTestStatus = async (testId) => {
  const response = await fetch(`http://localhost:3000/api/v1/tests/${testId}/status`, {
    headers: {
      'X-User-ID': 'your-user-id'
    }
  });

  return await response.json();
};

// Usage
const testData = {
  url: 'https://example.com',
  browsers: ['chrome', 'firefox'],
  projectId: 'your-project-id'
};

createTest(testData).then(result => {
  console.log('Test created:', result);

  // Poll for status
  const pollStatus = setInterval(async () => {
    const status = await getTestStatus(result.data.id);
    console.log('Status:', status.data.status);

    if (status.data.status === 'completed' || status.data.status === 'failed') {
      clearInterval(pollStatus);
    }
  }, 5000);
});
```

### Using Axios

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api/v1',
  headers: {
    'X-User-ID': 'your-user-id'
  }
});

// Create test
const createTest = async (testData) => {
  try {
    const response = await api.post('/tests/run', testData);
    return response.data;
  } catch (error) {
    console.error('Error creating test:', error.response.data);
    throw error;
  }
};

// Get test results
const getTestResults = async (testId) => {
  try {
    const response = await api.get(`/tests/${testId}/result`);
    return response.data;
  } catch (error) {
    console.error('Error getting test results:', error.response.data);
    throw error;
  }
};
```

## 🐍 Python Examples

```python
import requests
import time

class QAIClient:
    def __init__(self, base_url, user_id):
        self.base_url = base_url
        self.headers = {
            'Content-Type': 'application/json',
            'X-User-ID': user_id
        }

    def create_test(self, test_data):
        response = requests.post(
            f"{self.base_url}/api/v1/tests/run",
            json=test_data,
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

    def get_test_status(self, test_id):
        response = requests.get(
            f"{self.base_url}/api/v1/tests/{test_id}/status",
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

    def wait_for_completion(self, test_id, timeout=300):
        start_time = time.time()
        while time.time() - start_time < timeout:
            status = self.get_test_status(test_id)
            if status['data']['status'] in ['completed', 'failed']:
                return status
            time.sleep(5)
        raise TimeoutError("Test did not complete within timeout")

# Usage
client = QAIClient('http://localhost:3000', 'your-user-id')

test_data = {
    'url': 'https://example.com',
    'browsers': ['chrome', 'firefox'],
    'projectId': 'your-project-id'
}

result = client.create_test(test_data)
print(f"Test created: {result['data']['id']}")

# Wait for completion
final_status = client.wait_for_completion(result['data']['id'])
print(f"Test completed with status: {final_status['data']['status']}")
```

## 🎭 Playwright Trace Upload

### 1. Upload Trace from cURL

```bash
curl -X POST http://localhost:3000/api/v1/playwright/upload-trace \
  -F "trace=@trace.zip" \
  -F "userId=user_123" \
  -F "testId=test_456" \
  -F "browser=chrome"
```

**Response:**
```json
{
  "success": true,
  "message": "Trace file uploaded successfully",
  "data": {
    "fileName": "trace_1730545200000_user_123_test_456_chrome.zip",
    "filePath": "/uploads/traces/trace_1730545200000_user_123_test_456_chrome.zip",
    "fileSize": 1024000,
    "uploadedAt": "2024-11-02T10:00:00.000Z",
    "testId": "test_456",
    "userId": "user_123"
  }
}
```

### 2. Upload from Node.js

```javascript
import FormData from 'form-data';
import fs from 'fs';

const uploadTrace = async (tracePath, userId, testId, browser) => {
  const form = new FormData();
  form.append('trace', fs.createReadStream(tracePath));
  form.append('userId', userId);
  form.append('testId', testId);
  form.append('browser', browser);

  const response = await fetch('http://localhost:3000/api/v1/playwright/upload-trace', {
    method: 'POST',
    body: form,
  });

  return await response.json();
};

// Usage
const result = await uploadTrace(
  './trace.zip',
  'user_123',
  'test_456',
  'chrome'
);
console.log('Uploaded:', result.data.fileName);
```

### 3. Integration with Playwright Test

```javascript
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    trace: 'on-first-retry',
  },
  reporter: [
    ['html'],
    ['./custom-trace-reporter.js']
  ],
});
```

```javascript
// custom-trace-reporter.js
import { Reporter } from '@playwright/test/reporter';
import FormData from 'form-data';
import fs from 'fs';

class TraceUploadReporter {
  async onTestEnd(test, result) {
    if (result.status === 'failed' && result.attachments) {
      const traceAttachment = result.attachments.find(a => a.name === 'trace');

      if (traceAttachment?.path) {
        await this.uploadTrace(traceAttachment.path, test);
      }
    }
  }

  async uploadTrace(tracePath, test) {
    const form = new FormData();
    form.append('trace', fs.createReadStream(tracePath));
    form.append('userId', process.env.QAI_USER_ID || 'default_user');
    form.append('testId', test.id);
    form.append('browser', test.project.name);

    try {
      const response = await fetch('http://localhost:3000/api/v1/playwright/upload-trace', {
        method: 'POST',
        body: form,
      });

      const result = await response.json();
      console.log('✅ Trace uploaded:', result.data?.fileName);
    } catch (error) {
      console.error('❌ Failed to upload trace:', error.message);
    }
  }
}

export default TraceUploadReporter;
```

### 4. Download Trace File

```bash
curl -O http://localhost:3000/api/v1/playwright/trace/trace_1730545200000_user_123_test_456_chrome.zip
```

### 5. List Traces for a Test

```bash
curl http://localhost:3000/api/v1/playwright/traces/test_456
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "fileName": "trace_1730545200000_user_123_test_456_chrome.zip",
      "fileSize": 1024000,
      "uploadedAt": "2024-11-02T10:00:00.000Z"
    },
    {
      "fileName": "trace_1730545201000_user_123_test_456_firefox.zip",
      "fileSize": 1048576,
      "uploadedAt": "2024-11-02T10:01:00.000Z"
    }
  ],
  "message": "Found 2 trace file(s)"
}
```

### 6. Python Example

```python
import requests

def upload_trace(trace_path, user_id, test_id, browser):
    with open(trace_path, 'rb') as f:
        files = {'trace': f}
        data = {
            'userId': user_id,
            'testId': test_id,
            'browser': browser
        }

        response = requests.post(
            'http://localhost:3000/api/v1/playwright/upload-trace',
            files=files,
            data=data
        )

        return response.json()

# Usage
result = upload_trace(
    'trace.zip',
    'user_123',
    'test_456',
    'chrome'
)
print(f"Uploaded: {result['data']['fileName']}")
```

### 7. Get User's Trace Files

```bash
# Get all traces for a user
curl "http://localhost:3000/api/v1/playwright/trace-files?userId=user_123"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "fileName": "trace_user_123_test_test456_2025-11-02.zip",
      "testId": "test456",
      "uploadedAt": "2025-11-02T15:22:10Z",
      "size": 5482112,
      "status": "parsed",
      "browser": "chrome"
    }
  ],
  "count": 1,
  "message": "Found 1 trace file(s)"
}
```

**JavaScript Example:**
```javascript
const getTraceFiles = async (userId) => {
  const response = await fetch(
    `http://localhost:3000/api/v1/playwright/trace-files?userId=${userId}`
  );
  return await response.json();
};

// Usage
const files = await getTraceFiles('user_123');
console.log(`Found ${files.count} trace files`);
files.data.forEach(file => {
  console.log(`- ${file.fileName} (${file.status})`);
});
```

### 8. Parse Trace and Get Steps

```bash
# Get parsed test steps
curl "http://localhost:3000/api/v1/playwright/trace/test_456/steps"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "testId": "test_456",
    "userId": "user_123",
    "fileName": "trace_user_123_test_test456_2025-11-02.zip",
    "totalSteps": 4,
    "steps": [
      {
        "stepId": 1,
        "type": "goto",
        "url": "https://app.qai.ai/login",
        "timestamp": 1667312123123,
        "description": "Navigate to https://app.qai.ai/login"
      },
      {
        "stepId": 2,
        "type": "fill",
        "selector": "input#email",
        "text": "test@example.com",
        "description": "Fill \"test@example.com\" into input#email"
      },
      {
        "stepId": 3,
        "type": "click",
        "selector": "button#submit",
        "description": "Click on button#submit"
      }
    ],
    "parsedAt": "2025-11-02T15:25:00.000Z"
  }
}
```

**JavaScript Example:**
```javascript
const getTestSteps = async (testId) => {
  const response = await fetch(
    `http://localhost:3000/api/v1/playwright/trace/${testId}/steps`
  );
  return await response.json();
};

// Usage for visualization
const { data } = await getTestSteps('test_456');
console.log(`Test has ${data.totalSteps} steps:`);

data.steps.forEach(step => {
  console.log(`${step.stepId}. ${step.description}`);
});

// Build flow diagram
const flowNodes = data.steps.map(step => ({
  id: step.stepId,
  type: step.type,
  label: step.description,
  data: step
}));
```

**React Component Example:**
```javascript
import { useEffect, useState } from 'react';

function TraceVisualization({ testId }) {
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/playwright/trace/${testId}/steps`)
      .then(res => res.json())
      .then(data => {
        setSteps(data.data.steps);
        setLoading(false);
      });
  }, [testId]);

  if (loading) return <div>Loading trace...</div>;

  return (
    <div className="trace-flow">
      {steps.map(step => (
        <div key={step.stepId} className="step-card">
          <span className="step-number">{step.stepId}</span>
          <span className="step-type">{step.type}</span>
          <p className="step-description">{step.description}</p>
          {step.selector && (
            <code className="step-selector">{step.selector}</code>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

**Need more examples?** Check the [Playwright API Documentation](./playwright.md) for detailed documentation.
