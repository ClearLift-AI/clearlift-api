# ClearLift API Worker Deployment Guide

## Overview

This guide covers the deployment and configuration of the ClearLift API Worker. The API worker serves as the central authentication and data access layer, coordinating between:

- **D1 Database**: User auth, sessions, organization config
- **R2 SQL Data Lake**: Clickstream and event analytics
- **Supabase**: Connector data from advertising platforms
- **Cron/Queue Workers**: Sync job orchestration

## Architecture

```
┌─────────────────────┐
│   Frontend Apps     │
└──────────┬──────────┘
           │ HTTPS
           ↓
┌─────────────────────┐
│  API Worker (This)  │ ← api.clearlift.ai
├─────────────────────┤
│  • Authentication   │
│  • Session Mgmt     │
│  • OAuth Flows      │
│  • Data Access      │
└──────┬──────────────┘
       │
       ├──→ D1 Database (Config/Auth)
       ├──→ R2 SQL (Analytics)
       ├──→ Supabase (Ad Platform Data)
       └──→ Workers (Health Checks)
               ├── Cron Worker
               └── Queue Consumer
```

## Prerequisites

1. **Cloudflare Account** with Workers Paid Plan
2. **Supabase Project** with SQL schemas deployed
3. **OAuth Apps** configured for each platform:
   - Google Ads API access
   - Facebook Business Manager App
   - TikTok Ads API access

## Environment Configuration

### Secrets Configuration (via Secrets Store)

All secrets are now managed via **Cloudflare Secrets Store** for enhanced security and centralized management.

**Secrets Store ID:** `b97bbcc69dce4f59b1043024f8a68f19`

The following secrets are already configured in Secrets Store and bound in `wrangler.jsonc`:

| Secret Name | Binding | Description |
|------------|---------|-------------|
| `ENCRYPTION_KEY` | `ENCRYPTION_KEY` | Master encryption key for field-level encryption |
| `SUPABASE_SECRET_KEY` | `SUPABASE_SECRET_KEY` | Backend API key for Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | `SUPABASE_PUBLISHABLE_KEY` | Public API key for Supabase |
| `R2_ADMIN_TOKEN` | `R2_SQL_TOKEN` | API token for R2 SQL queries |
| `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token |
| `FACEBOOK_APP_ID` | `FACEBOOK_APP_ID` | Facebook app ID for OAuth |
| `FB_API_KEY` | `FACEBOOK_APP_SECRET` | Facebook app secret |

**To manage secrets:**

```bash
# View secrets in dashboard
# Go to: Workers & Pages → Secrets Store → Select store

# Update a secret via CLI
npx wrangler secrets-store secret update b97bbcc69dce4f59b1043024f8a68f19 --name SECRET_NAME --remote

# Create a new secret via CLI
npx wrangler secrets-store secret create b97bbcc69dce4f59b1043024f8a68f19 --name NEW_SECRET --remote
```

### Environment Variables (wrangler.jsonc)

The `wrangler.jsonc` file is fully configured with:

1. **Regular environment variables** (public configuration)
2. **D1 database binding**
3. **Secrets Store bindings** (sensitive data)

```json
{
  "vars": {
    "SUPABASE_URL": "https://jwosqxmfezmnhrbbjlbx.supabase.co",
    "CLOUDFLARE_ACCOUNT_ID": "133c285e1182ce57a619c802eaf56fb0",
    "R2_BUCKET_NAME": "clearlift-db"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ClearLiftDash-D1",
      "database_id": "89bd84be-b517-4c72-ab61-422384319361"
    }
  ],
  "secrets_store_secrets": [
    // All secrets are bound from Secrets Store ID: b97bbcc69dce4f59b1043024f8a68f19
    // See table above for complete list
  ]
}
```

## Deployment Steps

### 1. Initial Setup

```bash
# Clone the repository
git clone <repo-url>
cd clearlift-api

# Install dependencies
npm install

# Generate TypeScript types
npm run cf-typegen
```

### 2. Database Setup

The D1 database is shared with the cron/queue workers. Ensure migrations are applied:

```bash
# Apply migrations to production D1
npm run predeploy

# Verify migrations
npx wrangler d1 execute ClearLiftDash-D1 --sql "SELECT name FROM sqlite_master WHERE type='table';"
```

Expected tables:
- `users`
- `sessions`
- `organizations`
- `organization_members`
- `platform_connections`
- `sync_jobs`
- `org_tag_mappings`
- `oauth_states`

### 3. Configure OAuth Redirect URIs

Add these redirect URIs to your OAuth apps:

#### Google Ads
```
https://api.clearlift.ai/v1/connectors/google/callback
```

#### Facebook Business
```
https://api.clearlift.ai/v1/connectors/facebook/callback
```

#### TikTok Ads
```
https://api.clearlift.ai/v1/connectors/tiktok/callback
```

### 4. Deploy the Worker

```bash
# Test locally first
npm run dev

