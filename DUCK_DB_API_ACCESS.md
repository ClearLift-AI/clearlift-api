API Endpoint

  POST https://query.clearlift.ai/events/{tag}

  Authentication

  All requests require a valid session token obtained from the Clearlift platform:
  {
    "session_token": "your-session-token-here"
  }

  Query Parameters

  1. Time Range Options

  Option A - Relative Lookback:
  {
    "lookback": "24h"  // Supported: 1h, 6h, 12h, 24h, 48h, 7d, 14d, 30d, 90d
  }

  Option B - Absolute Time Range:
  {
    "timeRange": {
      "start": "2025-09-16T00:00:00Z",
      "end": "2025-09-16T23:59:59Z"
    }
  }

  2. Field Selection

  Specify which fields to return (default: all fields):
  {
    "select": ["timestamp", "eventType", "sessionId", "userId", "pageData"]
  }

  Available fields:
  - timestamp - Event timestamp
  - sessionId - User session identifier
  - userId - User identifier
  - eventType - Type of event (page_view, click, scroll, etc.)
  - eventData - Event-specific data
  - pageData - Page context (URL, title, path, etc.)
  - deviceInfo - Device/browser information
  - utmParams - UTM tracking parameters

  3. Filtering

  Filter events by specific criteria:
  {
    "filters": {
      "eventType": ["page_view", "click"],
      "pageData.hostname": "example.com",
      "deviceInfo.browser": "Chrome"
    }
  }

  4. Aggregation

  Get summarized statistics instead of raw events:
  {
    "aggregate": {
      "groupBy": ["eventType"],
      "metrics": ["count", "distinct_users", "distinct_sessions"],
      "timeGranularity": "hour"  // Options: minute, hour, day, week, month
    }
  }

  Supported metrics:
  - count - Total event count
  - distinct_users - Unique user count
  - distinct_sessions - Unique session count

  5. Sorting & Pagination

  {
    "orderBy": [
      { "field": "timestamp", "direction": "DESC" }
    ],
    "limit": 100,    // Max results (default: 100, max: 1000)
    "offset": 0      // Skip N results for pagination
  }

  Example Queries

  Get Recent Events

  curl -X POST https://query.clearlift.ai/events/a3f7c2 \
    -H "Content-Type: application/json" \
    -d '{
      "session_token": "your-token",
      "lookback": "24h",
      "limit": 50
    }'

  Get Page Views for Specific Date

  curl -X POST https://query.clearlift.ai/events/a3f7c2 \
    -H "Content-Type: application/json" \
    -d '{
      "session_token": "your-token",
      "timeRange": {
        "start": "2025-09-16T00:00:00Z",
        "end": "2025-09-16T23:59:59Z"
      },
      "filters": {
        "eventType": "page_view"
      },
      "select": ["timestamp", "userId", "pageData.url", "pageData.title"]
    }'

  Get Daily Event Counts by Type

  curl -X POST https://query.clearlift.ai/events/a3f7c2 \
    -H "Content-Type: application/json" \
    -d '{
      "session_token": "your-token",
      "lookback": "7d",
      "aggregate": {
        "groupBy": ["eventType"],
        "metrics": ["count", "distinct_users"]
      }
    }'

  Get Hourly Time Series

  curl -X POST https://query.clearlift.ai/events/a3f7c2 \
    -H "Content-Type: application/json" \
    -d '{
      "session_token": "your-token",
      "lookback": "24h",
      "aggregate": {
        "timeGranularity": "hour",
        "metrics": ["count"]
      }
    }'

  Get User Journey for Specific Session

  curl -X POST https://query.clearlift.ai/events/a3f7c2 \
    -H "Content-Type: application/json" \
    -d '{
      "session_token": "your-token",
      "filters": {
        "sessionId": "e62a-6dfa-f2a9-mflqt038"
      },
      "orderBy": [
        { "field": "timestamp", "direction": "ASC" }
      ],
      "limit": 100
    }'

  Response Format

  Success Response

  {
    "success": true,
    "columns": ["timestamp", "eventType", "sessionId", "userId"],
    "rows": [
      {
        "timestamp": "2025-09-16T16:39:34.733Z",
        "eventType": "page_view",
        "sessionId": "abc-123",
        "userId": "user_001"
      }
    ],
    "rowCount": 1,
    "executionTime": 1234,
    "metadata": {
      "tag": "a3f7c2",
      "partitioningUsed": "hive",
      "optimized": true
    },
    "context": {
      "user_id": "d0cf0973-1f80-4551-819b-0601e3fbe989",
      "authorized_tags": ["a3f7c2"]
    }
  }

  Error Response

  {
    "success": false,
    "error": "Error message here"
  }

  Performance Tips

  1. Use Time Filters - Always specify a time range to leverage Hive partitioning
  2. Limit Results - Use reasonable limits to reduce query time
  3. Select Only Needed Fields - Reduces data transfer and processing
  4. Use Aggregation - For dashboards and reports, use aggregation instead of fetching raw events
  5. Leverage Partition Pruning - Queries automatically optimize based on year/month/day/hour partitions

  Rate Limits & Best Practices

  - Maximum query timeout: 60 seconds
  - Maximum result size: 10MB
  - For large exports, use pagination with offset and limit
  - Cache aggregated results when possible
  - Use specific time ranges rather than broad lookbacks
  