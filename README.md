# ClearLift API Worker

Production-ready API gateway for the ClearLift analytics platform with SOC 2 Type 2 compliance.

## Overview

The ClearLift API Worker is a Cloudflare Workers-based service that provides:
- 🔐 **Authentication & Authorization** - Session management with RBAC
- 🔄 **OAuth Integration** - Google, Facebook, TikTok, Stripe connectors
- 📊 **Data Access Layer** - Unified access to multiple data sources
- 📝 **Audit Logging** - Complete SOC 2 compliant audit trail
- 🛡️ **Security Controls** - Rate limiting, input validation, encryption

## Architecture

```
Frontend Apps → API Worker (api.clearlift.ai)
                    ↓
    ┌──────────────────────────────────┐
    │  D1 Database (Config/Auth)        │
    │  Supabase (Ad Platform Data)      │
    │  R2 SQL (Analytics/Clickstream)    │
    └──────────────────────────────────┘
```

## Quick Start

### Prerequisites
- Cloudflare Workers account (Paid plan)
- Supabase project
- Node.js 18+
- Wrangler CLI

### Installation

```bash
# Clone repository
git clone <repo-url>
cd clearlift-api

# Install dependencies
npm install

# Configure secrets (see deployment guide)
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SUPABASE_SECRET_KEY
# ... additional secrets
```

### Development

```bash
# Run locally with hot reload
npm run dev

# Run tests
npm test

# Generate OpenAPI schema
npm run schema
```

### Deployment

```bash
# Apply database migrations
npm run db:migrate:remote

# Deploy to Cloudflare Workers
npm run deploy
```

## Features

### 🔐 Security & Compliance

- **SOC 2 Type 2 Ready** - All Trust Services Criteria implemented
- **Field-Level Encryption** - AES-256-GCM for sensitive data
- **Comprehensive Audit Logging** - Every action tracked
- **Rate Limiting** - Configurable per-endpoint limits
- **Security Headers** - HSTS, CSP, XSS protection

### 📊 Data Access

- **Multi-Database Support** - D1, Supabase, R2 SQL
- **Multi-Tenant Isolation** - Organization-based data separation
- **Unified API** - Single endpoint for all data sources

### 🔄 Integrations

- **OAuth Providers** - Google Ads, Facebook Ads, TikTok Ads
- **Payment Systems** - Stripe conversion tracking
- **Worker Orchestration** - Cron and queue worker monitoring

## Documentation

- [API Deployment Guide](API_DEPLOYMENT_GUIDE.md) - Complete deployment instructions
- [Architecture](COMPLETE_ARCHITECTURE.md) - System design and data flow
- [SOC 2 Compliance](SOC2_COMPLIANCE_STATUS.md) - Security and compliance details
- [Additional Docs](docs/) - Implementation guides

## License

© 2025 ClearLift. All rights reserved.

---

**Production Status:** ✅ Ready
**SOC 2 Compliance:** ✅ Implemented
**Version:** 1.0.0
