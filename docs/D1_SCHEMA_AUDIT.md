# D1 Schema Audit — February 2026

Generated from local SQLite inspection + production migration status checks.

---

## 1. Database Inventory

| Database | Binding | SQLite Hash | Local Size | Tables | Indexes | Migrations (Local) | Migrations (Prod) | Status |
|----------|---------|-------------|------------|--------|---------|-------------------|-------------------|--------|
| **DB** | `DB` | `c3c99c...` | 1.7 MB | 56 | 117 | 75/75 | 75/75 | Synced |
| **AI_DB** | `AI_DB` | `67235f...` | 229 KB | 10 | 17 | 8/8 | 7/8 | **DRIFT** |
| **ANALYTICS_DB** | `ANALYTICS_DB` | `9d1524...` | 3.9 MB | 114 | ~400 | 47/47 | 45/47 | **DRIFT** |
| **SHARD_0** | `SHARD_0` | — | N/A (no local) | — | — | — | 3/3 | Prod only |
| **SHARD_1** | `SHARD_1` | — | N/A (no local) | — | — | — | 3/3 | Prod only |
| **SHARD_2** | `SHARD_2` | — | N/A (no local) | — | — | — | 3/3 | Prod only |
| **SHARD_3** | `SHARD_3` | — | N/A (no local) | — | — | — | 3/3 | Prod only |

**Totals:** 180 tables across 3 local databases (down from 197 after cleanup migrations).

### Production Drift (Local ahead of prod)

| Database | Pending Migration | Effect | Impact |
|----------|------------------|--------|--------|
| AI_DB | `0008_drop_dead_cac_history.sql` | DROPs dead `cac_history` copy | Low — no code reads this copy |
| ANALYTICS_DB | `0046_handoff_patterns.sql` | Creates `handoff_patterns`, `handoff_observations` + column | ConversionLinkingWorkflow handoff matching will fail without it |
| ANALYTICS_DB | `0047_drop_legacy_platform_tables.sql` | DROPs 16 legacy google_/facebook_/tiktok_ tables | Low — all writes use unified tables; `facebook_pages` intentionally kept |

---

## 2. DB (Main) — 56 Tables, 75 Migrations

### Migration Numbering Gaps

| Range | Status |
|-------|--------|
| 0001–0016 | 16 sequential migrations |
| 0017–0018 | **Skipped** — these numbers are used by ANALYTICS_DB |
| 0019–0056 | 38 sequential migrations |
| 0057–0059 | **Skipped** — reserved/unused |
| 0060 | 1 migration |
| 0061–0064 | **Skipped** — reserved/unused |
| 0065–0084 | 20 sequential migrations |

### Dropped Tables (migration 0081)

These tables were removed and confirmed absent from current schema:
- `conversion_configs` — replaced by `conversion_goals` + ConversionEventPicker
- `interaction_nodes` — replaced by FlowBuilder goal-relationship model
- `interaction_edges` — replaced by FlowBuilder goal-relationship model
- `funnel_metadata` — replaced by FlowBuilder 3-layer architecture
- `acquisition_instances` — never populated

### Table Inventory

