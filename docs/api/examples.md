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

---

**Need more examples?** Check the [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed documentation.