# Deploy to production
npm run deploy

# Or direct deployment
npx wrangler deploy
```

### 5. Verify Deployment

```bash
# Check health endpoint
curl https://api.clearlift.ai/v1/health

# Check worker status (requires auth)
curl -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  https://api.clearlift.ai/v1/workers/health
```

## Key API Endpoints

### Authentication
- `GET /v1/user/me` - Get current user
- `GET /v1/user/organizations` - List user's organizations

### Connectors
- `POST /v1/connectors/:provider/connect` - Initiate OAuth
- `GET /v1/connectors/:provider/callback` - OAuth callback
- `GET /v1/connectors/connected?org_id=X` - List connections
- `DELETE /v1/connectors/:connection_id` - Disconnect

### Worker Management
- `GET /v1/workers/health` - Check cron/queue health
- `GET /v1/workers/queue/status` - Queue processing status
- `GET /v1/workers/dlq` - Dead letter queue items
- `POST /v1/workers/sync/trigger` - Manual sync trigger

### Analytics
- `GET /v1/analytics/events?org_id=X` - R2 SQL events
- `GET /v1/analytics/platforms/:platform?org_id=X` - Platform data
- `GET /v1/analytics/platforms/unified?org_id=X` - Cross-platform metrics

## Integration with Cron/Queue Workers

The API worker communicates with deployed workers at:
- **Cron**: https://clearlift-cron-worker.paul-33c.workers.dev
- **Queue**: https://clearlift-queue-consumer.paul-33c.workers.dev

### OAuth Connection Flow

1. User initiates OAuth via API endpoint
2. API stores encrypted tokens in `platform_connections` table
3. Cron worker (every 15 min) discovers new connections
4. Queue consumer fetches data and writes to Supabase

### Manual Sync Trigger

```typescript
POST /v1/workers/sync/trigger
{
  "connection_id": "abc-123",
  "job_type": "full" // or "incremental"
}
```

Creates a sync job that the cron worker will pick up in the next run.

## Monitoring

### Health Checks

```bash
# API worker health
curl https://api.clearlift.ai/v1/health

# Cron worker health
curl https://api.clearlift.ai/v1/workers/health

# Queue status
curl -H "Authorization: Bearer TOKEN" \
  https://api.clearlift.ai/v1/workers/queue/status
```

### Logs

View logs in Cloudflare Dashboard:
1. Go to Workers & Pages
2. Select `clearlift-api`
3. Click "Logs" tab
4. Use filters for debugging

### Common Issues

#### OAuth Failures
- Check OAuth credentials are set correctly
- Verify redirect URIs match exactly
- Check encryption key is set

#### R2 SQL Errors
- Verify R2_SQL_TOKEN is valid
- Check org_tag_mappings table has entry for org
- Ensure R2 bucket has data

#### Supabase Connection Issues
- Verify SUPABASE_SECRET_KEY is set
- Check Supabase schemas are deployed
- Ensure RLS policies allow backend access

## Security Considerations

1. **Never expose secrets** in logs or responses
2. **Always validate** organization access before data queries
3. **Use encryption** for stored credentials
4. **Rate limit** API endpoints (configure in Cloudflare)
5. **Monitor** failed authentication attempts

## Testing

### Local Development

```bash
# Create .dev.vars file
cat > .dev.vars <<EOF
ENCRYPTION_KEY=your-test-key
SUPABASE_SECRET_KEY=your-test-key
R2_SQL_TOKEN=your-test-token
GOOGLE_CLIENT_ID=test-id
GOOGLE_CLIENT_SECRET=test-secret
FACEBOOK_APP_ID=test-id
FACEBOOK_APP_SECRET=test-secret
EOF

# Run locally
npm run dev
```

### Integration Tests

```bash
# Run test suite
npm test

# Test specific endpoint
curl -X POST http://localhost:8787/v1/connectors/google/connect \
  -H "Authorization: Bearer TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"organization_id": "test-org"}'
```

## Rollback Procedure

If deployment fails:

```bash
# List deployments
npx wrangler deployments list

# Rollback to previous version
npx wrangler rollback

# Or deploy specific version
npx wrangler deploy --compatibility-date 2025-04-01
```

## Support

- **Cloudflare Issues**: Check Workers dashboard for errors
- **OAuth Issues**: Verify credentials and redirect URIs
- **Data Issues**: Check Supabase and R2 SQL connections
- **Worker Communication**: Verify cron/queue workers are healthy

## Next Steps

After successful deployment:

1. Configure rate limiting in Cloudflare
2. Set up monitoring alerts
3. Test OAuth flows for each platform
4. Verify data flows to Supabase
5. Monitor sync job success rates

---

**Last Updated**: October 2025
**API Version**: 1.0.0
**Workers Runtime**: Cloudflare Workers