# Clearlift DuckDB API Access Guide For the EVENTS DB

## Production Endpoint

```
https://query.clearlift.ai
```

## Quick Start

```javascript
// Simple query example
const response = await fetch('https://query.clearlift.ai/api/query', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    session_token: 'your-session-token-here',
    tag: 'org-tag-here',
    query_type: 'events',
    lookback: '24h',
    limit: 100
  })
});

const data = await response.json();
```

## Authentication

All API requests require session-based authentication using a session token obtained from the Clearlift platform.

### Obtaining a Session Token

Session tokens are managed through the Clearlift platform's authentication system. They are stored in the D1 database with user permissions and organization access controls.

### Authentication Methods

#### Method 1: Session Token in Request Body (Recommended)

```javascript
{
  "session_token": "your-session-token-here",
  "tag": "a3f7c2",
  // ... other parameters
}
```

#### Method 2: Query Parameter (GET requests)

```
GET https://query.clearlift.ai/api/query?session_token=your-token&tag=a3f7c2&lookback=24h
```

## API Endpoints

### POST /api/query

Main endpoint for querying event data.

**Request Body:**

```typescript
{
  session_token: string;      // Required: Your authentication token
  tag: string;                 // Required: Organization tag (e.g., 'a3f7c2')
  query_type?: 'events' | 'stats' | 'raw';  // Default: 'events'
  lookback?: string;          // Time range: '24h', '7d', '30m' (default: '24h')
  limit?: number;             // Max results (default: 100)
  custom_query?: string;      // SQL query (only for query_type: 'raw')
}
```

**Response:**

```typescript
{
  success: boolean;
  columns: string[];          // Column names
  rows: any[];               // Query results
  rowCount: number;
  executionTime: number;      // Query execution time in ms
  context: {
    user_id: string;
    tag: string;
    session_id: string;
  }
}
```

## Code Examples

### Frontend Application (React/Next.js)

```typescript
// utils/clearlift-api.ts
class ClearliftAPI {
  private baseURL = 'https://query.clearlift.ai';
  private sessionToken: string;

  constructor(sessionToken: string) {
    this.sessionToken = sessionToken;
  }

  async queryEvents(tag: string, lookback = '24h', limit = 100) {
    const response = await fetch(`${this.baseURL}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_token: this.sessionToken,
        tag,
        query_type: 'events',
        lookback,
        limit
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Query failed');
    }

    return response.json();
  }

  async getStats(tag: string, lookback = '7d') {
    const response = await fetch(`${this.baseURL}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_token: this.sessionToken,
        tag,
        query_type: 'stats',
        lookback
      })
    });

    return response.json();
  }

  async customQuery(tag: string, sql: string) {
    const response = await fetch(`${this.baseURL}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_token: this.sessionToken,
        tag,
        query_type: 'raw',
        custom_query: sql
      })
    });

    return response.json();
  }
}

// Usage in React component
const api = new ClearliftAPI('your-session-token');

// Get recent events
const events = await api.queryEvents('a3f7c2', '24h', 50);

// Get statistics
const stats = await api.getStats('a3f7c2', '7d');
```

### Cloudflare Worker Integration

```typescript
// worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Forward analytics request to Clearlift
    const clearliftData = await queryClearlift(env.CLEARLIFT_SESSION_TOKEN);

    return new Response(JSON.stringify(clearliftData), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function queryClearlift(sessionToken: string) {
  const response = await fetch('https://query.clearlift.ai/api/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_token: sessionToken,
      tag: 'a3f7c2',
      query_type: 'events',
      lookback: '1h',
      limit: 10
    })
  });

  if (!response.ok) {
    throw new Error(`Clearlift query failed: ${response.status}`);
  }

  return response.json();
}
```

### Node.js Backend

```javascript
// clearlift-client.js
const fetch = require('node-fetch');

class ClearliftClient {
  constructor(sessionToken) {
    this.sessionToken = sessionToken;
    this.baseURL = 'https://query.clearlift.ai';
  }

