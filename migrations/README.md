# D1 Migrations

## Overview

ClearLift uses a two-database architecture:

| Database | Engine | Purpose | Owner |
|----------|--------|---------|-------|
| **D1** | SQLite | Auth, orchestration, config, API audit | clearlift-api |
| **Supabase** | PostgreSQL | Synced connector data, events, sync audit | clearlift-cron |

## Migration Files

### Incremental Migrations (`migrations/`)

34 sequential migrations from `0001` to `0036` (with some gaps for removed migrations).

```
migrations/
├── 0001_add_users_table.sql
├── 0002_add_sessions_table.sql
├── ...
└── 0036_add_custom_instructions.sql
```

### Fresh Deployments (`migrations-fresh/`)

For new installations, use the squashed migration instead of running all 34 files:

```bash
npx wrangler d1 migrations apply clearlift-db --remote
# Or for fresh deployment:
# npx wrangler d1 execute clearlift-db --file=migrations-fresh/0001_complete_schema.sql --remote
```

## Audit Log Strategy

Both databases maintain audit trails for different purposes:

| Database | Purpose | Tables |
|----------|---------|--------|
| D1 | Auth/API events | `audit_logs`, `auth_audit_logs`, `data_access_logs`, `config_audit_logs`, `security_events` |
| Supabase | Sync/data events | `audit.*`, `error_logs`, `sync_history` |

## Naming Convention

- Format: `NNNN_descriptive_name.sql`
- Sequential numbering (gaps are OK from removed migrations)
- Use underscores, not hyphens

## Key Tables

### Auth & Sessions
- `users` - User accounts (Cloudflare Access SSO)
- `sessions` - Active sessions
- `organizations` - Multi-tenant organizations
- `organization_members` - User-org memberships

### Platform Connections
- `platform_connections` - OAuth connections to ad platforms
- `connector_configs` - Provider templates (Google, Meta, TikTok, Stripe)
- `sync_jobs` - Sync job tracking

### Tracking & Attribution
- `org_tag_mappings` - Short tags for event tracking
- `org_tracking_configs` - Per-org tracking settings
- `tracking_domains` - Domain-based org detection
- `identity_mappings` - Anonymous to identified user links
- `conversion_goals` - What counts as a conversion
- `event_filters` - Include/exclude rules for attribution

### AI Optimization
- `ai_optimization_settings` - Co-pilot/auto-pilot settings per org

## Running Migrations

```bash
# Apply migrations to remote D1
npx wrangler d1 migrations apply clearlift-db --remote

# Apply migrations to local D1
npx wrangler d1 migrations apply clearlift-db --local

# List migration status
npx wrangler d1 migrations list clearlift-db --remote
```

## Creating New Migrations

1. Find the next available number (check existing files)
2. Create `NNNN_descriptive_name.sql`
3. Use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` patterns
4. Add appropriate indexes
5. Test locally before deploying

```bash
# Test locally
npx wrangler d1 execute clearlift-db --file=migrations/00XX_new_migration.sql --local
```