| # | Table | PK Type | FK References | Created By |
|---|-------|---------|---------------|------------|
| 1 | `active_event_workflows` | `org_tag TEXT` | — | 0040 |
| 2 | `active_shopify_workflows` | `connection_id TEXT` | — | 0046 |
| 3 | `admin_impersonation_logs` | `id TEXT` | `users(id)` x2 | 0025 |
| 4 | `admin_invites` | `id TEXT` | `users(id)` | 0044 |
| 5 | `admin_task_comments` | `id TEXT` | `admin_tasks(id)`, `users(id)` | 0051 |
| 6 | `admin_tasks` | `id TEXT` | `organizations(id)`, `users(id)` x4 | 0051 |
| 7 | `ai_optimization_settings` | `org_id TEXT` | `organizations(id)` | 0016 |
| 8 | `audit_logs` | `id TEXT` | — | 0011 |
| 9 | `audit_retention_policy` | `id TEXT` (randomblob) | — | 0011 |
| 10 | `auth_audit_logs` | `id INTEGER AUTOINCREMENT` | — | 0011 |
| 11 | `cleanup_jobs` | `id TEXT` (randomblob) | — | 0011 |
| 12 | `config_audit_logs` | `id INTEGER AUTOINCREMENT` | — | 0011 |
| 13 | `connector_configs` | `id TEXT` | — | 0067 |
| 14 | `connector_filter_rules` | `id TEXT` | `platform_connections(id)` | 0070 |
| 15 | `consent_configurations` | `id TEXT` (randomblob) | `org_tag_mappings(short_tag)` | 0027 |
| 16 | `conversion_goals` | `id TEXT` (randomblob) | `organizations(id)` | 0033/0054 |
| 17 | `dashboard_layouts` | `organization_id TEXT` | `organizations(id)`, `users(id)` | 0078 |
| 18 | `data_access_logs` | `id INTEGER AUTOINCREMENT` | — | 0011 |
| 19 | `email_verification_tokens` | `id TEXT` (randomblob) | `users(id)` | 0012 |
| 20 | `event_sync_watermarks` | `org_tag TEXT` | — | 0023 |
| 21 | `global_events_watermark` | `id TEXT` (default 'global_events') | — | 0034 |
| 22 | `goal_branches` | `id TEXT` | `organizations(id)`, `conversion_goals(id)` | 0072 |
| 23 | `goal_conversion_stats` | `id TEXT` | `organizations(id)`, `conversion_goals(id)` x2 | 0060 |
| 24 | `goal_group_members` | `id TEXT` | `goal_groups(id)`, `conversion_goals(id)` | 0073 |
| 25 | `goal_groups` | `id TEXT` | `organizations(id)` | 0073 |
| 26 | `goal_relationships` | `id TEXT` | `organizations(id)`, `conversion_goals(id)` x2 | 0060 |
| 27 | `goal_templates` | `id TEXT` | — | 0065 |
| 28 | `goal_value_history` | `id TEXT` | `organizations(id)`, `conversion_goals(id)` | 0055 |
| 29 | `identity_mappings` | `id TEXT` (randomblob) | `organizations(id)` | 0029 |
| 30 | `identity_merges` | `id TEXT` (randomblob) | `organizations(id)` | 0029 |
| 31 | `invitations` | `id TEXT` | — | 0006/0031 |
| 32 | `oauth_states` | `state TEXT` | `users(id)`, `organizations(id)` | 0003 |
| 33 | `onboarding_progress` | `user_id TEXT` | `users(id)`, `organizations(id)` | 0009 |
| 34 | `onboarding_steps` | `id TEXT` | — | 0009 |
| 35 | `org_tag_mappings` | `id TEXT` | `organizations(id)` | 0007 |
| 36 | `org_tracking_configs` | `id TEXT` | `organizations(id)` | 0022 |
| 37 | `organization_members` | `(organization_id, user_id)` | — | 0005 |
| 38 | `organizations` | `id TEXT` | — | 0004 |
| 39 | `password_reset_tokens` | `token TEXT` | `users(id)` | 0026 |
| 40 | `platform_connections` | `id TEXT` | — | 0003 |
| 41 | `rate_limits` | `key TEXT` | — | 0028 |
| 42 | `script_hashes` | `id TEXT` | `organizations(id)` | 0071 |
| 43 | `security_events` | `id INTEGER AUTOINCREMENT` | — | 0011 |
| 44 | `sessions` | `token TEXT` | `users(id)` | 0002 |
| 45 | `shard_migration_log` | `id TEXT` | — | 0049 |
| 46 | `shard_routing` | `organization_id TEXT` | — | 0049 |
| 47 | `stripe_metadata_keys` | `id INTEGER AUTOINCREMENT` | — | 0039 |
| 48 | `sync_jobs` | `id TEXT` | `organizations(id)` | 0003/0024 |
| 49 | `terms_acceptance` | `id TEXT` (randomblob) | `users(id)`, `organizations(id)` | 0042 |
| 50 | `tracking_domains` | `id TEXT` | `organizations(id)` | 0032 |
| 51 | `tracking_links` | `id TEXT` | `org_tag_mappings(short_tag)` | 0041 |
| 52 | `users` | `id TEXT` | — | 0001 |
| 53 | `waitlist` | `id TEXT` | — | 0013 |
| 54 | `webhook_delivery_log` | `id TEXT` | `webhook_events(id)` | 0077 |
| 55 | `webhook_endpoints` | `id TEXT` | — | 0077 |
| 56 | `webhook_events` | `id TEXT` | `webhook_endpoints(id)` | 0077 |

### `conversion_goals` Column Inventory (most-modified table — 38 columns)

Core: `id`, `organization_id`, `name`, `type`, `trigger_config`, `default_value_cents`, `is_primary`, `include_in_path`, `priority`, `created_at`, `updated_at`

