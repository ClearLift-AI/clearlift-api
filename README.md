# ClearLift API Worker

Production-ready API gateway for the ClearLift analytics platform, built on Cloudflare Workers with SOC 2 Type 2 compliance.

[![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers)
[![License](https://img.shields.io/badge/License-Proprietary-red)](LICENSE)
[![SOC 2](https://img.shields.io/badge/SOC%202-Type%202%20Ready-green)](docs/SOC2_COMPLIANCE_STATUS.md)

## Overview

The ClearLift API Worker serves as the central authentication and data access layer for the ClearLift analytics platform. It provides secure, multi-tenant access to advertising platform data, conversion tracking, and behavioral analytics.

```
Frontend Apps → api.clearlift.ai → Authentication → Data Access
                                    ├── D1 Database (Config/Auth)
                                    ├── Supabase (Ad Platform Data)
                                    └── R2 SQL (Analytics/Events)
```

## Features

### 🔐 Security & Compliance
- **SOC 2 Type 2 Ready** - All Trust Services Criteria implemented
- **Field-Level Encryption** - AES-256-GCM for sensitive data (OAuth tokens, emails)
- **Comprehensive Audit Logging** - Every action tracked with retention policies
- **Rate Limiting** - Configurable per-endpoint, per-user, and per-IP limits
- **Security Headers** - HSTS, CSP, X-Frame-Options, XSS protection

### 🔄 OAuth Integrations
- **Google Ads** - Campaign, ad group, and ad data sync
- **Facebook Ads** - Campaign, ad set, and creative tracking
- **TikTok Ads** - Campaign and creative performance
- **Stripe** - Conversion and payment tracking

### 📊 Data Access Layer
- **Multi-Database Support** - Unified API for D1, Supabase, and R2 SQL
- **Multi-Tenant Isolation** - Organization-based data separation
- **Query Optimization** - Intelligent routing and caching

### 🛠 Developer Experience
- **OpenAPI Documentation** - Auto-generated with Chanfana
- **Type Safety** - Full TypeScript support with auto-generated types
- **Testing** - Vitest with Cloudflare Workers runtime
- **Hot Reload** - Fast local development with Wrangler

## Quick Start

### Prerequisites
- **Cloudflare Workers** account (Paid plan required for D1)
- **Supabase** project for advertising data storage
- **Node.js** 20+ and npm
- **Wrangler CLI** 4.45+

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd clearlift-api

# Install dependencies
npm install

# Generate TypeScript types
npm run cf-typegen
```

### Local Development

```bash
# Run local development server with hot reload
npm run dev
# API available at http://localhost:8787

# Apply migrations to local D1 database
npm run db:migrate:local

# Generate OpenAPI schema
npm run schema
# Schema exported to schema.yaml
```

### Testing

```bash
# Run full test suite
npm test

# Test database access
npm run test:db
```

### Deployment

```bash
# Apply migrations to production D1
npm run predeploy

# Deploy to Cloudflare Workers
npm run deploy

# Or use auto-deployment
# Push to main branch triggers GitHub Actions deployment
```

## Architecture

### Tech Stack
- **Runtime**: Cloudflare Workers (V8 Isolates)
- **Framework**: Hono 4.8 with Chanfana 2.8 for OpenAPI
- **Database**: Cloudflare D1 (SQLite)
- **Testing**: Vitest with @cloudflare/vitest-pool-workers
- **Language**: TypeScript 5.9

### Data Sources

#### 1. D1 Database (Primary)
Operational database for authentication, configuration, and orchestration.

**Key Tables:**
- `users` - User accounts with encrypted emails
- `sessions` - Active user sessions with encrypted IP addresses
- `organizations` - Multi-tenant workspaces
- `organization_members` - User-org relationships with RBAC
- `platform_connections` - OAuth connections with encrypted tokens
- `org_tag_mappings` - Organization to analytics tag mapping
- `audit_logs` - SOC 2 compliant audit trail
- `sync_jobs` - Background sync job tracking

#### 2. Supabase (PostgreSQL)
Advertising platform data storage with Row-Level Security.

**Data:**
- Google Ads campaigns, ad groups, and ads
- Facebook Ads campaigns, ad sets, and creatives
- TikTok Ads campaigns and creatives
- Stripe conversion events

#### 3. R2 SQL (Iceberg Data Lake)
Clickstream and behavioral analytics via R2 SQL API.

**Data:**
- Event stream (page views, clicks, conversions)
- Anonymous user tracking (no PII)
- UTM parameter tracking
- Session analytics

### Authentication Flow

```
1. User logs in → Cloudflare Access JWT
2. API validates JWT → Create session in D1
3. Subsequent requests → Session token validation
4. Organization access check → RBAC via organization_members
5. Data access → Filtered by organization_id or org_tag
```

### Project Structure

```
clearlift-api/
├── src/
│   ├── index.ts                 # Main router and OpenAPI setup
│   ├── types.ts                 # TypeScript type definitions
│   ├── endpoints/               # API endpoint handlers
│   │   ├── auth/               # Authentication endpoints
│   │   ├── connectors/         # OAuth integration endpoints
│   │   ├── analytics/          # Data query endpoints
│   │   └── admin/              # Admin and monitoring endpoints
│   ├── middleware/             # Request middleware
│   │   ├── auth.ts            # Session validation
│   │   ├── rateLimit.ts       # Rate limiting
│   │   └── audit.ts           # Audit logging
│   ├── adapters/              # Database adapters
│   │   ├── d1.ts             # D1 database operations
│   │   ├── supabase.ts       # Supabase client
│   │   └── r2sql.ts          # R2 SQL query builder
│   └── utils/                # Utility functions
│       ├── encryption.ts     # AES-256-GCM encryption
│       ├── oauth.ts          # OAuth flow helpers
│       └── validation.ts     # Input validation
├── migrations/               # D1 database migrations
├── tests/                   # Test files
├── wrangler.jsonc          # Cloudflare Workers configuration
└── package.json
```

## API Endpoints

### Authentication

```http
GET  /v1/user/me
GET  /v1/user/organizations
POST /v1/sessions/refresh
```

### OAuth Connectors

```http
POST   /v1/connectors/:provider/connect
GET    /v1/connectors/:provider/callback
GET    /v1/connectors/:provider/accounts
PUT    /v1/connectors/:connectionId/settings
DELETE /v1/connectors/:connectionId
POST   /v1/connectors/:connectionId/resync
```

Supported providers: `google`, `facebook`, `tiktok`, `stripe`

### Analytics

```http
GET /v1/analytics/events              # R2 SQL clickstream data
GET /v1/analytics/platforms/:provider # Supabase ad platform data
GET /v1/analytics/unified             # Cross-platform aggregated data
```

### Admin & Monitoring

```http
GET  /v1/health                       # API health check
GET  /v1/workers/health              # All workers status
POST /v1/workers/sync/trigger        # Trigger sync job
GET  /v1/workers/dlq                # Failed job queue
GET  /v1/audit/logs                 # Audit trail (admin only)
```

## Configuration

### Required Secrets

Set these secrets in Cloudflare Workers:

```bash
# Master encryption key for D1 field encryption
wrangler secret put ENCRYPTION_KEY

# Supabase credentials
wrangler secret put SUPABASE_SECRET_KEY
wrangler secret put SUPABASE_URL

# R2 SQL credentials
wrangler secret put R2_SQL_TOKEN
wrangler secret put CLOUDFLARE_ACCOUNT_ID

# OAuth credentials
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put FACEBOOK_APP_ID
wrangler secret put FACEBOOK_APP_SECRET
wrangler secret put TIKTOK_CLIENT_KEY
wrangler secret put TIKTOK_CLIENT_SECRET
wrangler secret put STRIPE_API_KEY
```

### Environment Variables

Configure in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "ENVIRONMENT": "production",
    "API_BASE_URL": "https://api.clearlift.ai",
    "R2_BUCKET_NAME": "clearlift-events"
  }
}
```

## Security

### Encryption

All sensitive data in D1 is encrypted using AES-256-GCM:
- User emails
- OAuth access tokens and refresh tokens
- Session IP addresses
- Invitation emails

### Rate Limiting

Default limits (configurable per endpoint):
- Standard: 100 requests/minute per user
- Auth: 5 failed attempts per 15 minutes
- Data queries: 30 requests/minute per organization

### Audit Logging

All operations are logged:
- API requests → `audit_logs`
- Authentication events → `auth_audit_logs`
- Data access → `data_access_logs`
- Configuration changes → `config_audit_logs`
- Security incidents → `security_events`

Retention periods:
- Audit logs: 365 days
- Config changes: 730 days
- Security events: 1095 days

## Database Migrations

### Local Development

```bash
# Apply migrations to local D1
npm run db:migrate:local

# Create new migration
wrangler d1 migrations create DB migration_name
```

### Production

```bash
# Apply migrations to remote D1 (auto-runs before deploy)
npm run db:migrate:remote
```

**Production Database ID:** `89bd84be-b517-4c72-ab61-422384319361`

## Testing

Tests run in the actual Cloudflare Workers runtime using Vitest:

```bash
# Run all tests
npm test

# Run with coverage
npx vitest run --coverage

# Watch mode (development)
npx vitest
```

Test database is automatically seeded before each test run.

## Monitoring & Health Checks

### Health Endpoint

```bash
curl https://api.clearlift.ai/v1/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-11-14T12:00:00Z",
  "version": "1.0.0",
  "database": "connected",
  "workers": {
    "cron": "healthy",
    "queue": "healthy"
  }
}
```

### Worker Status

```bash
curl -H "Authorization: Bearer TOKEN" \
  https://api.clearlift.ai/v1/workers/health
```

### Key Metrics
- API response times (tracked in audit logs)
- Sync job success rate (tracked in sync_jobs table)
- Failed jobs (available in DLQ endpoint)
- Rate limit violations (tracked in security_events)
- Authentication failures (tracked in auth_audit_logs)

## Deployment

### Auto-Deployment

Pushes to the `main` branch automatically trigger deployment via GitHub Actions.

### Manual Deployment

```bash
# Full deployment with migrations
npm run predeploy  # Apply migrations
npm run deploy     # Deploy worker
```

### Rollback

```bash
# Deploy previous version
wrangler rollback

# Or deploy specific deployment
wrangler rollback [deployment-id]
```

## Troubleshooting

### Common Issues

**Migration failures:**
```bash
# Check migration status
wrangler d1 migrations list DB --remote

# Force re-apply specific migration
wrangler d1 execute DB --file=migrations/XXXX_migration.sql --remote
```

**OAuth connection issues:**
- Verify callback URLs in provider console
- Check secret values are set correctly
- Review audit logs for detailed error messages

**Database connection errors:**
- Verify D1 database ID in wrangler.jsonc
- Check binding name matches code (DB)
- Ensure migrations are applied

## Documentation

- [Complete Architecture](docs/COMPLETE_ARCHITECTURE.md) - System design and data flow
- [Deployment Guide](docs/API_DEPLOYMENT_GUIDE.md) - Detailed deployment instructions
- [SOC 2 Compliance](docs/SOC2_COMPLIANCE_STATUS.md) - Security and compliance details
- [Developer Guide](CLAUDE.md) - Development guidelines for Claude Code

## Contributing

This is a private repository. For internal contributors:

1. Create feature branch from `main`
2. Make changes with tests
3. Update documentation
4. Submit PR with clear description
5. Wait for CI/CD checks to pass
6. Request review from team

## Related Repositories

- **clearlift-cron** - Scheduled sync job orchestration
- **clearlift-events** - Clickstream event collection and R2 Data Lake
- **clearlift-frontend** - Web application UI

## License

© 2025 ClearLift. All rights reserved. Proprietary and confidential.

## Support

For issues and questions:
- Internal team: Slack #clearlift-dev
- Production issues: PagerDuty on-call

---

**Production Status:** ✅ Deployed
**SOC 2 Compliance:** ✅ Type 2 Ready
**Version:** 1.0.0
**Last Updated:** November 2025
