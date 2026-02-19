#!/usr/bin/env npx tsx
/**
 * Production → Local D1 Data Migration
 *
 * Exports every row from production D1 databases (DB, AI_DB, ANALYTICS_DB)
 * and imports them into the new consolidated local D1 (adbliss-core + adbliss-analytics-0).
 *
 * Table routing:
 *   DB tables              → adbliss-core (local DB)
 *   AI_DB tables           → adbliss-core (local DB)        [AI_DB merged into core]
 *   ANALYTICS_DB tables    → adbliss-analytics-0 (local ANALYTICS_DB)
 *
 * Tables that MOVE between databases:
 *   DB.identity_mappings   → ANALYTICS_DB  (identity data belongs with analytics)
 *   DB.identity_merges     → ANALYTICS_DB  (identity data belongs with analytics)
 *   DB.webhook_events      → ANALYTICS_DB  (event log, not config)
 *   AI_DB.attribution_model_results → ANALYTICS_DB (attribution data)
 *
 * Legacy tables TRANSFORMED (not copied):
 *   stripe_charges        → connector_transactions (source_platform='stripe')
 *   stripe_subscriptions  → connector_subscriptions (source_platform='stripe')
 *   shopify_orders         → connector_transactions (source_platform='shopify')
 *   shopify_refunds        → connector_items (source_platform='shopify', item_type='refund')
 *   jobber_jobs            → connector_transactions (source_platform='jobber')
 *   jobber_invoices        → connector_transactions (source_platform='jobber')
 *   jobber_clients         → connector_customers (source_platform='jobber')
 *   stripe_daily_summary   → skipped (regenerable from connector_transactions)
 *
 * Tables DROPPED (not migrated):
 *   DB.shard_routing           - shard system removed
 *   ANALYTICS_DB scaffolding   - 32 tables with 0 rows (dead code)
 *   ANALYTICS_DB dead per-cat  - 24 tables with 0 rows (replaced by connector_* tables)
 *   ANALYTICS_DB.ecommerce_orders - dead (2 rows, replaced by shopify_orders)
 *   ANALYTICS_DB.payments_transactions - dead per-category table (replaced by connector_transactions)
 *
 * Usage:
 *   cd clearlift-api
 *   npx tsx scripts/prod-to-local-migration.ts [--dry-run] [--skip-export] [--verify-only] [--tables ad_groups,stripe_charges] [--sample]
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const WORK_DIR = '/Users/work/Documents/Code/clearlift-api';
const EXPORT_DIR = path.join(WORK_DIR, '.migration-export');
const BATCH_SIZE = 50; // rows per INSERT batch for D1

// ============================================================================
// TABLE ROUTING MAP
// ============================================================================

type TableAction = 'copy' | 'drop' | 'skip_empty' | 'transform' | 'regenerate';

type TransformFn = (row: Record<string, any>) => Record<string, any>;

type TableRoute = {
  prodDb: string;      // 'clearlift-db-prod' | 'clearlift-ai-prod' | 'clearlift-analytics-prod'
  prodTable: string;
  localBinding: string; // 'DB' | 'ANALYTICS_DB'
  localTable: string;   // may differ if renamed
  prodRows: number;     // expected row count from census
  action: TableAction;
  notes?: string;
  // Transform-specific fields
  targetTable?: string;    // unified table to write into (e.g. 'connector_transactions')
  transformFn?: TransformFn;
};

// ============================================================================
// TRANSFORM FUNCTIONS — Legacy → Unified
// Matches field mappings from clearlift-cron sync workers
// ============================================================================

function ensureJsonString(val: any): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function normalizeStripeStatus(status: string): string {
  if (!status) return 'pending';
  const s = status.toLowerCase();
  if (s === 'succeeded' || s === 'paid') return 'succeeded';
  if (s === 'failed' || s === 'canceled') return 'failed';
  return 'pending';
}

function normalizeJobberStatus(jobStatus: string): string {
  if (!jobStatus) return 'pending';
  const s = jobStatus.toUpperCase();
  if (s === 'COMPLETED' || s === 'COMPLETED_LATE') return 'completed';
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'IN_PROGRESS' || s === 'ACTIVE') return 'in_progress';
  if (s === 'REQUIRES_INVOICING') return 'requires_invoicing';
  return 'pending';
}

// stripe_charges → connector_transactions
const transformStripeCharge: TransformFn = (row) => ({
  organization_id: row.organization_id,
  source_platform: 'stripe',
  event_type: 'charge',
  external_id: row.charge_id,
  customer_external_id: row.customer_id || null,
  customer_email_hash: row.customer_email_hash || null,
  value_cents: row.amount_cents || 0,
  refund_cents: row.refund_cents || 0,
  currency: row.currency || 'usd',
  status: normalizeStripeStatus(row.status),
  description: row.billing_reason || null,
  subscription_ref: row.subscription_id || null,
  metadata: ensureJsonString(row.metadata),
  properties: ensureJsonString(row.raw_data),
  transacted_at: row.stripe_created_at,
  created_at_platform: row.stripe_created_at,
});

// stripe_subscriptions → connector_subscriptions
const transformStripeSubscription: TransformFn = (row) => ({
  organization_id: row.organization_id,
  source_platform: 'stripe',
  external_id: row.subscription_id,
  customer_external_id: row.customer_id || null,
  status: row.status || 'unknown',
  plan_name: row.plan_name || null,
  amount_cents: row.plan_amount_cents || 0,
  interval_type: row.plan_interval || null,
  interval_count: row.plan_interval_count || 1,
  currency: row.currency || 'usd',
  trial_start: row.trial_start || null,
  trial_end: row.trial_end || null,
  current_period_start: row.current_period_start || null,
  current_period_end: row.current_period_end || null,
  cancel_at_period_end: row.cancel_at_period_end || 0,
  cancelled_at: row.canceled_at || null,
  metadata: ensureJsonString(row.metadata),
  properties: ensureJsonString(row.raw_data),
  started_at: row.stripe_created_at,
});

// shopify_orders → connector_transactions
const transformShopifyOrder: TransformFn = (row) => {
  const properties: Record<string, any> = {};
  if (row.gclid) properties.click_id = row.gclid, properties.click_id_type = 'gclid';
  else if (row.fbclid) properties.click_id = row.fbclid, properties.click_id_type = 'fbclid';
  else if (row.ttclid) properties.click_id = row.ttclid, properties.click_id_type = 'ttclid';
  if (row.utm_term) properties.utm_term = row.utm_term;
  if (row.utm_content) properties.utm_content = row.utm_content;
  if (row.order_number) properties.order_number = row.order_number;
  if (row.tags) properties.tags = row.tags;
  if (row.refund_cents) properties.refund_amount_cents = row.refund_cents;

  const metadata: Record<string, any> = {};
  if (row.raw_data) {
    try { Object.assign(metadata, JSON.parse(row.raw_data)); } catch { metadata.raw = row.raw_data; }
  }

  // Normalize financial_status → status
  let status = 'pending';
  const fs = (row.financial_status || '').toLowerCase();
  if (fs === 'paid' || fs === 'partially_paid') status = 'paid';
  else if (fs === 'refunded' || fs === 'partially_refunded') status = 'refunded';
  else if (fs === 'voided') status = 'cancelled';

  return {
    organization_id: row.organization_id,
    source_platform: 'shopify',
    event_type: 'order',
    external_id: row.shopify_order_id,
    customer_external_id: row.customer_id || null,
    customer_email_hash: row.customer_email_hash || null,
    value_cents: row.total_price_cents || 0,
    subtotal_cents: row.subtotal_price_cents || 0,
    discount_cents: row.total_discounts_cents || 0,
    shipping_cents: row.total_shipping_cents || 0,
    tax_cents: row.total_tax_cents || 0,
    refund_cents: row.refund_cents || 0,
    currency: row.currency || 'USD',
    status,
    financial_status: row.financial_status || null,
    fulfillment_status: row.fulfillment_status || null,
    item_count: row.line_items_count || 0,
    landing_url: row.landing_site || null,
    referring_site: row.referring_site || null,
    source_name: row.source_name || null,
    utm_source: row.utm_source || null,
    utm_medium: row.utm_medium || null,
    utm_campaign: row.utm_campaign || null,
    transacted_at: row.shopify_created_at,
    created_at_platform: row.shopify_created_at,
    cancelled_at: row.shopify_cancelled_at || null,
    properties: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
  };
};

// shopify_refunds → connector_items (item_type='refund')
const transformShopifyRefund: TransformFn = (row) => ({
  organization_id: row.organization_id,
  source_platform: 'shopify',
  item_type: 'refund',
  external_id: row.shopify_refund_id,
  parent_external_id: row.shopify_order_id || null,
  amount_cents: row.refund_amount_cents || 0,
  currency: row.currency || 'USD',
  reason: row.reason || null,
  properties: row.note ? JSON.stringify({ note: row.note }) : null,
});

// jobber_jobs → connector_transactions
const transformJobberJob: TransformFn = (row) => {
  const status = normalizeJobberStatus(row.job_status);
  const isCompleted = status === 'completed';

  const properties: Record<string, any> = {};
  if (row.job_number) properties.job_number = row.job_number;
  if (row.property_id) properties.property_id = row.property_id;
  if (row.lead_source) properties.lead_source = row.lead_source;

  return {
    organization_id: row.organization_id,
    source_platform: 'jobber',
    event_type: 'appointment',
    external_id: row.jobber_job_id,
    customer_external_id: row.client_id || null,
    customer_email_hash: row.client_email_hash || null,
    value_cents: row.total_amount_cents || 0,
    currency: row.currency || 'USD',
    status,
    payment_status: isCompleted ? 'paid' : 'pending',
    start_time: row.scheduled_start_at || row.jobber_created_at || null,
    end_time: row.actual_end_at || row.scheduled_end_at || null,
    transacted_at: row.completed_at || row.jobber_created_at,
    completed_at: row.completed_at || null,
    description: row.description || row.title || null,
    properties: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
    metadata: ensureJsonString(row.raw_data),
    created_at_platform: row.jobber_created_at,
  };
};

// jobber_invoices → connector_transactions
const transformJobberInvoice: TransformFn = (row) => {
  const isPaid = (row.status || '').toUpperCase() === 'PAID' || row.is_paid === 1;
  const status = isPaid ? 'paid' : 'pending';

  const properties: Record<string, any> = {};
  if (row.invoice_number) properties.invoice_number = row.invoice_number;
  if (row.jobber_job_id) properties.job_id = row.jobber_job_id;
  if (row.issue_date) properties.issue_date = row.issue_date;
  if (row.due_date) properties.due_date = row.due_date;

  return {
    organization_id: row.organization_id,
    source_platform: 'jobber',
    event_type: 'invoice',
    external_id: row.jobber_invoice_id,
    customer_external_id: row.client_id || null,
    customer_email_hash: row.client_email_hash || null,
    value_cents: row.total_cents || 0,
    net_cents: row.amount_paid_cents || 0,
    currency: row.currency || 'USD',
    status,
    payment_status: status,
    transacted_at: row.paid_at || row.jobber_created_at,
    completed_at: row.paid_at || null,
    properties: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
    metadata: ensureJsonString(row.raw_data),
    created_at_platform: row.jobber_created_at,
  };
};

// jobber_clients → connector_customers
const transformJobberClient: TransformFn = (row) => {
  const properties: Record<string, any> = {};
  if (row.street_address) properties.street_address = row.street_address;
  if (row.city) properties.city = row.city;
  if (row.state) properties.state = row.state;
  if (row.postal_code) properties.postal_code = row.postal_code;
  if (row.country) properties.country = row.country;

  return {
    organization_id: row.organization_id,
    source_platform: 'jobber',
    entity_type: 'person',
    external_id: row.jobber_client_id,
    email_hash: row.email_hash || null,
    phone_hash: row.phone_hash || null,
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    company_name: row.company_name || null,
    tags: ensureJsonString(row.tags),
    properties: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
    created_at_platform: row.jobber_created_at,
  };
};

// ============================================================================
// TABLE ROUTES
// ============================================================================

const TABLE_ROUTES: TableRoute[] = [
  // ============================================================================
  // DB → adbliss-core (DB) — DIRECT COPY
  // ============================================================================
  { prodDb: 'clearlift-db-prod', prodTable: 'users',                    localBinding: 'DB', localTable: 'users',                    prodRows: 44,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'sessions',                 localBinding: 'DB', localTable: 'sessions',                 prodRows: 73,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'organizations',            localBinding: 'DB', localTable: 'organizations',            prodRows: 41,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'organization_members',     localBinding: 'DB', localTable: 'organization_members',     prodRows: 46,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'terms_acceptance',         localBinding: 'DB', localTable: 'terms_acceptance',         prodRows: 38,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'invitations',              localBinding: 'DB', localTable: 'invitations',              prodRows: 6,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'onboarding_progress',      localBinding: 'DB', localTable: 'onboarding_progress',      prodRows: 36,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'onboarding_steps',         localBinding: 'DB', localTable: 'onboarding_steps',         prodRows: 4,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'platform_connections',     localBinding: 'DB', localTable: 'platform_connections',     prodRows: 44,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'connector_configs',        localBinding: 'DB', localTable: 'connector_configs',        prodRows: 35,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'connector_filter_rules',   localBinding: 'DB', localTable: 'connector_filter_rules',   prodRows: 17,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'org_tag_mappings',         localBinding: 'DB', localTable: 'org_tag_mappings',         prodRows: 41,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'tracking_domains',         localBinding: 'DB', localTable: 'tracking_domains',         prodRows: 9,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'tracking_links',           localBinding: 'DB', localTable: 'tracking_links',           prodRows: 1,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'script_hashes',            localBinding: 'DB', localTable: 'script_hashes',            prodRows: 21,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'conversion_goals',         localBinding: 'DB', localTable: 'conversion_goals',         prodRows: 19,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_relationships',       localBinding: 'DB', localTable: 'goal_relationships',       prodRows: 13,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_templates',           localBinding: 'DB', localTable: 'goal_templates',           prodRows: 19,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_conversion_stats',    localBinding: 'DB', localTable: 'goal_conversion_stats',    prodRows: 270,    action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'ai_optimization_settings', localBinding: 'DB', localTable: 'ai_optimization_settings', prodRows: 35,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'dashboard_layouts',        localBinding: 'DB', localTable: 'dashboard_layouts',        prodRows: 18,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'sync_jobs',                localBinding: 'DB', localTable: 'sync_jobs',                prodRows: 150983, action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'event_sync_watermarks',    localBinding: 'DB', localTable: 'event_sync_watermarks',    prodRows: 51,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'active_event_workflows',   localBinding: 'DB', localTable: 'active_event_workflows',   prodRows: 0,      action: 'skip_empty', notes: 'Table empty in prod (confirmed Feb 2026)' },
  { prodDb: 'clearlift-db-prod', prodTable: 'active_shopify_workflows', localBinding: 'DB', localTable: 'active_shopify_workflows', prodRows: 2,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'webhook_endpoints',        localBinding: 'DB', localTable: 'webhook_endpoints',        prodRows: 0,      action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'admin_invites',            localBinding: 'DB', localTable: 'admin_invites',            prodRows: 6,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'audit_logs',               localBinding: 'DB', localTable: 'audit_logs',               prodRows: 20348,  action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'security_events',          localBinding: 'DB', localTable: 'security_events',          prodRows: 77,     action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'email_verification_tokens', localBinding: 'DB', localTable: 'email_verification_tokens', prodRows: 44,   action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'password_reset_tokens',    localBinding: 'DB', localTable: 'password_reset_tokens',    prodRows: 5,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'rate_limits',              localBinding: 'DB', localTable: 'rate_limits',              prodRows: 122,    action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'waitlist',                 localBinding: 'DB', localTable: 'waitlist',                 prodRows: 5,      action: 'copy' },
  { prodDb: 'clearlift-db-prod', prodTable: 'stripe_metadata_keys',     localBinding: 'DB', localTable: 'stripe_metadata_keys',     prodRows: 0,      action: 'skip_empty' },

  // DB → ANALYTICS_DB (MOVED tables)
  { prodDb: 'clearlift-db-prod', prodTable: 'identity_mappings',  localBinding: 'ANALYTICS_DB', localTable: 'identity_mappings',  prodRows: 0, action: 'skip_empty', notes: 'MOVED: DB→ANALYTICS_DB' },
  { prodDb: 'clearlift-db-prod', prodTable: 'identity_merges',    localBinding: 'ANALYTICS_DB', localTable: 'identity_merges',    prodRows: 0, action: 'skip_empty', notes: 'MOVED: DB→ANALYTICS_DB' },
  { prodDb: 'clearlift-db-prod', prodTable: 'webhook_events',     localBinding: 'ANALYTICS_DB', localTable: 'webhook_events',     prodRows: 0, action: 'skip_empty', notes: 'MOVED: DB→ANALYTICS_DB' },

  // DB DROPPED
  { prodDb: 'clearlift-db-prod', prodTable: 'shard_routing',      localBinding: 'DB', localTable: 'shard_routing',      prodRows: 36, action: 'drop', notes: 'Shard system removed' },
  // These have 0 rows in prod:
  { prodDb: 'clearlift-db-prod', prodTable: 'admin_impersonation_logs', localBinding: 'DB', localTable: 'admin_impersonation_logs', prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'admin_tasks',              localBinding: 'DB', localTable: 'admin_tasks',              prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'admin_task_comments',      localBinding: 'DB', localTable: 'admin_task_comments',      prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'auth_audit_logs',          localBinding: 'DB', localTable: 'auth_audit_logs',          prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'config_audit_logs',        localBinding: 'DB', localTable: 'config_audit_logs',        prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'consent_configurations',   localBinding: 'DB', localTable: 'consent_configurations',   prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'data_access_logs',         localBinding: 'DB', localTable: 'data_access_logs',         prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_branches',            localBinding: 'DB', localTable: 'goal_branches',            prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_group_members',       localBinding: 'DB', localTable: 'goal_group_members',       prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_groups',              localBinding: 'DB', localTable: 'goal_groups',              prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'goal_value_history',       localBinding: 'DB', localTable: 'goal_value_history',       prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'oauth_states',             localBinding: 'DB', localTable: 'oauth_states',             prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-db-prod', prodTable: 'org_tracking_configs',     localBinding: 'DB', localTable: 'org_tracking_configs',     prodRows: 0, action: 'skip_empty' },

  // ============================================================================
  // AI_DB → adbliss-core (DB) — MERGED INTO CORE
  // ============================================================================
  { prodDb: 'clearlift-ai-prod', prodTable: 'ai_decisions',       localBinding: 'DB', localTable: 'ai_decisions',       prodRows: 577,  action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'ai_tool_registry',   localBinding: 'DB', localTable: 'ai_tool_registry',   prodRows: 7,    action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'analysis_jobs',      localBinding: 'DB', localTable: 'analysis_jobs',      prodRows: 39,   action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'analysis_logs',      localBinding: 'DB', localTable: 'analysis_logs',      prodRows: 2295, action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'analysis_prompts',   localBinding: 'DB', localTable: 'analysis_prompts',   prodRows: 5,    action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'analysis_summaries', localBinding: 'DB', localTable: 'analysis_summaries', prodRows: 2292, action: 'copy', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'cac_baselines',      localBinding: 'DB', localTable: 'cac_baselines',      prodRows: 0,    action: 'skip_empty', notes: 'AI_DB merged into core' },
  { prodDb: 'clearlift-ai-prod', prodTable: 'cac_predictions',    localBinding: 'DB', localTable: 'cac_predictions',    prodRows: 0,    action: 'skip_empty', notes: 'AI_DB merged into core' },

  // AI_DB → ANALYTICS_DB (MOVED)
  { prodDb: 'clearlift-ai-prod', prodTable: 'attribution_model_results', localBinding: 'ANALYTICS_DB', localTable: 'attribution_model_results', prodRows: 0, action: 'skip_empty', notes: 'MOVED: AI_DB→ANALYTICS_DB' },

  // ============================================================================
  // ANALYTICS_DB → adbliss-analytics-0 (ANALYTICS_DB) — DIRECT COPY (live tables)
  // ============================================================================
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ad_campaigns',              localBinding: 'ANALYTICS_DB', localTable: 'ad_campaigns',              prodRows: 2323,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ad_groups',                 localBinding: 'ANALYTICS_DB', localTable: 'ad_groups',                 prodRows: 2790,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ads',                       localBinding: 'ANALYTICS_DB', localTable: 'ads',                       prodRows: 7573,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ad_metrics',                localBinding: 'ANALYTICS_DB', localTable: 'ad_metrics',                prodRows: 101036, action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'facebook_pages',            localBinding: 'ANALYTICS_DB', localTable: 'facebook_pages',            prodRows: 119,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'customer_identities',       localBinding: 'ANALYTICS_DB', localTable: 'customer_identities',       prodRows: 580,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'conversions',               localBinding: 'ANALYTICS_DB', localTable: 'conversions',               prodRows: 3599,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'conversion_daily_summary',  localBinding: 'ANALYTICS_DB', localTable: 'conversion_daily_summary',  prodRows: 61,    action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'conversion_value_allocations', localBinding: 'ANALYTICS_DB', localTable: 'conversion_value_allocations', prodRows: 2399, action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'goal_conversions',          localBinding: 'ANALYTICS_DB', localTable: 'goal_conversions',          prodRows: 26348, action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'goal_metrics_daily',        localBinding: 'ANALYTICS_DB', localTable: 'goal_metrics_daily',        prodRows: 115,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'goal_completion_metrics',   localBinding: 'ANALYTICS_DB', localTable: 'goal_completion_metrics',   prodRows: 23,    action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'journeys',                  localBinding: 'ANALYTICS_DB', localTable: 'journeys',                  prodRows: 34204, action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'journey_analytics',         localBinding: 'ANALYTICS_DB', localTable: 'journey_analytics',         prodRows: 186,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'attribution_results',       localBinding: 'ANALYTICS_DB', localTable: 'attribution_results',       prodRows: 1577,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'channel_transitions',       localBinding: 'ANALYTICS_DB', localTable: 'channel_transitions',       prodRows: 1609,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'funnel_transitions',        localBinding: 'ANALYTICS_DB', localTable: 'funnel_transitions',        prodRows: 4993,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'cac_history',               localBinding: 'ANALYTICS_DB', localTable: 'cac_history',               prodRows: 511,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'daily_metrics',             localBinding: 'ANALYTICS_DB', localTable: 'daily_metrics',             prodRows: 710,   action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'hourly_metrics',            localBinding: 'ANALYTICS_DB', localTable: 'hourly_metrics',            prodRows: 3351,  action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'utm_performance',           localBinding: 'ANALYTICS_DB', localTable: 'utm_performance',           prodRows: 24688, action: 'copy' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'sync_watermarks',           localBinding: 'ANALYTICS_DB', localTable: 'sync_watermarks',           prodRows: 77,    action: 'copy' },

  // ============================================================================
  // Legacy tables — TRANSFORMED into unified connector_* tables
  // ============================================================================
  { prodDb: 'clearlift-analytics-prod', prodTable: 'stripe_charges',       localBinding: 'ANALYTICS_DB', localTable: 'stripe_charges',       prodRows: 7181, action: 'transform', targetTable: 'connector_transactions',  transformFn: transformStripeCharge,       notes: 'Legacy → connector_transactions (stripe)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'stripe_subscriptions', localBinding: 'ANALYTICS_DB', localTable: 'stripe_subscriptions', prodRows: 0,    action: 'transform', targetTable: 'connector_subscriptions', transformFn: transformStripeSubscription, notes: 'Legacy → connector_subscriptions (stripe)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'shopify_orders',       localBinding: 'ANALYTICS_DB', localTable: 'shopify_orders',       prodRows: 2,    action: 'transform', targetTable: 'connector_transactions',  transformFn: transformShopifyOrder,       notes: 'Legacy → connector_transactions (shopify)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'shopify_refunds',      localBinding: 'ANALYTICS_DB', localTable: 'shopify_refunds',      prodRows: 0,    action: 'transform', targetTable: 'connector_items',         transformFn: transformShopifyRefund,      notes: 'Legacy → connector_items (shopify refund)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'jobber_jobs',          localBinding: 'ANALYTICS_DB', localTable: 'jobber_jobs',          prodRows: 0,    action: 'transform', targetTable: 'connector_transactions',  transformFn: transformJobberJob,          notes: 'Legacy → connector_transactions (jobber)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'jobber_invoices',      localBinding: 'ANALYTICS_DB', localTable: 'jobber_invoices',      prodRows: 0,    action: 'transform', targetTable: 'connector_transactions',  transformFn: transformJobberInvoice,      notes: 'Legacy → connector_transactions (jobber)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'jobber_clients',       localBinding: 'ANALYTICS_DB', localTable: 'jobber_clients',       prodRows: 0,    action: 'transform', targetTable: 'connector_customers',     transformFn: transformJobberClient,       notes: 'Legacy → connector_customers (jobber)' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'stripe_daily_summary', localBinding: 'ANALYTICS_DB', localTable: 'stripe_daily_summary', prodRows: 38,   action: 'regenerate', notes: 'Regenerable from connector_transactions — skip' },

  // ============================================================================
  // ANALYTICS_DB — DROPPED (scaffolding + dead per-category, all 0 rows)
  // ============================================================================
  // Scaffolding (0 rows)
  { prodDb: 'clearlift-analytics-prod', prodTable: 'accounting_customers',    localBinding: 'ANALYTICS_DB', localTable: 'accounting_customers',    prodRows: 0, action: 'drop', notes: 'Scaffolding: no sync worker' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'accounting_expenses',     localBinding: 'ANALYTICS_DB', localTable: 'accounting_expenses',     prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'accounting_invoices',     localBinding: 'ANALYTICS_DB', localTable: 'accounting_invoices',     prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'affiliate_conversions',   localBinding: 'ANALYTICS_DB', localTable: 'affiliate_conversions',   prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'affiliate_partners',      localBinding: 'ANALYTICS_DB', localTable: 'affiliate_partners',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'affiliate_referrals',     localBinding: 'ANALYTICS_DB', localTable: 'affiliate_referrals',     prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'analytics_events',        localBinding: 'ANALYTICS_DB', localTable: 'analytics_events',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'analytics_sessions',      localBinding: 'ANALYTICS_DB', localTable: 'analytics_sessions',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'analytics_users',         localBinding: 'ANALYTICS_DB', localTable: 'analytics_users',         prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'attribution_events',      localBinding: 'ANALYTICS_DB', localTable: 'attribution_events',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'attribution_installs',    localBinding: 'ANALYTICS_DB', localTable: 'attribution_installs',    prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'attribution_revenue',     localBinding: 'ANALYTICS_DB', localTable: 'attribution_revenue',     prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'comm_campaigns',          localBinding: 'ANALYTICS_DB', localTable: 'comm_campaigns',          prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'comm_engagements',        localBinding: 'ANALYTICS_DB', localTable: 'comm_engagements',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'comm_subscribers',        localBinding: 'ANALYTICS_DB', localTable: 'comm_subscribers',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'events_attendees',        localBinding: 'ANALYTICS_DB', localTable: 'events_attendees',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'events_definitions',      localBinding: 'ANALYTICS_DB', localTable: 'events_definitions',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'events_registrations',    localBinding: 'ANALYTICS_DB', localTable: 'events_registrations',    prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'forms_definitions',       localBinding: 'ANALYTICS_DB', localTable: 'forms_definitions',       prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'forms_responses',         localBinding: 'ANALYTICS_DB', localTable: 'forms_responses',         prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'forms_submissions',       localBinding: 'ANALYTICS_DB', localTable: 'forms_submissions',       prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'reviews_items',           localBinding: 'ANALYTICS_DB', localTable: 'reviews_items',           prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'reviews_profiles',        localBinding: 'ANALYTICS_DB', localTable: 'reviews_profiles',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'reviews_responses',       localBinding: 'ANALYTICS_DB', localTable: 'reviews_responses',       prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'social_followers',        localBinding: 'ANALYTICS_DB', localTable: 'social_followers',        prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'social_metrics',          localBinding: 'ANALYTICS_DB', localTable: 'social_metrics',          prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'social_posts',            localBinding: 'ANALYTICS_DB', localTable: 'social_posts',            prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'social_profiles',         localBinding: 'ANALYTICS_DB', localTable: 'social_profiles',         prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'support_conversations',   localBinding: 'ANALYTICS_DB', localTable: 'support_conversations',   prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'support_customers',       localBinding: 'ANALYTICS_DB', localTable: 'support_customers',       prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'support_tickets',         localBinding: 'ANALYTICS_DB', localTable: 'support_tickets',         prodRows: 0, action: 'drop' },

  // Dead per-category connector tables (all 0 rows, replaced by connector_* tables)
  { prodDb: 'clearlift-analytics-prod', prodTable: 'crm_activities',          localBinding: 'ANALYTICS_DB', localTable: 'crm_activities',          prodRows: 0, action: 'drop', notes: 'Dead: replaced by connector_activities' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'crm_companies',           localBinding: 'ANALYTICS_DB', localTable: 'crm_companies',           prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'crm_contacts',            localBinding: 'ANALYTICS_DB', localTable: 'crm_contacts',            prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'crm_deals',               localBinding: 'ANALYTICS_DB', localTable: 'crm_deals',               prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ecommerce_customers',     localBinding: 'ANALYTICS_DB', localTable: 'ecommerce_customers',     prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ecommerce_products',      localBinding: 'ANALYTICS_DB', localTable: 'ecommerce_products',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'payments_customers',      localBinding: 'ANALYTICS_DB', localTable: 'payments_customers',      prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'payments_subscriptions',  localBinding: 'ANALYTICS_DB', localTable: 'payments_subscriptions',  prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'scheduling_appointments', localBinding: 'ANALYTICS_DB', localTable: 'scheduling_appointments', prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'scheduling_customers',    localBinding: 'ANALYTICS_DB', localTable: 'scheduling_customers',    prodRows: 0, action: 'drop' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'scheduling_services',     localBinding: 'ANALYTICS_DB', localTable: 'scheduling_services',     prodRows: 0, action: 'drop' },

  // Ambiguous tables with data — keeping as analytics copies
  { prodDb: 'clearlift-analytics-prod', prodTable: 'payments_transactions',   localBinding: 'ANALYTICS_DB', localTable: 'payments_transactions',   prodRows: 7089, action: 'drop', notes: 'Dead per-category table — replaced by connector_transactions. 7089 rows are legacy Stripe data already in stripe_charges.' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'ecommerce_orders',        localBinding: 'ANALYTICS_DB', localTable: 'ecommerce_orders',        prodRows: 2,    action: 'drop', notes: 'Dead per-category table — 2 rows are copies from shopify_orders.' },

  // Tables with 0 rows (infra/analytics, exist in new schema but empty)
  { prodDb: 'clearlift-analytics-prod', prodTable: 'aggregation_jobs',        localBinding: 'ANALYTICS_DB', localTable: 'aggregation_jobs',        prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'campaign_period_summary', localBinding: 'ANALYTICS_DB', localTable: 'campaign_period_summary', prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'connector_sync_status',   localBinding: 'ANALYTICS_DB', localTable: 'connector_sync_status',   prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'conversion_attribution',  localBinding: 'ANALYTICS_DB', localTable: 'conversion_attribution',  prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'domain_claims',           localBinding: 'ANALYTICS_DB', localTable: 'domain_claims',           prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'handoff_observations',    localBinding: 'ANALYTICS_DB', localTable: 'handoff_observations',    prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'handoff_patterns',        localBinding: 'ANALYTICS_DB', localTable: 'handoff_patterns',        prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'identity_link_events',    localBinding: 'ANALYTICS_DB', localTable: 'identity_link_events',    prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'journey_touchpoints',     localBinding: 'ANALYTICS_DB', localTable: 'journey_touchpoints',     prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'org_daily_summary',       localBinding: 'ANALYTICS_DB', localTable: 'org_daily_summary',       prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'org_timeseries',          localBinding: 'ANALYTICS_DB', localTable: 'org_timeseries',          prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'platform_comparison',     localBinding: 'ANALYTICS_DB', localTable: 'platform_comparison',     prodRows: 0, action: 'skip_empty' },
  { prodDb: 'clearlift-analytics-prod', prodTable: 'tracked_clicks',          localBinding: 'ANALYTICS_DB', localTable: 'tracked_clicks',          prodRows: 0, action: 'skip_empty' },
];

// ============================================================================
// SCHEMA COLUMN DIFFS
// ============================================================================
const EXCLUDED_COLUMNS: Record<string, string[]> = {
  // No known column exclusions — the new schema is a superset of prod
};

// ============================================================================
// HELPERS
// ============================================================================

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function execOnce(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd || WORK_DIR,
      encoding: 'utf-8',
      timeout: opts?.timeout || 30000,
      maxBuffer: 50 * 1024 * 1024, // 50MB — large JSON blobs in raw_data columns (stripe_charges, ad_groups)
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    // Wrangler puts warnings on stderr even on success
    if (stdout.includes('"results"') && !stderr.includes('SQLITE_ERROR')) {
      return stdout;
    }
    throw new Error(`Command failed: ${cmd}\nstderr: ${stderr}\nstdout: ${stdout}`);
  }
}

function exec(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  const MAX_RETRIES = 3;
  const isRemote = cmd.includes('--remote');
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return execOnce(cmd, opts);
    } catch (e: any) {
      const msg = e.message || '';
      const isRateLimit = msg.includes('429') || msg.includes('rate limit') ||
        msg.includes('A request to the Clo') || msg.includes('A fetch r') ||
        msg.includes('A request to the Cloudflare');
      if (isRemote && isRateLimit && attempt < MAX_RETRIES) {
        const delay = attempt * 5; // 5s, 10s
        log(`  RATE LIMITED (attempt ${attempt}/${MAX_RETRIES}), waiting ${delay}s...`);
        execSync(`sleep ${delay}`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`exec: unreachable`);
}

function parseD1Results(output: string): any[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  try {
    const json = JSON.parse(output.substring(start, end + 1));
    return json[0]?.results || [];
  } catch {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (Array.isArray(parsed)) return parsed[0]?.results || [];
      } catch { /* skip */ }
    }
    return [];
  }
}