Added by later migrations: `slug`, `description`, `goal_type`, `revenue_sources`, `filter_config`, `value_type`, `fixed_value_cents`, `display_order`, `color`, `icon`, `is_active`, `avg_deal_value_cents`, `close_rate_percent`, `category`, `value_method`, `auto_compute_value`, `computed_value_cents`, `computed_value_lower_cents`, `computed_value_upper_cents`, `value_computed_at`, `connector`, `is_conversion`, `position_col`, `position_row`, `connector_event_type`, `flow_tag`, `is_exclusive`, `parent_goal_ids`, `source_table`, `source_conditions`, `source_dedup_expression`, `step_requirement`

### `platform_connections` Column Inventory (second-most-modified — 25 columns)

Core: `id`, `organization_id`, `platform`, `account_id`, `account_name`, `connected_by`, `connected_at`, `last_synced_at`, `sync_status`, `sync_error`, `is_active`, `settings`

Added: `settings_encrypted`, `credentials_encrypted`, `refresh_token_encrypted`, `expires_at`, `scopes`, `stripe_account_id`, `stripe_livemode`, `filter_rules_count`, `requires_reconfiguration`, `migration_notice`, `shopify_shop_domain`, `shopify_shop_id`, `jobber_account_id`, `jobber_company_name`, `needs_reauth`, `reauth_reason`, `reauth_detected_at`, `consecutive_auth_failures`

---

## 3. AI_DB — 11 Tables, 7 Migrations

| # | Table | PK Type | Notable Columns | Created By |
|---|-------|---------|-----------------|------------|
| 1 | `ai_decisions` | `id TEXT` (randomblob) | `status`, `parameters` (JSON), `simulation_data` | 0001 |
| 2 | `ai_org_configs` | `organization_id TEXT` | `is_enabled`, `auto_execute`, `min_confidence` | 0001 |
| 3 | `ai_tool_registry` | `(tool, platform)` composite | `entity_types` (JSON), `api_endpoint` | 0001 |
| 4 | `analysis_jobs` | `id TEXT` (randomblob) | `status`, `current_level`, `termination_reason` | 0002 |
| 5 | `analysis_logs` | `id TEXT` (randomblob) | `provider`, `model`, `input_tokens`, `output_tokens` | 0002 |
| 6 | `analysis_prompts` | `id TEXT` (randomblob) | `slug` (UNIQUE), `template`, `level` | 0002 |
| 7 | `analysis_summaries` | `id TEXT` (randomblob) | `metrics_snapshot` (JSON), `expires_at` | 0002 |
| 8 | `attribution_model_results` | `id TEXT` | `model`, `channel`, `removal_effect`, `shapley_value` | 0004 |
| 9 | `cac_baselines` | `id TEXT` (randomblob) | `actual_cac_cents`, `baseline_cac_cents` | 0005 |
| 10 | `cac_history` | `id TEXT` (randomblob) | `spend_cents`, `conversions`, `cac_cents`, `conversions_goal`, `conversion_source` | 0005/0006 |
| 11 | `cac_predictions` | `id TEXT` (randomblob) | `predicted_cac_cents`, `prediction_date` | 0005 |

### Cross-Database Anomaly: Duplicate `cac_history`

`cac_history` exists in **BOTH** AI_DB and ANALYTICS_DB:

| Field | AI_DB version | ANALYTICS_DB version |
|-------|--------------|---------------------|
| Created by | 0005 | 0039 (migrated from AI_DB) |
| Goal columns | `conversions_goal`, `conversions_platform`, `conversion_source`, `goal_ids`, `revenue_goal_cents` (added by 0006) | `conversions_goal`, `conversions_platform`, `conversion_source`, `goal_ids`, `revenue_goal_cents`, **`per_source`** (added by 0043) |
| Status | **DEPRECATED** — should not be written to | **ACTIVE** — canonical location |

**Verified:** All code correctly uses `env.ANALYTICS_DB` for `cac_history` (4 files in API, 1 in cron). No code reads from the AI_DB copy. The AI_DB copy is safe to DROP in a future cleanup migration.

---

## 4. ANALYTICS_DB — 130 Tables, 46 Migrations

### Category Breakdown

#### Legacy Platform-Specific Tables (16 DROPPED by 0047, 1 retained)

