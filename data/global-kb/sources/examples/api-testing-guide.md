# API Testing Complete Guide

## HTTP Methods

### GET

Used to retrieve data from the server.

**Example:**

```
GET /api/users/123
Expected: 200 OK
Response: { "id": 123, "name": "John Doe", "email": "john@example.com" }
```

**Best practices:**

- Should not modify server state
- Can be cached
- Should be idempotent

### POST

Used to create new resources.

**Example:**

```
POST /api/users
Body: { "name": "Jane Doe", "email": "jane@example.com" }
Expected: 201 Created
Response: { "id": 124, "name": "Jane Doe", "email": "jane@example.com" }
```

**Best practices:**

- Validate all required fields
- Check for duplicate entries
- Return created resource with ID
- Use 201 status code

### PUT

Used to update existing resources.

**Example:**

```
PUT /api/users/123
Body: { "name": "John Updated", "email": "john.new@example.com" }
Expected: 200 OK
Response: Updated user object
```

### DELETE

Used to remove resources.

**Example:**

```
DELETE /api/users/123
Expected: 204 No Content or 200 OK
```

### PATCH

Used for partial updates.

**Example:**

```
PATCH /api/users/123
Body: { "email": "newemail@example.com" }
Expected: 200 OK
```

## Status Codes

### Success Codes

- **200 OK**: Request successful
- **201 Created**: Resource created
- **204 No Content**: Success but no response body

### Client Error Codes

- **400 Bad Request**: Invalid request format
- **401 Unauthorized**: Authentication required
- **403 Forbidden**: Authenticated but not authorized
- **404 Not Found**: Resource doesn't exist
- **422 Unprocessable Entity**: Validation failed

### Server Error Codes

- **500 Internal Server Error**: Server-side error
- **502 Bad Gateway**: Upstream server error
- **503 Service Unavailable**: Server temporarily unavailable

## Authentication

### Bearer Token

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### API Key

```
X-API-Key: your-api-key-here
```

### Basic Auth

```
Authorization: Basic base64(username:password)
```

## Response Validation

### Check Structure

Verify response contains expected fields:

```json
{
  "id": "string",
  "name": "string",
  "email": "string (email format)",
  "created_at": "string (ISO date)"
}
```

### Check Data Types

- Strings should be strings
- Numbers should be numbers
- Dates should be valid ISO format
- Arrays should be arrays
- Objects should be objects

### Check Business Logic

- User ID should be unique
- Email format should be valid
- Timestamps should be in order
- Related IDs should exist

## Error Handling

### Expected Errors

Test that API properly handles:

- Missing required fields → 400
- Invalid authentication → 401
- Insufficient permissions → 403
- Resource not found → 404
- Duplicate entries → 409
- Validation failures → 422

### Error Response Format

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {...}
}
```

## Performance Testing

### Response Time Expectations

- Simple queries: < 100ms
- Complex queries: < 500ms
- Third-party API calls: < 2000ms
- File uploads: < 5000ms

### Load Testing

Test API under load:

- Concurrent requests
- Rate limiting
- Database connection pooling
- Memory usage
- CPU usage

## Common Patterns

### Pagination

```
GET /api/users?page=1&limit=20
Response:
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

### Filtering

```
GET /api/users?role=admin&status=active
```

### Sorting

```
GET /api/users?sort=created_at&order=desc
```

### Search

```
GET /api/users?search=john
```

## Testing Checklist

- [ ] Test all HTTP methods (GET, POST, PUT, DELETE, PATCH)
- [ ] Verify status codes
- [ ] Validate response structure
- [ ] Test authentication
- [ ] Test authorization
- [ ] Check error handling
- [ ] Measure response times
- [ ] Test edge cases
- [ ] Test with invalid data
- [ ] Check CORS headers
- [ ] Verify content-type
- [ ] Test rate limiting