function escapeSQL(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  const s = String(val);
  return `'${s.replace(/'/g, "''")}'`;
}

function getColumns(prodDb: string, table: string): string[] {
  const output = exec(
    `npx wrangler d1 execute ${prodDb} --remote --command "PRAGMA table_info(${table})"`,
    { timeout: 15000 }
  );
  const results = parseD1Results(output);
  return results.map((r: any) => r.name);
}

function getLocalColumns(binding: string, table: string): string[] {
  const output = exec(
    `npx wrangler d1 execute ${binding} --local --env local --command "PRAGMA table_info(${table})"`,
    { timeout: 15000 }
  );
  const results = parseD1Results(output);
  return results.map((r: any) => r.name);
}

function exportTable(prodDb: string, table: string, offset: number, limit: number): any[] {
  const output = exec(
    `npx wrangler d1 execute ${prodDb} --remote --command "SELECT * FROM ${table} LIMIT ${limit} OFFSET ${offset}"`,
    { timeout: 60000 }
  );
  return parseD1Results(output);
}

function countLocal(binding: string, table: string): number {
  const output = exec(
    `npx wrangler d1 execute ${binding} --local --env local --command "SELECT COUNT(*) as c FROM ${table}"`,
    { timeout: 15000 }
  );
  const results = parseD1Results(output);
  return results[0]?.c || 0;
}