| Table | Platform | Replaced By |
|-------|----------|-------------|
| `google_campaigns` | Google | `ad_campaigns` |
| `google_ad_groups` | Google | `ad_groups` |
| `google_ads` | Google | `ads` |
| `google_campaign_daily_metrics` | Google | `ad_metrics` |
| `google_ad_group_daily_metrics` | Google | `ad_metrics` |
| `google_ad_daily_metrics` | Google | `ad_metrics` |
| `facebook_campaigns` | Meta | `ad_campaigns` |
| `facebook_ad_sets` | Meta | `ad_groups` |
| `facebook_ads` | Meta | `ads` |
| `facebook_campaign_daily_metrics` | Meta | `ad_metrics` |
| `facebook_ad_set_daily_metrics` | Meta | `ad_metrics` |
| `facebook_ad_daily_metrics` | Meta | `ad_metrics` |
| `facebook_pages` | Meta | — (no replacement) |
| `tiktok_campaigns` | TikTok | `ad_campaigns` |
| `tiktok_ad_groups` | TikTok | `ad_groups` |
| `tiktok_ads` | TikTok | `ads` |
| `tiktok_campaign_daily_metrics` | TikTok | `ad_metrics` |

**Note:** `facebook_pages` has no unified equivalent. Consider whether it should be migrated to `social_profiles` or retained.

#### Unified Tables (64 tables — migrations 0019-0033)

| Migration | Category | Tables | Writer Status |
|-----------|----------|--------|---------------|
| **0019** | Ad Platforms | `ad_campaigns`, `ad_groups`, `ads`, `ad_metrics` | **Shipped** — Google/Meta/TikTok |
| **0020** | CRM | `crm_contacts`, `crm_companies`, `crm_deals`, `crm_activities` | **Shipped** — HubSpot |
| **0021** | Communication | `comm_campaigns`, `comm_subscribers`, `comm_engagements`, `comm_lists`, `comm_campaign_metrics` | Scaffolded |
| **0022** | E-commerce | `ecommerce_customers`, `ecommerce_orders`, `ecommerce_order_items`, `ecommerce_products`, `ecommerce_refunds` | **Shipped** — Shopify dual-write |
| **0023** | Payments | `payments_customers`, `payments_subscriptions`, `payments_transactions`, `payments_invoices`, `payments_plans` | **Shipped** — Stripe dual-write |
| **0024** | Support | `support_customers`, `support_tickets`, `support_conversations`, `support_messages` | Scaffolded |
| **0025** | Scheduling | `scheduling_customers`, `scheduling_services`, `scheduling_appointments`, `scheduling_availability` | **Shipped** — Jobber dual-write |
| **0026** | Forms | `forms_definitions`, `forms_submissions`, `forms_responses` | Scaffolded |
| **0027** | Events | `events_definitions`, `events_registrations`, `events_attendees`, `events_recordings` | Scaffolded |
| **0028** | Analytics | `analytics_users`, `analytics_sessions`, `analytics_events`, `analytics_page_views` | Scaffolded |
| **0029** | Accounting | `accounting_customers`, `accounting_invoices`, `accounting_expenses`, `accounting_payments`, `accounting_accounts` | Scaffolded |
| **0030** | Attribution | `attribution_installs`, `attribution_events`, `attribution_revenue`, `attribution_cohorts` | Scaffolded |
| **0031** | Reviews | `reviews_profiles`, `reviews_items`, `reviews_responses`, `reviews_aggregates` | Scaffolded |
| **0032** | Affiliate | `affiliate_partners`, `affiliate_referrals`, `affiliate_conversions`, `affiliate_payouts` | Scaffolded |
| **0033** | Social | `social_profiles`, `social_posts`, `social_followers`, `social_engagements`, `social_metrics` | Scaffolded |

#### Core Analytics Tables (22 tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `hourly_metrics` | Real-time event aggregation | `org_tag`, `hour`, `by_page` |
| `daily_metrics` | Daily event aggregation | `org_tag`, `date` |
| `event_hourly_summary` | Event-level hourly rollup | `organization_id`, `summary_hour` |
| `event_daily_summary` | Event-level daily rollup | `organization_id`, `summary_date` |
| `utm_performance` | Legacy UTM tracking | `org_tag`, `utm_source`, `utm_campaign` |
| `utm_daily_performance` | Daily UTM metrics | `organization_id`, `summary_date` |
| `attribution_results` | Simple attribution models | `org_tag`, `model` |
| `channel_transitions` | Markov transition probabilities | `org_tag`, `from_channel`, `to_channel` |
| `journeys` | Customer journey records | `org_tag`, `anonymous_id`, `converted` |
| `journey_touchpoints` | Individual touchpoints | `organization_id`, `session_id` |
| `journey_analytics` | Pre-computed journey stats | `org_tag`, `period_start` |
| `funnel_transitions` | Funnel step transitions | `org_tag`, `from_type`, `to_type` |
| `domain_claims` | Org domain ownership claims | `organization_id`, `domain_pattern` |
| `connector_sync_status` | Sync status per connector | `organization_id`, `connector_type` |
| `cleanup_log` | Cleanup job records | — |
| `sync_watermarks` | Sync progress tracking | `org_tag` |
| `aggregation_jobs` | Pre-aggregation job tracking | `organization_id`, `job_type` |
| `org_daily_summary` | Per-org daily rollup | `organization_id`, `metric_date` |
| `campaign_period_summary` | Campaign period aggregation | `organization_id`, `platform` |
| `platform_comparison` | Cross-platform comparison | `organization_id`, `comparison_date` |
| `org_timeseries` | Timeseries for org dashboards | `organization_id`, `metric_date` |
| `cac_history` | Daily CAC records (canonical) | `organization_id`, `date`, `cac_cents` |

