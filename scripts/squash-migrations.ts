#!/usr/bin/env npx tsx
/**
 * squash-migrations.ts
 *
 * Reads the local D1 SQLite databases and generates squashed migration files
 * (1 file per table or logical group). Outputs to *-squashed/ directories.
 *
 * Usage:
 *   npx tsx scripts/squash-migrations.ts
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const API_DIR = resolve(__dirname, '..');
const D1_STATE_DIR = join(
  API_DIR,
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
);

// ---------------------------------------------------------------------------
// Map SQLite file hashes to database names.  We identify each file by
// querying for a known table unique to that database.
// ---------------------------------------------------------------------------

interface DbMapping {
  name: string;
  file: string;
  outputDir: string;
  /** Logical groups: tables that should share a single migration file */
  groups: Record<string, string[]>;
  /** Ordering hints — tables earlier in this list get lower numbers */
  order: string[];
}

function findSqliteFile(knownTable: string): string {
  const files = readdirSync(D1_STATE_DIR).filter((f) => f.endsWith('.sqlite'));
  for (const f of files) {
    const path = join(D1_STATE_DIR, f);
    try {
      const out = execSync(
        `sqlite3 "${path}" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${knownTable}';"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (out === '1') return path;
    } catch {
      // file doesn't have the table
    }
  }
  throw new Error(`Could not find SQLite file containing table '${knownTable}'`);
}

// ---------------------------------------------------------------------------
// DDL extraction helpers
// ---------------------------------------------------------------------------

function query(dbPath: string, sql: string): string[] {
  const raw = execSync(`sqlite3 "${dbPath}" "${sql}"`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return raw ? raw.split('\n') : [];
}

function getTableNames(dbPath: string): string[] {
  return query(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name;`
  );
}

/**
 * Normalize a CREATE TABLE DDL so every column/constraint is on its own line.
 * SQLite's sqlite_master stores ALTER TABLE ADD COLUMN additions inline,
 * producing ugly "col1 TYPE, col2 TYPE" runs.  This function splits them out.
 */
function normalizeCreateTable(raw: string): string {
  let ddl = raw.trim();
  if (!ddl.endsWith(';')) ddl += ';';

  // Find the opening and closing parens of the column list
  const firstParen = ddl.indexOf('(');
  const lastParen = ddl.lastIndexOf(')');
  if (firstParen === -1 || lastParen === -1) return ddl;

  const prefix = ddl.slice(0, firstParen + 1); // "CREATE TABLE foo ("
  const suffix = ddl.slice(lastParen); // ");" or ") WITHOUT ROWID;"
  const body = ddl.slice(firstParen + 1, lastParen);

  // Parse the body into individual column/constraint definitions.
  // We can't just split on commas because CHECK constraints contain commas.
  // Instead, track parenthesis depth.
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  // Filter out empty parts and normalize whitespace in each part
  const cleaned = parts
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  // Reconstruct with proper formatting
  const indent = '  ';
  const formatted =
    prefix +
    '\n' +
    cleaned.map((col) => `${indent}${col}`).join(',\n') +
    '\n' +
    suffix;

  return formatted;
}

function getCreateTable(dbPath: string, table: string): string {
  const lines = query(
    dbPath,
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';`
  );
  const raw = lines.join('\n');
  return normalizeCreateTable(raw);
}

/**
 * Query for multi-line SQL statements.  sqlite_master.sql can contain newlines
 * for multi-line CREATE INDEX / CREATE TRIGGER statements.  We use a separator
 * to split individual results, then rejoin the lines within each result.
 */
function queryStatements(
  dbPath: string,
  type: 'index' | 'trigger',
  table: string
): string[] {
  const separator = '<<<STMT_SEP>>>';
  const raw = execSync(
    `sqlite3 "${dbPath}" "SELECT sql || '${separator}' FROM sqlite_master WHERE type='${type}' AND tbl_name='${table}' AND sql IS NOT NULL ORDER BY name;"`,
    {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ).trim();
  if (!raw) return [];

  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      // Collapse to single line for indexes, keep multi-line for triggers
      if (type === 'index') {
        s = s.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (!s.endsWith(';')) s += ';';
      return s;
    });
}

function getIndexes(dbPath: string, table: string): string[] {
  return queryStatements(dbPath, 'index', table);
}

function getTriggers(dbPath: string, table: string): string[] {
  return queryStatements(dbPath, 'trigger', table);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDDL(
  table: string,
  createStmt: string,
  indexes: string[],
  triggers: string[]
): string {
  const sections: string[] = [];
  sections.push(`-- Table: ${table}`);
  sections.push(createStmt);
  if (indexes.length > 0) {
    sections.push('');
    sections.push(`-- Indexes for ${table}`);
    sections.push(...indexes);
  }
  if (triggers.length > 0) {
    sections.push('');
    sections.push(`-- Triggers for ${table}`);
    sections.push(...triggers);
  }
  return sections.join('\n');
}

function formatGroupDDL(
  groupName: string,
  tables: string[],
  dbPath: string
): string {
  const parts: string[] = [];
  parts.push(`-- Grouped migration: ${groupName}`);
  parts.push(`-- Tables: ${tables.join(', ')}`);
  parts.push('');
  for (const table of tables) {
    const create = getCreateTable(dbPath, table);
    const indexes = getIndexes(dbPath, table);
    const triggers = getTriggers(dbPath, table);
    parts.push(formatDDL(table, create, indexes, triggers));
    parts.push('');
  }
  return parts.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------
// Database configurations
// ---------------------------------------------------------------------------

const DB_GROUPS: Record<string, string[]> = {
  // Auth
  auth: ['users', 'sessions', 'password_reset_tokens', 'email_verification_tokens'],
  // Orgs
  organizations: ['organizations', 'organization_members', 'terms_acceptance'],
  // Onboarding
  onboarding: ['onboarding_progress', 'onboarding_steps'],
  // Platform connections + OAuth
  platform_connections: ['platform_connections', 'oauth_states'],
  // Connector config
  connector_configs: ['connector_configs', 'connector_filter_rules'],
  // Tag tracking
  tag_tracking: [
    'org_tag_mappings',
    'org_tracking_configs',
    'tracking_domains',
    'tracking_links',
    'script_hashes',
    'consent_configurations',
  ],
  // Conversion goals + flow builder
  conversion_goals: [
    'conversion_goals',
    'goal_relationships',
    'goal_branches',
    'goal_groups',
    'goal_group_members',
    'goal_templates',
    'goal_value_history',
    'goal_conversion_stats',
  ],
  // Sync infrastructure
  sync_infra: [
    'sync_jobs',
    'event_sync_watermarks',
    'active_event_workflows',
    'active_shopify_workflows',
  ],
  // Webhooks
  webhooks: ['webhook_endpoints', 'webhook_events'],
  // Admin
  admin: [
    'admin_tasks',
    'admin_task_comments',
    'admin_invites',
    'admin_impersonation_logs',
  ],
  // Audit & security
  audit: [
    'audit_logs',
    'auth_audit_logs',
    'config_audit_logs',
    'data_access_logs',
    'security_events',
  ],
  // Identity
  identity: ['identity_mappings', 'identity_merges'],
  // Sharding
  sharding: ['shard_routing'],
};

const DB_ORDER = [
  'auth',
  'organizations',
  'invitations',
  'onboarding',
  'platform_connections',
  'connector_configs',
  'tag_tracking',
  'conversion_goals',
  'ai_optimization_settings',
  'sync_infra',
  'webhooks',
  'admin',
  'audit',
  'identity',
  'sharding',
  'dashboard_layouts',
  'rate_limits',
  'stripe_metadata_keys',
  'waitlist',
];

const AI_DB_GROUPS: Record<string, string[]> = {
  ai_decisions: ['ai_decisions', 'ai_tool_registry'],
  analysis: ['analysis_jobs', 'analysis_logs', 'analysis_prompts', 'analysis_summaries'],
  attribution_models: ['attribution_model_results'],
  cac: ['cac_baselines', 'cac_predictions'],
};

const AI_DB_ORDER = ['ai_decisions', 'analysis', 'attribution_models', 'cac'];

const ANALYTICS_DB_GROUPS: Record<string, string[]> = {
  // Core site analytics
  core_metrics: ['daily_metrics', 'hourly_metrics'],
  // Ad platform (unified)
  unified_ad_platforms: ['ad_campaigns', 'ad_groups', 'ads', 'ad_metrics'],
  // CRM (unified)
  unified_crm: [
    'crm_contacts',
    'crm_companies',
    'crm_deals',
    'crm_activities',
  ],
  // Communication (unified)
  unified_comm: [
    'comm_campaigns',
    'comm_subscribers',
    'comm_engagements',
  ],
  // E-commerce (unified)
  unified_ecommerce: [
    'ecommerce_customers',
    'ecommerce_orders',
    'ecommerce_products',
  ],
  // Payments (unified)
  unified_payments: [
    'payments_customers',
    'payments_subscriptions',
    'payments_transactions',
  ],
  // Support (unified)
  unified_support: [
    'support_tickets',
    'support_customers',
    'support_conversations',
  ],
  // Scheduling (unified)
  unified_scheduling: [
    'scheduling_services',
    'scheduling_appointments',
    'scheduling_customers',
  ],
  // Forms (unified)
  unified_forms: ['forms_definitions', 'forms_submissions', 'forms_responses'],
  // Events (unified)
  unified_events: [
    'events_definitions',
    'events_registrations',
    'events_attendees',
  ],
  // Analytics (unified)
  unified_analytics: [
    'analytics_sessions',
    'analytics_users',
    'analytics_events',
  ],
  // Accounting (unified)
  unified_accounting: [
    'accounting_customers',
    'accounting_invoices',
    'accounting_expenses',
  ],
  // Mobile attribution (unified)
  unified_attribution: [
    'attribution_installs',
    'attribution_events',
    'attribution_revenue',
  ],
  // Reviews (unified)
  unified_reviews: [
    'reviews_items',
    'reviews_profiles',
    'reviews_responses',
  ],
  // Affiliate (unified)
  unified_affiliate: [
    'affiliate_referrals',
    'affiliate_partners',
    'affiliate_conversions',
  ],
  // Social (unified)
  unified_social: [
    'social_posts',
    'social_profiles',
    'social_followers',
    'social_metrics',
  ],
  // Conversions core
  conversions: [
    'conversions',
    'conversion_attribution',
    'conversion_daily_summary',
    'conversion_value_allocations',
  ],
  goal_conversions: ['goal_conversions', 'goal_metrics_daily', 'goal_completion_metrics'],
  // Identity & linking
  customer_identities: ['customer_identities', 'identity_link_events'],
  // Journey & attribution
  journeys: ['journeys', 'journey_touchpoints', 'journey_analytics'],
  attribution_results: ['attribution_results', 'channel_transitions'],
  // Click tracking
  tracked_clicks: ['tracked_clicks'],
  // UTM
  utm: ['utm_performance'],
  // Funnel
  funnel_transitions: ['funnel_transitions'],
  // Platform-specific: Stripe
  stripe: ['stripe_charges', 'stripe_subscriptions', 'stripe_daily_summary'],
  // Platform-specific: Shopify
  shopify: ['shopify_orders', 'shopify_refunds'],
  // Platform-specific: Jobber
  jobber: ['jobber_jobs', 'jobber_clients', 'jobber_invoices'],
  // Facebook
  facebook_pages: ['facebook_pages'],
  // Pre-aggregation
  pre_aggregation: [
    'org_daily_summary',
    'org_timeseries',
    'campaign_period_summary',
    'platform_comparison',
  ],
  // CAC
  cac_history: ['cac_history'],
  // Handoff
  handoff: ['handoff_observations', 'handoff_patterns'],
  // Infrastructure
  analytics_infra: [
    'aggregation_jobs',
    'connector_sync_status',
    'sync_watermarks',
    'domain_claims',
  ],
};

const ANALYTICS_DB_ORDER = [
  'core_metrics',
  'unified_ad_platforms',
  'unified_crm',
  'unified_comm',
  'unified_ecommerce',
  'unified_payments',
  'unified_support',
  'unified_scheduling',
  'unified_forms',
  'unified_events',
  'unified_analytics',
  'unified_accounting',
  'unified_attribution',
  'unified_reviews',
  'unified_affiliate',
  'unified_social',
  'conversions',
  'goal_conversions',
  'customer_identities',
  'journeys',
  'attribution_results',
  'tracked_clicks',
  'utm',
  'funnel_transitions',
  'stripe',
  'shopify',
  'jobber',
  'facebook_pages',
  'pre_aggregation',
  'cac_history',
  'handoff',
  'analytics_infra',
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function processDatabase(
  dbName: string,
  knownTable: string,
  outputDir: string,
  groups: Record<string, string[]>,
  order: string[]
): void {
  console.log(`\n=== Processing ${dbName} ===`);

  const dbPath = findSqliteFile(knownTable);
  console.log(`  SQLite file: ${dbPath}`);

  const allTables = getTableNames(dbPath);
  console.log(`  Tables found: ${allTables.length}`);

  const outPath = join(API_DIR, outputDir);
  mkdirSync(outPath, { recursive: true });

  // Build set of grouped tables
  const groupedTables = new Set<string>();
  for (const tables of Object.values(groups)) {
    for (const t of tables) groupedTables.add(t);
  }

  // Find ungrouped tables
  const ungrouped = allTables.filter((t) => !groupedTables.has(t));
  if (ungrouped.length > 0) {
    console.log(`  Ungrouped tables: ${ungrouped.join(', ')}`);
  }

  // Verify all grouped tables exist
  for (const [groupName, tables] of Object.entries(groups)) {
    for (const t of tables) {
      if (!allTables.includes(t)) {
        console.warn(`  WARNING: Table '${t}' in group '${groupName}' not found in database`);
      }
    }
  }

  // Build ordered list of items to generate
  type MigrationItem =
    | { type: 'group'; name: string; tables: string[] }
    | { type: 'single'; name: string; table: string };

  const items: MigrationItem[] = [];

  for (const key of order) {
    if (groups[key]) {
      // Filter to only tables that actually exist
      const existing = groups[key].filter((t) => allTables.includes(t));
      if (existing.length > 0) {
        items.push({ type: 'group', name: key, tables: existing });
      }
    } else {
      // It's a single table name
      if (allTables.includes(key)) {
        items.push({ type: 'single', name: key, table: key });
      }
    }
  }

  // Add ungrouped tables at the end
  for (const t of ungrouped) {
    if (!order.includes(t)) {
      items.push({ type: 'single', name: t, table: t });
    }
  }

  // Generate files
  let seq = 1;
  const generatedFiles: string[] = [];

  for (const item of items) {
    const num = String(seq).padStart(4, '0');
    const fileName = `${num}_${item.name}.sql`;
    const filePath = join(outPath, fileName);

    let content: string;
    if (item.type === 'group') {
      content = formatGroupDDL(item.name, item.tables, dbPath);
    } else {
      const create = getCreateTable(dbPath, item.table);
      const indexes = getIndexes(dbPath, item.table);
      const triggers = getTriggers(dbPath, item.table);
      content = formatDDL(item.table, create, indexes, triggers) + '\n';
    }

    writeFileSync(filePath, content, 'utf-8');
    generatedFiles.push(fileName);
    seq++;
  }

  console.log(`  Generated ${generatedFiles.length} migration files in ${outputDir}/`);
  for (const f of generatedFiles) {
    console.log(`    ${f}`);
  }

  // Generate backfill SQL
  const backfillPath = join(outPath, '..', `backfill-${outputDir.replace(/\//g, '-')}.sql`);
  const backfillLines = [
    `-- Backfill d1_migrations for ${dbName}`,
    `-- Run this against remote D1 to mark all squashed migrations as applied`,
    `-- WARNING: This deletes existing migration records!`,
    '',
    `DELETE FROM d1_migrations;`,
    '',
  ];
  for (const f of generatedFiles) {
    backfillLines.push(
      `INSERT INTO d1_migrations (name, applied_at) VALUES ('${f}', datetime('now'));`
    );
  }
  backfillLines.push('');
  writeFileSync(backfillPath, backfillLines.join('\n'), 'utf-8');
  console.log(`  Backfill SQL: ${backfillPath}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('D1 Migration Squash Tool');
console.log('========================');
console.log(`API directory: ${API_DIR}`);
console.log(`D1 state dir:  ${D1_STATE_DIR}`);

processDatabase(
  'DB',
  'users', // known unique table
  'migrations-squashed',
  DB_GROUPS,
  DB_ORDER
);

processDatabase(
  'AI_DB',
  'ai_decisions', // known unique table
  'migrations-ai-squashed',
  AI_DB_GROUPS,
  AI_DB_ORDER
);

processDatabase(
  'ANALYTICS_DB',
  'daily_metrics', // known unique table
  'migrations-analytics-squashed',
  ANALYTICS_DB_GROUPS,
  ANALYTICS_DB_ORDER
);

console.log('\n✅ Squash complete!');
console.log('');
console.log('Next steps:');
console.log('  1. Review generated files in *-squashed/ directories');
console.log('  2. mv migrations migrations-archive && mv migrations-squashed migrations');
console.log('  3. Same for migrations-ai and migrations-analytics');
console.log('  4. Run backfill SQL against remote D1 (prod + staging)');
console.log('  5. rm -rf .wrangler/state/v3/d1/ && re-apply migrations locally');
