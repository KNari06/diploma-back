# Waitlist API

## GET /api/v1/waitlist?page=1&limit=20

Требует админ токен. Query: `page` (default: 1), `limit` (default: 20, max: 100)

**Response 200:** `{ success: true, data: [...], pagination: { total, page, limit, has_more } }`