function countLocalFiltered(binding: string, table: string, sourcePlatform: string): number {
  const output = exec(
    `npx wrangler d1 execute ${binding} --local --env local --command "SELECT COUNT(*) as c FROM ${table} WHERE source_platform = '${sourcePlatform}'"`,
    { timeout: 15000 }
  );
  const results = parseD1Results(output);
  return results[0]?.c || 0;
}

function importBatch(binding: string, table: string, columns: string[], rows: any[]): void {
  if (rows.length === 0) return;

  const colList = columns.join(', ');
  const statements: string[] = [];

  for (const row of rows) {
    const values = columns.map(col => escapeSQL(row[col])).join(', ');
    statements.push(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${values});`);
  }

  const tmpFile = path.join(EXPORT_DIR, `import_${binding}_${table}.sql`);
  fs.writeFileSync(tmpFile, statements.join('\n'));

  exec(
    `npx wrangler d1 execute ${binding} --local --env local --file ${tmpFile} 2>&1`,
    { timeout: 60000 }
  );

  fs.unlinkSync(tmpFile);
}

function importTransformedBatch(binding: string, targetTable: string, rows: Record<string, any>[]): void {
  if (rows.length === 0) return;

  // All transformed rows have the same keys
  const columns = Object.keys(rows[0]);
  const colList = columns.join(', ');
  const statements: string[] = [];

  for (const row of rows) {
    const values = columns.map(col => escapeSQL(row[col])).join(', ');
    statements.push(`INSERT OR IGNORE INTO ${targetTable} (${colList}) VALUES (${values});`);
  }

  const tmpFile = path.join(EXPORT_DIR, `import_transform_${binding}_${targetTable}_${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, statements.join('\n'));

  exec(
    `npx wrangler d1 execute ${binding} --local --env local --file ${tmpFile} 2>&1`,
    { timeout: 60000 }
  );

  fs.unlinkSync(tmpFile);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipExport = args.includes('--skip-export');
  const verifyOnly = args.includes('--verify-only');
  const sampleMode = args.includes('--sample');
  const SAMPLE_LIMIT = 100;

  // --tables ad_groups,stripe_charges — selective re-run (skips Phase 1 reset)
  const tablesIdx = args.indexOf('--tables');
  const tablesFilter: string[] | null = tablesIdx !== -1 && args[tablesIdx + 1]
    ? args[tablesIdx + 1].split(',').map(t => t.trim())
    : null;

  log('=== Production → Local D1 Data Migration ===');
  log(`Mode: ${dryRun ? 'DRY RUN' : verifyOnly ? 'VERIFY ONLY' : 'LIVE'}${sampleMode ? ' [SAMPLE: 100 rows/table]' : ''}${tablesFilter ? ` [TABLES: ${tablesFilter.join(', ')}]` : ''}`);

  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const stats = {
    copied: 0,
    transformed: 0,
    dropped: 0,
    skipped_empty: 0,
    regenerable: 0,
    rows_exported: 0,
    rows_imported: 0,
    rows_transformed: 0,
    rows_regenerable: 0,
    errors: [] as string[],
    mismatches: [] as string[],
  };

  const tableMatch = (r: TableRoute) => !tablesFilter || tablesFilter.includes(r.prodTable);
  const copyRoutes = TABLE_ROUTES.filter(r => r.action === 'copy' && tableMatch(r));
  const transformRoutes = TABLE_ROUTES.filter(r => r.action === 'transform' && tableMatch(r));
  const regenerateRoutes = TABLE_ROUTES.filter(r => r.action === 'regenerate' && tableMatch(r));
  const dropRoutes = TABLE_ROUTES.filter(r => r.action === 'drop');
  const skipRoutes = TABLE_ROUTES.filter(r => r.action === 'skip_empty');

  log(`\nRouting: ${copyRoutes.length} copy, ${transformRoutes.length} transform, ${regenerateRoutes.length} regenerate, ${dropRoutes.length} drop, ${skipRoutes.length} skip`);
  log(`Expected rows to copy:      ${copyRoutes.reduce((sum, r) => sum + r.prodRows, 0).toLocaleString()}`);
  log(`Expected rows to transform:  ${transformRoutes.reduce((sum, r) => sum + r.prodRows, 0).toLocaleString()}`);
  log(`Rows regenerable (skipped):  ${regenerateRoutes.reduce((sum, r) => sum + r.prodRows, 0).toLocaleString()}`);
  log(`Rows intentionally dropped:  ${dropRoutes.reduce((sum, r) => sum + r.prodRows, 0).toLocaleString()}`);

  // Print drop manifest
  log('\n--- DROPPED TABLES (not migrated) ---');
  for (const r of dropRoutes.filter(r => r.prodRows > 0)) {
    log(`  DROP ${r.prodDb}/${r.prodTable} (${r.prodRows} rows) — ${r.notes || 'dead code'}`);
  }

  // Print transform manifest
  log('\n--- TRANSFORM TABLES (legacy → unified) ---');
  for (const r of transformRoutes) {
    log(`  TRANSFORM ${r.prodTable} → ${r.targetTable} (${r.prodRows} rows) — ${r.notes || ''}`);
  }

  // Print regenerate manifest
  log('\n--- REGENERABLE TABLES (skipped) ---');
  for (const r of regenerateRoutes) {
    log(`  REGENERATE ${r.prodTable} (${r.prodRows} rows) — ${r.notes || ''}`);
  }

  if (dryRun) {
    log('\n--- DRY RUN: Table routing ---');
    for (const r of copyRoutes) {
      const move = (r.prodDb === 'clearlift-db-prod' && r.localBinding === 'ANALYTICS_DB') ||
                   (r.prodDb === 'clearlift-ai-prod' && r.localBinding === 'ANALYTICS_DB') ? ' [MOVED]' : '';
      const merge = r.prodDb === 'clearlift-ai-prod' && r.localBinding === 'DB' ? ' [MERGED from AI_DB]' : '';
      log(`  COPY ${r.prodDb}/${r.prodTable} → ${r.localBinding}/${r.localTable} (${r.prodRows} rows)${move}${merge}`);
    }
    for (const r of transformRoutes) {
      log(`  TRANSFORM ${r.prodDb}/${r.prodTable} → ${r.localBinding}/${r.targetTable} (${r.prodRows} rows)`);
    }
    for (const r of regenerateRoutes) {
      log(`  REGENERATE ${r.prodDb}/${r.prodTable} (${r.prodRows} rows) — skipped`);
    }
    return;
  }

  if (verifyOnly) {
    log('\n--- VERIFICATION MODE ---');

    // Verify copy routes
    for (const r of copyRoutes) {
      try {
        const localCount = countLocal(r.localBinding, r.localTable);
        const expected = sampleMode ? Math.min(SAMPLE_LIMIT, r.prodRows) : r.prodRows;
        const match = localCount === expected;
        const status = match ? 'OK' : 'MISMATCH';
        log(`  ${status}: ${r.localBinding}/${r.localTable} — expected=${expected}, local=${localCount}`);
        if (!match) stats.mismatches.push(`${r.localBinding}/${r.localTable}: expected=${expected} local=${localCount}`);
      } catch (e: any) {
        log(`  ERROR: ${r.localBinding}/${r.localTable} — ${e.message?.substring(0, 100)}`);
        stats.errors.push(`${r.localBinding}/${r.localTable}: ${e.message?.substring(0, 100)}`);
      }
    }

    // Verify transform routes: check unified tables by source_platform
    log('\n--- TRANSFORM VERIFICATION ---');
    for (const r of transformRoutes) {
      if (r.prodRows === 0) {
        log(`  SKIP (0 rows): ${r.prodTable}`);
        continue;
      }
      try {
        // Determine source_platform from the transform function
        const sourcePlatform = r.prodTable.startsWith('stripe_') ? 'stripe'
          : r.prodTable.startsWith('shopify_') ? 'shopify'
          : r.prodTable.startsWith('jobber_') ? 'jobber'
          : 'unknown';

        const localCount = countLocalFiltered(r.localBinding, r.targetTable!, sourcePlatform);
        const expected = sampleMode ? Math.min(SAMPLE_LIMIT, r.prodRows) : r.prodRows;
        const match = localCount === expected;
        const status = match ? 'OK' : 'MISMATCH';
        log(`  ${status}: ${r.targetTable} WHERE source_platform='${sourcePlatform}' — expected=${expected}, local=${localCount}`);
        if (!match) stats.mismatches.push(`${r.targetTable}[${sourcePlatform}]: expected=${expected} local=${localCount}`);
      } catch (e: any) {
        log(`  ERROR: ${r.targetTable} — ${e.message?.substring(0, 100)}`);
        stats.errors.push(`${r.targetTable}: ${e.message?.substring(0, 100)}`);
      }
    }

    // Verify legacy tables are empty
    log('\n--- LEGACY TABLE VERIFICATION (should be 0) ---');
    const legacyTables = ['stripe_charges', 'stripe_subscriptions', 'stripe_daily_summary',
                          'shopify_orders', 'shopify_refunds',
                          'jobber_jobs', 'jobber_invoices', 'jobber_clients'];
    for (const table of legacyTables) {
      try {
        const localCount = countLocal('ANALYTICS_DB', table);
        const status = localCount === 0 ? 'OK' : 'NOT EMPTY';
        log(`  ${status}: ${table} — ${localCount} rows`);
        if (localCount !== 0) stats.mismatches.push(`Legacy ${table} not empty: ${localCount} rows`);
      } catch (e: any) {
        log(`  ERROR: ${table} — ${e.message?.substring(0, 100)}`);
      }
    }

    log(`\nVerification: ${stats.mismatches.length} mismatches, ${stats.errors.length} errors`);
    if (stats.mismatches.length > 0) {
      log('Mismatches:');
      stats.mismatches.forEach(m => log(`  ${m}`));
    }
    return;
  }

  // ============================================================================
  // PHASE 1: Clear local D1 and re-apply migrations
  // ============================================================================
  if (tablesFilter) {
    log('\n=== Phase 1: SKIPPED (--tables mode, preserving existing local D1) ===');
  } else {
    log('\n=== Phase 1: Reset local D1 ===');

    const stateDir = path.join(WORK_DIR, '.wrangler/state/v3/d1');
    if (fs.existsSync(stateDir)) {
      log('Clearing old local D1 state...');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    log('Applying core migrations...');
    exec('npx wrangler d1 migrations apply DB --local --env local 2>&1', { timeout: 30000 });

    log('Applying analytics migrations...');
    exec('npx wrangler d1 migrations apply ANALYTICS_DB --local --env local 2>&1', { timeout: 30000 });

    const dbTableCount = countLocal('DB', 'sqlite_master');
    const analyticsTableCount = countLocal('ANALYTICS_DB', 'sqlite_master');
    log(`Local DB: ${dbTableCount} objects, ANALYTICS_DB: ${analyticsTableCount} objects`);
  }

  // ============================================================================
  // PHASE 2: Export from prod and import to local
  // ============================================================================
  log('\n=== Phase 2: Migrate data ===');

  // --- 2a: Copy routes (unchanged) ---
  for (const route of copyRoutes) {
    const { prodDb, prodTable, localBinding, localTable, prodRows } = route;

    if (prodRows === 0) {
      log(`SKIP (0 rows): ${prodDb}/${prodTable}`);
      stats.skipped_empty++;
      continue;
    }

    const maxRows = sampleMode ? Math.min(SAMPLE_LIMIT, prodRows) : prodRows;
    log(`\nCOPY: ${prodDb}/${prodTable} → ${localBinding}/${localTable} (${maxRows.toLocaleString()} rows${sampleMode ? ' SAMPLE' : ''})`);

    try {
      const prodCols = getColumns(prodDb, prodTable);

      let localCols: string[];
      try {
        localCols = getLocalColumns(localBinding, localTable);
      } catch {
        log(`  WARNING: Table ${localTable} does not exist in local ${localBinding}. Skipping.`);
        stats.errors.push(`Table ${localTable} missing in local ${localBinding}`);
        continue;
      }

      const excluded = EXCLUDED_COLUMNS[prodTable] || [];
      const commonCols = prodCols.filter(c => localCols.includes(c) && !excluded.includes(c));
      const prodOnly = prodCols.filter(c => !localCols.includes(c));
      const localOnly = localCols.filter(c => !prodCols.includes(c));

      if (prodOnly.length > 0) {
        log(`  SCHEMA: prod-only columns (skipped): ${prodOnly.join(', ')}`);
      }
      if (localOnly.length > 0) {
        log(`  SCHEMA: local-only columns (will use defaults): ${localOnly.join(', ')}`);
      }

      const PAGE_SIZE = sampleMode ? SAMPLE_LIMIT : 500;
      let offset = 0;
      let totalExported = 0;

      while (offset < maxRows + PAGE_SIZE) {
        const limit = sampleMode ? SAMPLE_LIMIT : PAGE_SIZE;
        const rows = exportTable(prodDb, prodTable, offset, limit);
        if (rows.length === 0) break;

        importBatch(localBinding, localTable, commonCols, rows);

        totalExported += rows.length;
        offset += PAGE_SIZE;

        if (totalExported % 5000 === 0 || rows.length < PAGE_SIZE) {
          log(`  Progress: ${totalExported.toLocaleString()} / ~${maxRows.toLocaleString()} rows`);
        }

        if (rows.length < PAGE_SIZE || (sampleMode && totalExported >= SAMPLE_LIMIT)) break;
      }

      // Detect false-positive: prod has rows but export returned 0
      // This happens when maxBuffer is exceeded or JSON parsing fails silently
      if (prodRows > 0 && totalExported === 0) {
        log(`  WARNING: Expected ${prodRows} rows but exported 0 — possible buffer overflow or parse error`);
        stats.mismatches.push(`${localBinding}/${localTable}: expected=${prodRows} but exported=0 (SILENT FAILURE)`);
      }

      const localCount = countLocal(localBinding, localTable);
      const match = localCount === totalExported;
      if (match && totalExported > 0) {
        log(`  VERIFIED: ${localCount.toLocaleString()} rows`);
      } else if (match && totalExported === 0 && prodRows > 0) {
        // Don't falsely report "verified" when 0===0 but we expected data
        log(`  FAILED: 0 rows imported (expected ${prodRows})`);
      } else {
        log(`  MISMATCH: exported=${totalExported} local=${localCount}`);
        stats.mismatches.push(`${localBinding}/${localTable}: exported=${totalExported} local=${localCount}`);
      }

      stats.rows_exported += totalExported;
      stats.rows_imported += localCount;
      stats.copied++;

    } catch (e: any) {
      log(`  ERROR: ${e.message?.substring(0, 200)}`);
      stats.errors.push(`${prodDb}/${prodTable}: ${e.message?.substring(0, 200)}`);
    }
  }

  // --- 2b: Transform routes (legacy → unified) ---
  log('\n--- Phase 2b: Transform legacy tables ---');

  for (const route of transformRoutes) {
    const { prodDb, prodTable, localBinding, targetTable, prodRows, transformFn } = route;

    if (prodRows === 0) {
      log(`SKIP (0 rows): ${prodTable}`);
      stats.skipped_empty++;
      continue;
    }

    if (!transformFn || !targetTable) {
      log(`ERROR: ${prodTable} missing transformFn or targetTable`);
      stats.errors.push(`${prodTable}: missing transformFn or targetTable`);
      continue;
    }

    const maxRows = sampleMode ? Math.min(SAMPLE_LIMIT, prodRows) : prodRows;
    log(`\nTRANSFORM: ${prodTable} → ${targetTable} (${maxRows.toLocaleString()} rows${sampleMode ? ' SAMPLE' : ''})`);

    try {
      const PAGE_SIZE = sampleMode ? SAMPLE_LIMIT : 500;
      let offset = 0;
      let totalTransformed = 0;

      while (offset < maxRows + PAGE_SIZE) {
        const limit = sampleMode ? SAMPLE_LIMIT : PAGE_SIZE;
        const rows = exportTable(prodDb, prodTable, offset, limit);
        if (rows.length === 0) break;

        // Transform each row
        const transformed = rows.map(row => transformFn(row));

        // Import transformed rows into the target table
        importTransformedBatch(localBinding, targetTable, transformed);

        totalTransformed += transformed.length;
        offset += PAGE_SIZE;

        if (totalTransformed % 5000 === 0 || rows.length < PAGE_SIZE) {
          log(`  Progress: ${totalTransformed.toLocaleString()} / ~${maxRows.toLocaleString()} rows`);
        }

        if (rows.length < PAGE_SIZE || (sampleMode && totalTransformed >= SAMPLE_LIMIT)) break;
      }

      // Detect false-positive: prod has rows but transform returned 0
      if (prodRows > 0 && totalTransformed === 0) {
        log(`  WARNING: Expected ${prodRows} rows but transformed 0 — possible buffer overflow or parse error`);
        stats.mismatches.push(`${targetTable}: expected=${prodRows} but transformed=0 (SILENT FAILURE)`);
      }

      // Verify by source_platform
      const sourcePlatform = prodTable.startsWith('stripe_') ? 'stripe'
        : prodTable.startsWith('shopify_') ? 'shopify'
        : prodTable.startsWith('jobber_') ? 'jobber'
        : 'unknown';

      const localCount = countLocalFiltered(localBinding, targetTable, sourcePlatform);
      const match = localCount === totalTransformed;
      if (match && totalTransformed > 0) {
        log(`  VERIFIED: ${localCount.toLocaleString()} rows in ${targetTable} WHERE source_platform='${sourcePlatform}'`);
      } else if (match && totalTransformed === 0 && prodRows > 0) {
        log(`  FAILED: 0 rows transformed (expected ${prodRows})`);
      } else {
        log(`  MISMATCH: transformed=${totalTransformed} local=${localCount} (source_platform='${sourcePlatform}')`);
        stats.mismatches.push(`${targetTable}[${sourcePlatform}]: transformed=${totalTransformed} local=${localCount}`);
      }

      stats.rows_exported += totalTransformed;
      stats.rows_transformed += localCount;
      stats.transformed++;

    } catch (e: any) {
      log(`  ERROR: ${e.message?.substring(0, 200)}`);
      stats.errors.push(`${prodTable}: ${e.message?.substring(0, 200)}`);
    }
  }

  // --- 2c: Regenerate routes (skip) ---
  for (const route of regenerateRoutes) {
    log(`REGENERABLE (skipped): ${route.prodTable} (${route.prodRows} rows) — ${route.notes || ''}`);
    stats.regenerable++;
    stats.rows_regenerable += route.prodRows;
  }

  // ============================================================================
  // PHASE 3: Final verification
  // ============================================================================
  log('\n=== Phase 3: Final Verification ===');

  const expectedCopyRows = sampleMode
    ? copyRoutes.reduce((sum, r) => sum + Math.min(SAMPLE_LIMIT, r.prodRows), 0)
    : copyRoutes.reduce((sum, r) => sum + r.prodRows, 0);
  const expectedTransformRows = sampleMode
    ? transformRoutes.reduce((sum, r) => sum + Math.min(SAMPLE_LIMIT, r.prodRows), 0)
    : transformRoutes.reduce((sum, r) => sum + r.prodRows, 0);
  const droppedRows = dropRoutes.reduce((sum, r) => sum + r.prodRows, 0);

  log(`Tables copied:           ${stats.copied}`);
  log(`Tables transformed:      ${stats.transformed}`);
  log(`Tables regenerable:      ${stats.regenerable} (${stats.rows_regenerable.toLocaleString()} rows)`);
  log(`Tables dropped:          ${dropRoutes.length} (${droppedRows.toLocaleString()} rows)`);
  log(`Tables empty/skip:       ${stats.skipped_empty}`);
  log(`Rows exported:           ${stats.rows_exported.toLocaleString()}`);
  log(`Rows imported (copy):    ${stats.rows_imported.toLocaleString()}`);
  log(`Rows transformed:        ${stats.rows_transformed.toLocaleString()}`);
  log(`Expected copy rows:      ${expectedCopyRows.toLocaleString()}`);
  log(`Expected transform rows: ${expectedTransformRows.toLocaleString()}`);
  log(`Mismatches:              ${stats.mismatches.length}`);
  log(`Errors:                  ${stats.errors.length}`);

  // Verify unified tables
  log('\n--- Unified Table Summary ---');
  const unifiedTables = ['connector_transactions', 'connector_subscriptions', 'connector_customers', 'connector_items'];
  for (const table of unifiedTables) {
    try {
      const total = countLocal('ANALYTICS_DB', table);
      if (total > 0) {
        // Get breakdown by source_platform
        const output = exec(
          `npx wrangler d1 execute ANALYTICS_DB --local --env local --command "SELECT source_platform, COUNT(*) as c FROM ${table} GROUP BY source_platform"`,
          { timeout: 15000 }
        );
        const results = parseD1Results(output);
        const breakdown = results.map((r: any) => `${r.source_platform}=${r.c}`).join(', ');
        log(`  ${table}: ${total} rows (${breakdown})`);
      } else {
        log(`  ${table}: 0 rows`);
      }
    } catch (e: any) {
      log(`  ${table}: ERROR — ${e.message?.substring(0, 100)}`);
    }
  }

  // Verify legacy tables are empty
  log('\n--- Legacy Tables (should be empty in local) ---');
  const legacyTables = ['stripe_charges', 'stripe_subscriptions', 'stripe_daily_summary',
                        'shopify_orders', 'shopify_refunds',
                        'jobber_jobs', 'jobber_invoices', 'jobber_clients'];
  for (const table of legacyTables) {
    try {
      const count = countLocal('ANALYTICS_DB', table);
      log(`  ${table}: ${count} rows ${count === 0 ? '(OK)' : '(UNEXPECTED — should be 0)'}`);
      if (count !== 0) stats.mismatches.push(`Legacy ${table} not empty: ${count} rows`);
    } catch (e: any) {
      log(`  ${table}: ERROR — ${e.message?.substring(0, 100)}`);
    }
  }

  if (stats.mismatches.length > 0) {
    log('\n--- MISMATCHES ---');
    stats.mismatches.forEach(m => log(`  ${m}`));
  }
  if (stats.errors.length > 0) {
    log('\n--- ERRORS ---');
    stats.errors.forEach(e => log(`  ${e}`));
  }

  // ============================================================================
  // PHASE 4: Data Loss Audit
  // ============================================================================
  log('\n=== Phase 4: Data Loss Audit ===');
  if (sampleMode) {
    log('  *** SAMPLE MODE — counts are capped at 100/table, full audit not applicable ***');
  }
  log('Accounting for every row in production:');
  log(`  Total prod rows (census):       410,949`);
  log(`  Rows copied to local:           ${stats.rows_imported.toLocaleString()}`);
  log(`  Rows transformed to unified:    ${stats.rows_transformed.toLocaleString()}`);
  log(`  Rows regenerable (skipped):     ${stats.rows_regenerable.toLocaleString()} (${regenerateRoutes.map(r => `${r.prodTable}=${r.prodRows}`).join(', ')})`);
  log(`  Rows intentionally dropped:     ${droppedRows.toLocaleString()} (${dropRoutes.filter(r => r.prodRows > 0).map(r => `${r.prodTable}=${r.prodRows}`).join(', ')})`);
  log(`  Rows in 0-row tables (skipped): ${skipRoutes.length} tables`);

  const accountedFor = stats.rows_imported + stats.rows_transformed + stats.rows_regenerable + droppedRows;
  const totalProdWithData = copyRoutes.reduce((s, r) => s + r.prodRows, 0)
    + transformRoutes.reduce((s, r) => s + r.prodRows, 0)
    + regenerateRoutes.reduce((s, r) => s + r.prodRows, 0)
    + droppedRows;

  if (!sampleMode) {
    log(`  Total accounted for:            ${accountedFor.toLocaleString()} / ${totalProdWithData.toLocaleString()}`);

    if (accountedFor === totalProdWithData) {
      log('\n  *** ZERO DATA LOSS — Every row accounted for ***');
    } else {
      const diff = totalProdWithData - accountedFor;
      log(`\n  *** WARNING: ${diff} rows unaccounted for ***`);
    }
  }

  log('\n=== Migration Complete ===');
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