#### Conversion Pipeline Tables (12 tables)

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `conversions` | Unified conversion records (ALL sources) | `idx_conv_dedup_unique` (UNIQUE on dedup_key), `idx_conv_source_unique` |
| `conversion_attribution` | Multi-touch attribution touchpoints | `idx_ca_unique` (UNIQUE on org, conv, model, position) |
| `conversion_daily_summary` | Daily conversion rollup | `idx_cds_org_date` |
| `conversion_value_allocations` | Multi-goal value distribution | `idx_cva_conversion`, `idx_cva_goal` |
| `goal_conversions` | Goal-to-conversion links | `idx_goal_conversions_dedup` (UNIQUE on org, goal, source_event) |
| `goal_completion_metrics` | Goal completion stats | `idx_gcm_org_date` |
| `goal_metrics_daily` | Daily goal metric rollup | `idx_gmd_org_date` |
| `platform_conversion_claims` | Platform-reported conversion claims | `idx_pcc_platform`, `idx_pcc_click` |
| `reconciliation_daily_summary` | Platform vs actual reconciliation | `idx_rds_org_date` |
| `tracked_clicks` | Click tracking for attribution | `idx_tracked_clicks_unique` (UNIQUE on org, click_id, timestamp) |
| `tracking_link_clicks` | Tracking link click events | `idx_tlc_link`, `idx_tlc_org` |
| `tracking_link_daily_summary` | Tracking link daily rollup | `idx_tlds_org_date` |

#### Identity & Matching Tables (6 tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `customer_identities` | Master identity records | `email_hash`, `phone_hash`, `stripe_customer_id`, `shopify_customer_id`, `hubspot_contact_id`, `salesforce_contact_id`, `jobber_client_id` |
| `crm_identity_links` | CRM-to-identity links | `crm_contact_ref`, `identity_type`, `identity_value` |
| `identity_link_events` | Identity link audit trail | `source_identity_id`, `target_identity_id`, `link_type` |
| `handoff_patterns` | Learned handoff conversion patterns | `click_destination_hostname`, `conversion_source`, `match_rate` |
| `handoff_observations` | Individual handoff observations | `anonymous_id`, `click_destination_hostname`, `matched_conversion_id` |

**Note:** `handoff_patterns` and `handoff_observations` only exist locally (created by 0046, which is pending in production).

#### Revenue Source Tables (13 tables)

| Table | Source | Purpose |
|-------|--------|---------|
| `stripe_charges` | Stripe | Raw charge records |
| `stripe_subscriptions` | Stripe | Active subscriptions |
| `stripe_daily_summary` | Stripe | Daily revenue rollup |
| `shopify_orders` | Shopify | Raw order records |
| `shopify_refunds` | Shopify | Refund tracking |
| `shopify_daily_summary` | Shopify | Daily order rollup |
| `jobber_clients` | Jobber | Client records |
| `jobber_jobs` | Jobber | Job records |
| `jobber_invoices` | Jobber | Invoice records |
| `jobber_daily_summary` | Jobber | Daily job rollup |

---

## 5. Shard Databases (SHARD_0-3)

| Migration | Tables Created | Status |
|-----------|---------------|--------|
| `0001_platform_tables.sql` | Legacy Google/Facebook/TikTok tables | **DEPRECATED** |
| `0002_pre_aggregation_tables.sql` | `org_daily_summary`, `campaign_period_summary`, `platform_comparison`, `org_timeseries`, `aggregation_jobs` | Active |
| `0003_unified_ad_tables.sql` | `ad_campaigns`, `ad_groups`, `ads`, `ad_metrics` | Active |

