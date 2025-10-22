# Production Cleanup Plan

## Files to Delete

### 1. Deprecated/Old Migrations
- [ ] `migrations-ad-data/` - Old migration structure, replaced by Supabase schemas
- [ ] `setup-test-data.sql` - Test data, not needed for production
- [ ] `test-database-access.sh` - Development test script
- [ ] `test-api.sh` - Development test script
- [ ] `test-r2sql.ts` - Test file for R2 SQL

### 2. Redundant Documentation
These docs contain overlapping information that should be consolidated:

- [ ] `R2_SQL_DEPLOYMENT.md` - Merge into COMPLETE_ARCHITECTURE.md
- [ ] `R2_SQL_DIAGNOSTIC.md` - Development debugging, delete
- [ ] `DEPLOYMENT_SUCCESS.md` - Outdated status, delete
- [ ] `STRIPE_SUPABASE_DEPLOYMENT.md` - Merge into API_DEPLOYMENT_GUIDE.md
- [ ] `STRIPE_CONNECTOR_ARCHITECTURE.md` - Merge into COMPLETE_ARCHITECTURE.md
- [ ] `MIGRATION_COMPLETE.md` - Outdated status, delete
- [ ] `ENCRYPTION_IMPLEMENTATION_GUIDE.md` - Merge key parts into SOC2_COMPLIANCE_STATUS.md
- [ ] `DATA_ARCHITECTURE.md` - Redundant with COMPLETE_ARCHITECTURE.md
- [ ] `HYBRID_VALIDATION_STRATEGY.md` - Implementation detail, archive
- [ ] `TEST_RESULTS.md` - Development artifact, delete
- [ ] `ONBOARDING_SYSTEM.md` - Very detailed, keep as reference but move to docs/
- [ ] `CRON_WORKER_DEPLOYMENT_GUIDE.md` - This is for the other repo, delete
- [ ] `API_INTEGRATION_GUIDE.md` - Redundant with API_DEPLOYMENT_GUIDE.md

### 3. Test Files to Remove/Update
- [ ] `tests/integration/dummyEndpoint.test.ts` - Remove dummy test
- [ ] `tests/integration/tasks.test.ts` - Remove if not using tasks endpoint
- [ ] `.env.example` - Update with production values

## Files to Keep (Core Documentation)

### Essential Docs (Root Level)
1. `README.md` - Project overview
2. `CLAUDE.md` - AI assistant context (keep for development)
3. `API_DEPLOYMENT_GUIDE.md` - Main deployment guide
4. `SOC2_COMPLIANCE_STATUS.md` - Compliance documentation
5. `COMPLETE_ARCHITECTURE.md` - System architecture

### Move to docs/ folder
- Technical implementation guides
- Detailed system documentation

## Code Cleanup

### 1. Remove Placeholder Values
- [ ] OAuth client IDs/secrets placeholders
- [ ] Test session tokens
- [ ] Example endpoints

### 2. Production Configuration
- [ ] Update wrangler.jsonc with production values
- [ ] Remove development-only configurations
- [ ] Set proper CORS origins

### 3. Database Migrations
- [ ] Consolidate migrations for fresh deployment
- [ ] Remove test data insertions
- [ ] Add production seed data if needed

## Consolidation Plan

### Create Single Source of Truth Docs:

1. **README.md** - Quick start and overview
2. **DEPLOYMENT.md** - Complete deployment guide (merge all deployment docs)
3. **ARCHITECTURE.md** - System design and data flow (keep COMPLETE_ARCHITECTURE.md)
4. **SECURITY.md** - SOC2 compliance and security (keep SOC2_COMPLIANCE_STATUS.md)
5. **API.md** - API reference and integration guide

## Action Items

1. Delete deprecated files
2. Consolidate overlapping documentation
3. Remove test/dummy code
4. Update configuration for production
5. Create clean migration set
6. Organize remaining docs into logical structure