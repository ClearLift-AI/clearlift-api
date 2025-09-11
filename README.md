# ClearLift API

Production API for ClearLift advertising analytics platform built on Cloudflare Workers with D1 databases and R2 Data Catalog.

## Architecture

- **Cloudflare Workers**: Serverless API runtime
- **D1 Databases**: Two separate databases for user data and advertising data
- **R2 Data Catalog**: Data lakehouse for large-scale event analytics (Iceberg tables)
- **Hono + Chanfana**: Web framework with automatic OpenAPI documentation
- **DuckLake Container**: DuckDB engine for querying R2 Data Catalog

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono.js with Chanfana (OpenAPI)
- **Databases**: 
  - D1 (SQLite) for transactional data
  - R2 Data Catalog (Iceberg) for analytics
- **Language**: TypeScript
- **Testing**: Vitest

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers access
- Wrangler CLI (`npm install -g wrangler`)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/clearlift-api.git
cd clearlift-api
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your values
```

### Database Setup

The API uses two D1 databases:

1. **Main Database (DB)** - User management and authentication
2. **AD_DATA Database** - Advertising campaign data

Both databases are already configured in `wrangler.jsonc`:
- DB: `89bd84be-b517-4c72-ab61-422384319361`
- AD_DATA: `718751dd-7256-49bd-9396-18550eb0fe28`

### Apply Migrations

```bash
# Main database migrations
npx wrangler d1 migrations apply DB --local  # For local development
npx wrangler d1 migrations apply DB --remote # For production

# AD_DATA database migrations
npx wrangler d1 migrations apply AD_DATA --local
npx wrangler d1 migrations apply AD_DATA --remote
```

## Development

Start the development server:
```bash
npm run dev
```

The API will be available at `http://localhost:8787`

## API Endpoints

### Public Endpoints
- `GET /` - OpenAPI documentation
- `GET /health` - Health check

### Authentication Required
- `GET /api/user/profile` - Get user profile
- `PUT /api/user/profile` - Update user profile
- `GET /api/organizations` - List organizations
- `POST /api/organizations` - Create organization
- `POST /api/organizations/switch` - Switch organization

### Organization Context Required
- `POST /api/campaigns` - Get campaign data
- `GET /api/platforms/list` - List connected platforms
- `POST /api/platforms/sync` - Sync platform data
- `GET /api/events/conversions` - Get conversion metrics
- `POST /api/datalake/tables` - Create datalake table
- `POST /api/datalake/sync/campaigns` - Sync campaigns to datalake

### Debug Endpoints
- `GET /debug/databases` - Database connection info (requires x-debug-token)
- `GET /debug/migrations` - Migration status (requires x-debug-token)
- `POST /debug/test-write` - Test write permissions (requires x-debug-token)

## Environment Variables

Required secrets in Cloudflare dashboard:

```bash
# Debug access
DEBUG_TOKEN=your-secure-debug-token

# R2 Data Catalog (optional)
# These are Cloudflare API tokens with R2 permissions
# Create at: Cloudflare Dashboard > R2 > Manage API tokens
R2_READ_ONLY_TOKEN=your-cloudflare-api-token  # Admin Read Only permissions
R2_WRITE_TOKEN=your-cloudflare-api-token      # Admin Read & Write permissions
DATALAKE_CATALOG_URI=https://catalog.cloudflarestorage.com/...
DATALAKE_WAREHOUSE_NAME=your-warehouse-name
```

## Deployment

1. Deploy to Cloudflare Workers:
```bash
npm run deploy
```

2. Apply remote migrations:
```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations apply AD_DATA --remote
```

3. Set secrets in Cloudflare dashboard:
   - Navigate to Workers & Pages > clearlift-api > Settings > Variables
   - Add required secrets

## Testing

Run tests:
```bash
npm run test
```

Test database connectivity:
```bash
./test-database-access.sh [debug-token]
```

## Data Architecture

### D1 Databases

**Main DB** - User management:
- users
- sessions
- organizations
- organization_members
- platform_connections
- invitations

**AD_DATA** - Advertising data:
- campaigns
- sync_history
- platform_accounts
- keywords
- ad_groups

### R2 Data Catalog (Datalake)

Iceberg tables for analytics:
- conversion_events
- campaign_metrics
- user_interactions
- attribution_data

## Monitoring

Monitor your deployed worker:
```bash
npx wrangler tail
```

## License

Private - All rights reserved

## Support

For issues and questions, contact the ClearLift team.