All 4 shards have all 3 migrations applied in production. No local SQLite files exist for shards.

---

## 6. Findings & Anomalies

### CRITICAL

1. **Production ANALYTICS_DB is 1 migration behind** — `0046_handoff_patterns.sql` creates `handoff_patterns`, `handoff_observations`, and adds `conversions.handoff_observation_id`. Any production code referencing these will fail with "no such table/column".

### HIGH

2. ~~**Duplicate `cac_history` table**~~ — **RESOLVED** by `0008_drop_dead_cac_history.sql`. AI_DB copy dropped.

3. ~~**16 legacy platform-specific tables never written to**~~ — **RESOLVED** by `0047_drop_legacy_platform_tables.sql`. 16 tables dropped. `facebook_pages` intentionally retained (still actively written by facebook-ads-sync and read by API).

### MEDIUM

4. **`facebook_pages` has no unified equivalent** — All other legacy tables map to unified equivalents, but `facebook_pages` doesn't map to anything in the unified schema (0019-0033). Should map to `social_profiles` or a new dedicated table.

5. **64 scaffolded tables with zero rows** — Migrations 0022-0033 create tables for ecommerce, payments, support, scheduling, forms, events, analytics, accounting, attribution, reviews, affiliate, and social. Of these, only ecommerce (Shopify), payments (Stripe), and scheduling (Jobber) have active writers. The remaining ~40 tables are empty infrastructure.

6. **Shards have no local presence** — No SQLite files exist for SHARD_0-3 locally. The shard infrastructure (ShardRouter, DataWriter) exists in code but all reads still go through ANALYTICS_DB. Local testing cannot exercise shard paths.

### LOW

7. **DB migration numbering has intentional gaps** — 0017-0018 (used by ANALYTICS_DB), 0057-0059 (skipped), 0061-0064 (skipped). Not a bug, just namespace coordination across migration directories.

8. **`conversion_goals` is the most-altered table** — 38 columns accumulated across ~10 migrations. The schema reads like geological strata with inline ALTER TABLE fragments.

9. **Cron worker's own `.wrangler/state/` has 3 empty SQLite files** (4-8 KB each, no `d1_migrations` table). These are artifacts of `wrangler dev` creating empty databases before `--persist-to` redirects to the API's state. Harmless but could be confusing during debugging.

---

## 7. Index Coverage Summary

### DB (Main) — 117 indexes

**Well-indexed:** `conversion_goals` (5 indexes), `platform_connections` (4 indexes), `webhook_events` (6 indexes), `admin_tasks` (7 indexes), `auth_audit_logs` (7 indexes)

### AI_DB — 19 indexes

All tables have appropriate indexes. `attribution_model_results` has a UNIQUE composite index on `(organization_id, model, channel, computation_date)`.

### ANALYTICS_DB — 423 indexes

**Heaviest index counts:**
- `conversions` — 18 indexes (including 2 UNIQUE)
- `customer_identities` — 15 indexes
- `comm_engagements` — 8 indexes
- `journeys` — 7 indexes
- `ad_metrics` — 5 indexes

**UNIQUE indexes (deduplication guards):**
- `idx_conv_dedup_unique` on `conversions(organization_id, dedup_key)`
- `idx_conv_source_unique` on `conversions(organization_id, conversion_source, source_id)`
- `idx_ca_unique` on `conversion_attribution(organization_id, conversion_id, model, touchpoint_position)`
- `idx_goal_conversions_dedup` on `goal_conversions(organization_id, goal_id, source_event_id)`
- `idx_tracked_clicks_unique` on `tracked_clicks(organization_id, click_id, click_timestamp)`

---

## 8. Action Items

| Priority | Action | Command | Status |
|----------|--------|---------|--------|
| **P0** | Apply all pending production migrations | See commands below | **Local done, prod pending** |
| ~~P1~~ | ~~DROP `cac_history` from AI_DB~~ | `0008_drop_dead_cac_history.sql` | ✅ Applied locally |
| ~~P2~~ | ~~DROP 16 legacy platform tables~~ | `0047_drop_legacy_platform_tables.sql` | ✅ Applied locally |
| **P3** | Decide `facebook_pages` migration target | Map to `social_profiles` or retain | Open |

**Production apply commands (run from clearlift-api/):**
```bash
npx wrangler d1 migrations apply AI_DB --remote
npx wrangler d1 migrations apply ANALYTICS_DB --remote
```