  async query(params) {
    const response = await fetch(`${this.baseURL}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_token: this.sessionToken,
        ...params
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  }

  // Convenience methods
  async getRecentEvents(tag, hours = 24) {
    return this.query({
      tag,
      query_type: 'events',
      lookback: `${hours}h`,
      limit: 100
    });
  }

  async getDailyStats(tag, days = 7) {
    return this.query({
      tag,
      query_type: 'stats',
      lookback: `${days}d`
    });
  }
}

// Usage
const client = new ClearliftClient('your-session-token');

// Get events from last 48 hours
const events = await client.getRecentEvents('a3f7c2', 48);
console.log(`Found ${events.rowCount} events`);

// Get weekly statistics
const stats = await client.getDailyStats('a3f7c2', 7);
```

### cURL Examples

```bash
# Query recent events
curl -X POST https://query.clearlift.ai/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "session_token": "your-session-token",
    "tag": "a3f7c2",
    "query_type": "events",
    "lookback": "24h",
    "limit": 10
  }'

# Get statistics
curl -X POST https://query.clearlift.ai/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "session_token": "your-session-token",
    "tag": "a3f7c2",
    "query_type": "stats",
    "lookback": "7d"
  }'

# GET request with query parameters
curl "https://query.clearlift.ai/api/query?session_token=your-token&tag=a3f7c2&query_type=events&lookback=1h&limit=5"
```

## Query Types

### 1. Events Query (`query_type: 'events'`)

Returns raw event records with all fields.

```javascript
{
  query_type: 'events',
  lookback: '24h',    // Time range
  limit: 100          // Max records
}
```

**Returns:** Individual event records with timestamp, sessionId, userId, eventType, etc.

### 2. Statistics Query (`query_type: 'stats'`)

Returns aggregated statistics about events.

```javascript
{
  query_type: 'stats',
  lookback: '7d'      // Time range for statistics
}
```

**Returns:** Aggregated data like event counts, unique sessions, users by time period.

### 3. Raw SQL Query (`query_type: 'raw'`)

Execute custom SQL queries (with tag-based access control).

```javascript
{
  query_type: 'raw',
  custom_query: `
    SELECT eventType, COUNT(*) as count
    FROM read_json('s3://event-datalake/events/tag=a3f7c2/year=2025/month=9/day=*/*/*.json')
    GROUP BY eventType
    ORDER BY count DESC
  `
}
```

**Note:** Raw queries must include appropriate tag filtering for security.

## Response Handling

### Success Response

```javascript
{
  "success": true,
  "columns": ["timestamp", "sessionId", "eventType", ...],
  "rows": [
    {
      "timestamp": "2025-09-16T12:00:00Z",
      "sessionId": "abc-123",
      "eventType": "page_view",
      // ... more fields
    }
  ],
  "rowCount": 42,
  "executionTime": 1250,  // milliseconds
  "context": {
    "user_id": "user-uuid",
    "tag": "a3f7c2",
    "session_id": "sess-prefix..."
  }
}
```

### Error Response

```javascript
{
  "error": "Unauthorized: Invalid session or insufficient permissions",
  "debug": {
    "session_token_prefix": "3c83ba76",
    "requested_tag": "a3f7c2"
  }
}
```

### Common HTTP Status Codes

- `200` - Success
- `400` - Bad request (missing parameters)
- `401` - Unauthorized (invalid/expired session)
- `403` - Forbidden (no access to requested tag)
- `500` - Internal server error
- `503` - Service unavailable (container starting)

## Best Practices

### 1. Error Handling

```javascript
try {
  const response = await fetch('https://query.clearlift.ai/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await response.json();

  if (!response.ok) {
    // Handle different error types
    switch (response.status) {
      case 401:
        // Session expired, re-authenticate
        await refreshSession();
        break;
      case 503:
        // Container starting, retry after delay
        await new Promise(r => setTimeout(r, 5000));
        return retry();
      default:
        console.error('Query failed:', data.error);
    }
  }

  return data;
} catch (error) {
  console.error('Network error:', error);
}
```

### 2. CORS Configuration

The API supports CORS with the following headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Session-Token
```

### 3. Performance Optimization

```javascript
// Cache responses when appropriate
const cache = new Map();

async function getCachedQuery(params) {
  const cacheKey = JSON.stringify(params);

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < 300000) { // 5 min cache
      return cached.data;
    }
  }

  const data = await queryAPI(params);
  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}
```

### 4. Batch Requests

For multiple queries, execute them in parallel:

```javascript
const [events, stats, customData] = await Promise.all([
  api.queryEvents('a3f7c2', '24h'),
  api.getStats('a3f7c2', '7d'),
  api.customQuery('a3f7c2', customSQL)
]);
```

## Common Use Cases

### 1. Real-time Dashboard

```javascript
// Refresh dashboard every 30 seconds
setInterval(async () => {
  const data = await api.queryEvents('a3f7c2', '1h', 50);
  updateDashboard(data.rows);
}, 30000);
```

### 2. Daily Reports

```javascript
// Generate daily report
async function generateDailyReport(tag) {
  const stats = await api.getStats(tag, '1d');
  const events = await api.queryEvents(tag, '24h', 1000);

  return {
    date: new Date().toISOString().split('T')[0],
    summary: stats,
    details: events.rows
  };
}
```

### 3. User Activity Timeline

```javascript
// Get user's activity for the past week
const userActivity = await api.customQuery('a3f7c2', `
  SELECT timestamp, eventType, pageData
  FROM read_json('s3://event-datalake/events/tag=a3f7c2/*/*/*/*/*.json')
  WHERE userId = 'user-123'
    AND timestamp > CURRENT_TIMESTAMP - INTERVAL '7 days'
  ORDER BY timestamp DESC
`);
```

### 4. Export Data

```javascript
// Export events to CSV
async function exportToCSV(tag, lookback) {
  const data = await api.queryEvents(tag, lookback, 10000);

  const csv = [
    data.columns.join(','),
    ...data.rows.map(row =>
      data.columns.map(col => row[col]).join(',')
    )
  ].join('\n');

  // Download CSV
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `events-${tag}-${lookback}.csv`;
  a.click();
}
```

## Troubleshooting

### Container Startup Time

The first request after inactivity may take 20-30 seconds as the container starts. Subsequent requests are faster.

### Session Expiration

Sessions expire after a configured period. Handle 401 responses by re-authenticating.

### Rate Limiting

The API may implement rate limiting per session. Implement exponential backoff for retries.

### Large Result Sets

For queries returning large amounts of data, use pagination with `limit` and consider implementing streaming if available.

## Support

For issues or questions about API access, contact the Clearlift support team or refer to the main documentation.