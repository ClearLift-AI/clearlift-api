#!/usr/bin/env npx tsx
/**
 * Single-Org Production → Local D1 Migration
 *
 * Pulls a specific org's data from production D1 into a fresh local D1.
 * Resets local state first (no seed data, no stale data — clean slate).
 *
 * Usage:
 *   cd clearlift-api
 *   npx tsx scripts/migrate-org.ts --org bandago
 *   npx tsx scripts/migrate-org.ts --org bandago --dry-run
 *   npx tsx scripts/migrate-org.ts --org bandago --skip-reset
 *
 * Prerequisites:
 *   npx wrangler d1 migrations apply DB --local --env local
 *   npx wrangler d1 migrations apply ANALYTICS_DB --local --env local
 *   (or let this script do it — it resets + re-applies by default)
 *
 * After running:
 *   1. Start the local stack: cd ../clearlift-page-router && npm run dev:stack
 *   2. Open browser console on localhost:3001 and paste the localStorage commands printed below
 *   3. Reload — you'll see the org's real data
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const WORK_DIR = '/Users/work/Documents/Code/clearlift-api';
const TMP_DIR = path.join(WORK_DIR, '.migrate-org-tmp');

// ============================================================================
// CLI ARGS
// ============================================================================

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipReset = args.includes('--skip-reset');

function argVal(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const ORG_SLUG = argVal('--org', '');
if (!ORG_SLUG) {
  console.error('Usage: npx tsx scripts/migrate-org.ts --org <slug>');
  console.error('  e.g. --org bandago');
  process.exit(1);
}

// Sanitize slug for SQL interpolation
if (/[';\\]/.test(ORG_SLUG)) {
  console.error('ERROR: --org value contains invalid characters');
  process.exit(1);
}

/**
 * Validate that a value extracted from production queries is safe for SQL interpolation.
 * UUIDs, short_tags, and user IDs should never contain SQL-special characters.
 * Throws if the value is unsafe — catches corrupted prod data before it becomes injection.
 */
function assertSqlSafe(val: string, label: string): void {
  if (/['";\\]/.test(val)) {
    throw new Error(`${label} contains SQL-unsafe characters: ${val.substring(0, 50)}`);
  }
}

// ============================================================================
// HELPERS (same patterns as prod-to-local-migration.ts)
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
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
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
        msg.includes('A request to the Clo') || msg.includes('A fetch r');
      if (isRemote && isRateLimit && attempt < MAX_RETRIES) {
        const delay = attempt * 5;
        log(`  RATE LIMITED (attempt ${attempt}/${MAX_RETRIES}), waiting ${delay}s...`);
        execSync(`sleep ${delay}`);
        continue;
      }
      throw e;
    }
  }
  throw new Error('exec: unreachable');
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

function getLocalColumns(binding: string, table: string): string[] {
  const output = exec(
    `npx wrangler d1 execute ${binding} --local --env local --command "PRAGMA table_info(${table})"`,
    { timeout: 15000 }
  );
  return parseD1Results(output).map((r: any) => r.name);
}

function queryProd(db: string, sql: string): any[] {
  const escaped = sql.replace(/"/g, '\\"');
  const output = exec(
    `npx wrangler d1 execute ${db} --remote --command "${escaped}"`,
    { timeout: 60000 }
  );
  return parseD1Results(output);
}

function importBatch(binding: string, table: string, columns: string[], rows: any[]): void {
  if (rows.length === 0) return;

  const colList = columns.join(', ');
  const statements: string[] = [];

  for (const row of rows) {
    const values = columns.map(col => escapeSQL(row[col])).join(', ');
    statements.push(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${values});`);
  }

  const tmpFile = path.join(TMP_DIR, `import_${binding}_${table}_${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, statements.join('\n'));

  exec(
    `npx wrangler d1 execute ${binding} --local --env local --file ${tmpFile} 2>&1`,
    { timeout: 60000 }
  );

  try { fs.unlinkSync(tmpFile); } catch {}
}

function countLocal(binding: string, table: string): number {
  const output = exec(
    `npx wrangler d1 execute ${binding} --local --env local --command "SELECT COUNT(*) as c FROM ${table}"`,
    { timeout: 15000 }
  );
  const results = parseD1Results(output);
  return results[0]?.c || 0;
}

// ============================================================================
// PAGINATED EXPORT + IMPORT (for tables that might have many rows)
// ============================================================================

function pullTable(
  prodDb: string,
  localBinding: string,
  table: string,
  whereClause: string,
  label?: string
): number {
  const tag = label || table;
  const PAGE_SIZE = 500;

  // Check local table exists first (avoids misleading SQL errors)
  let localCols: string[];
  try {
    localCols = getLocalColumns(localBinding, table);
  } catch {
    log(`  SKIP: ${tag} — table does not exist in local ${localBinding}`);
    return 0;
  }

  // Check prod table exists
  let prodColsRaw: any[];
  try {
    prodColsRaw = queryProd(prodDb, `PRAGMA table_info(${table})`);
  } catch {
    log(`  SKIP: ${tag} — table does not exist in prod ${prodDb}`);
    return 0;
  }
  const prodCols = prodColsRaw.map((r: any) => r.name);
  if (prodCols.length === 0) {
    log(`  SKIP: ${tag} — table does not exist in prod ${prodDb}`);
    return 0;
  }

  // Verify the WHERE clause column exists in prod
  // Handles: "col = 'val'", "col IN (...)", "col = 'val' AND col2 = 'val2'"
  const whereColMatch = whereClause.match(/^(\w+)\s*(=|IN)\s*/i);
  const whereCol = whereColMatch?.[1];
  if (whereCol && !prodCols.includes(whereCol)) {
    log(`  SKIP: ${tag} — prod table missing column '${whereCol}'`);
    return 0;
  }

  // Count prod rows
  const countResult = queryProd(prodDb, `SELECT COUNT(*) as c FROM ${table} WHERE ${whereClause}`);
  const totalRows = countResult[0]?.c || 0;
  if (totalRows === 0) {
    log(`  ${tag}: 0 rows (skipped)`);
    return 0;
  }

  log(`  ${tag}: ${totalRows.toLocaleString()} rows to pull...`);

  const commonCols = prodCols.filter((c: string) => localCols.includes(c));

  if (commonCols.length === 0) {
    log(`  WARNING: No common columns between prod and local for ${table}`);
    return 0;
  }

  const selectCols = commonCols.join(', ');
  let offset = 0;
  let imported = 0;

  while (offset < totalRows + PAGE_SIZE) {
    const rows = queryProd(prodDb, `SELECT ${selectCols} FROM ${table} WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    if (rows.length === 0) break;

    importBatch(localBinding, table, commonCols, rows);
    imported += rows.length;
    offset += PAGE_SIZE;

    if (imported % 2000 === 0 || rows.length < PAGE_SIZE) {
      log(`    Progress: ${imported.toLocaleString()} / ${totalRows.toLocaleString()}`);
    }

    if (rows.length < PAGE_SIZE) break;
  }

  const localCount = countLocal(localBinding, table);
  log(`    Verified: ${localCount} rows in local ${table}`);
  return imported;
}

// ============================================================================
// LEGACY TRANSFORM: stripe_charges → connector_events
// ============================================================================

function normalizeStripeStatus(status: string): string {
  if (!status) return 'pending';
  const s = status.toLowerCase();
  if (s === 'succeeded' || s === 'paid') return 'succeeded';
  if (s === 'failed' || s === 'canceled') return 'failed';
  return 'pending';
}

function transformStripeChargeToConnectorEvent(row: Record<string, any>): Record<string, any> {
  return {
    organization_id: row.organization_id,
    source_platform: 'stripe',
    event_type: 'charge',
    external_id: row.charge_id,
    customer_external_id: row.customer_id || null,
    customer_email_hash: row.customer_email_hash || null,
    value_cents: row.amount_cents || 0,
    currency: row.currency || 'usd',
    status: normalizeStripeStatus(row.status),
    transacted_at: row.stripe_created_at,
    created_at_platform: row.stripe_created_at,
    metadata: row.raw_data || null,
  };
}

function pullLegacyStripeCharges(orgId: string): number {
  const prodDb = 'clearlift-analytics-prod';
  const whereClause = `organization_id = '${orgId}'`;

  // Check if prod even has stripe_charges
  let prodCols: any[];
  try {
    prodCols = queryProd(prodDb, `PRAGMA table_info(stripe_charges)`);
  } catch {
    log(`  stripe_charges: table not found in prod (skipped)`);
    return 0;
  }
  if (prodCols.length === 0) {
    log(`  stripe_charges: table not found in prod (skipped)`);
    return 0;
  }

  const countResult = queryProd(prodDb, `SELECT COUNT(*) as c FROM stripe_charges WHERE ${whereClause}`);
  const totalRows = countResult[0]?.c || 0;
  if (totalRows === 0) {
    log(`  stripe_charges -> connector_events: 0 rows (skipped)`);
    return 0;
  }

  log(`  stripe_charges -> connector_events: ${totalRows} rows to transform...`);

  const PAGE_SIZE = 500;
  let offset = 0;
  let imported = 0;

  while (offset < totalRows + PAGE_SIZE) {
    const rows = queryProd(prodDb, `SELECT * FROM stripe_charges WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    if (rows.length === 0) break;

    const transformed = rows.map(transformStripeChargeToConnectorEvent);
    const columns = Object.keys(transformed[0]);

    importBatch('ANALYTICS_DB', 'connector_events', columns, transformed);
    imported += transformed.length;
    offset += PAGE_SIZE;

    if (rows.length < PAGE_SIZE) break;
  }

  log(`    Transformed ${imported} stripe_charges -> connector_events`);
  return imported;
}

// Same transform for shopify_orders → connector_events
function pullLegacyShopifyOrders(orgId: string): number {
  const prodDb = 'clearlift-analytics-prod';
  const whereClause = `organization_id = '${orgId}'`;

  let prodCols: any[];
  try {
    prodCols = queryProd(prodDb, `PRAGMA table_info(shopify_orders)`);
  } catch { return 0; }
  if (prodCols.length === 0) return 0;

  const countResult = queryProd(prodDb, `SELECT COUNT(*) as c FROM shopify_orders WHERE ${whereClause}`);
  const totalRows = countResult[0]?.c || 0;
  if (totalRows === 0) {
    log(`  shopify_orders -> connector_events: 0 rows (skipped)`);
    return 0;
  }

  log(`  shopify_orders -> connector_events: ${totalRows} rows to transform...`);

  const PAGE_SIZE = 500;
  let offset = 0;
  let imported = 0;

  while (offset < totalRows + PAGE_SIZE) {
    const rows = queryProd(prodDb, `SELECT * FROM shopify_orders WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    if (rows.length === 0) break;

    const transformed = rows.map(row => {
      let status = 'pending';
      const fStatus = (row.financial_status || '').toLowerCase();
      if (fStatus === 'paid' || fStatus === 'partially_paid') status = 'paid';
      else if (fStatus === 'refunded' || fStatus === 'partially_refunded') status = 'refunded';
      else if (fStatus === 'voided') status = 'cancelled';

      return {
        organization_id: row.organization_id,
        source_platform: 'shopify',
        event_type: 'order',
        external_id: row.shopify_order_id,
        customer_external_id: row.customer_id || null,
        customer_email_hash: row.customer_email_hash || null,
        value_cents: row.total_price_cents || 0,
        currency: row.currency || 'USD',
        status,
        transacted_at: row.shopify_created_at,
        created_at_platform: row.shopify_created_at,
        metadata: row.raw_data || null,
      };
    });
    const columns = Object.keys(transformed[0]);
    importBatch('ANALYTICS_DB', 'connector_events', columns, transformed);
    imported += transformed.length;
    offset += PAGE_SIZE;

    if (rows.length < PAGE_SIZE) break;
  }

  log(`    Transformed ${imported} shopify_orders -> connector_events`);
  return imported;
}

// Same transform for jobber_invoices → connector_events
function pullLegacyJobberInvoices(orgId: string): number {
  const prodDb = 'clearlift-analytics-prod';
  const whereClause = `organization_id = '${orgId}'`;

  let prodCols: any[];
  try {
    prodCols = queryProd(prodDb, `PRAGMA table_info(jobber_invoices)`);
  } catch { return 0; }
  if (prodCols.length === 0) return 0;

  const countResult = queryProd(prodDb, `SELECT COUNT(*) as c FROM jobber_invoices WHERE ${whereClause}`);
  const totalRows = countResult[0]?.c || 0;
  if (totalRows === 0) {
    log(`  jobber_invoices -> connector_events: 0 rows (skipped)`);
    return 0;
  }

  log(`  jobber_invoices -> connector_events: ${totalRows} rows to transform...`);

  const PAGE_SIZE = 500;
  let offset = 0;
  let imported = 0;

  while (offset < totalRows + PAGE_SIZE) {
    const rows = queryProd(prodDb, `SELECT * FROM jobber_invoices WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    if (rows.length === 0) break;

    const transformed = rows.map(row => {
      const isPaid = (row.status || '').toUpperCase() === 'PAID' || row.is_paid === 1;
      return {
        organization_id: row.organization_id,
        source_platform: 'jobber',
        event_type: 'invoice',
        external_id: row.jobber_invoice_id,
        customer_external_id: row.client_id || null,
        customer_email_hash: row.client_email_hash || null,
        value_cents: row.total_cents || 0,
        currency: row.currency || 'USD',
        status: isPaid ? 'paid' : 'pending',
        transacted_at: row.paid_at || row.jobber_created_at,
        created_at_platform: row.jobber_created_at,
        metadata: row.raw_data || null,
      };
    });
    const columns = Object.keys(transformed[0]);
    importBatch('ANALYTICS_DB', 'connector_events', columns, transformed);
    imported += transformed.length;
    offset += PAGE_SIZE;

    if (rows.length < PAGE_SIZE) break;
  }

  log(`    Transformed ${imported} jobber_invoices -> connector_events`);
  return imported;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  log(`=== Single-Org Migration: ${ORG_SLUG} ===`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}${skipReset ? ' (skip reset)' : ''}`);

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  // ============================================================================
  // STEP 0: Find the org in production
  // ============================================================================
  log('\n--- Step 0: Finding org in production ---');

  const orgs = queryProd('clearlift-db-prod', `SELECT * FROM organizations WHERE slug = '${ORG_SLUG}'`);
  if (orgs.length === 0) {
    log(`ERROR: No org found with slug '${ORG_SLUG}'`);
    log('Available orgs:');
    const allOrgs = queryProd('clearlift-db-prod', 'SELECT slug, name FROM organizations ORDER BY slug');
    allOrgs.forEach((o: any) => log(`  ${o.slug} — ${o.name}`));
    process.exit(1);
  }

  const org = orgs[0];
  const ORG_ID = org.id;
  assertSqlSafe(ORG_ID, 'ORG_ID');
  log(`Found: ${org.name} (${org.slug})`);
  log(`  ID: ${ORG_ID}`);

  // Find the org tag — column is `short_tag` (NOT `tag`)
  const tagRows = queryProd('clearlift-db-prod', `SELECT * FROM org_tag_mappings WHERE organization_id = '${ORG_ID}'`);
  const ORG_TAG = tagRows[0]?.short_tag || null;
  if (ORG_TAG) assertSqlSafe(ORG_TAG, 'ORG_TAG');
  log(`  Tag: ${ORG_TAG || '(none)'}`);

  // Find the org owner — with correct fallback
  const ownerMembers = queryProd('clearlift-db-prod', `SELECT * FROM organization_members WHERE organization_id = '${ORG_ID}' AND role = 'owner'`);
  let primaryUserId: string;
  if (ownerMembers.length > 0) {
    primaryUserId = ownerMembers[0].user_id;
  } else {
    const anyMembers = queryProd('clearlift-db-prod', `SELECT * FROM organization_members WHERE organization_id = '${ORG_ID}' LIMIT 1`);
    if (anyMembers.length === 0) {
      log('ERROR: No members found for this org');
      process.exit(1);
    }
    primaryUserId = anyMembers[0].user_id;
  }
  log(`  Owner user_id: ${primaryUserId}`);

  // Pull ALL member user_ids (not just owner) to avoid FK violations
  const allMembers = queryProd('clearlift-db-prod', `SELECT DISTINCT user_id FROM organization_members WHERE organization_id = '${ORG_ID}'`);
  const allUserIds = allMembers.map((m: any) => m.user_id);
  allUserIds.forEach((uid: string) => assertSqlSafe(uid, `user_id`));
  log(`  Members: ${allUserIds.length} user(s)`);

  const users = queryProd('clearlift-db-prod', `SELECT * FROM users WHERE id = '${primaryUserId}'`);
  const user = users[0];
  log(`  Owner email: ${user?.email || '(encrypted)'}`);

  // Find platform connections (+ their IDs for connector_filter_rules FK)
  const connections = queryProd('clearlift-db-prod', `SELECT id, platform, sync_status FROM platform_connections WHERE organization_id = '${ORG_ID}'`);
  log(`  Connections: ${connections.map((c: any) => `${c.platform}(${c.sync_status})`).join(', ') || '(none)'}`);
  const connectionIds = connections.map((c: any) => c.id);
  connectionIds.forEach((cid: string) => assertSqlSafe(cid, `connection_id`));

  if (dryRun) {
    log('\n--- DRY RUN: Would pull the following tables ---');
    log('Core (DB) — from clearlift-db-prod:');
    log('  organizations, users (all members), organization_members, org_tag_mappings,');
    log('  platform_connections, connector_filter_rules, tracking_domains,');
    log('  tracking_links (by org_tag), script_hashes,');
    log('  ai_optimization_settings (by org_id), dashboard_layouts,');
    log('  onboarding_progress, terms_acceptance,');
    log('  webhook_endpoints, event_sync_watermarks (by org_tag), sync_jobs');
    log('Core (DB) — from clearlift-ai-prod (AI_DB → merged into DB):');
    log('  ai_decisions, cac_predictions, cac_baselines,');
    log('  analysis_jobs, analysis_summaries, analysis_logs');
    log('  connector_configs — seeded via migration 0002');
    log('Analytics (ANALYTICS_DB) — by organization_id:');
    log('  ad_campaigns, ad_groups, ads, ad_metrics, facebook_pages,');
    log('  conversions, conversion_daily_summary, conversion_value_allocations,');
    log('  conversion_attribution, tracked_clicks,');
    log('  identity_link_events, identity_mappings, identity_merges,');
    log('  cac_history, handoff_observations, handoff_patterns,');
    log('  org_daily_summary, org_timeseries, campaign_period_summary,');
    log('  platform_comparison, connector_sync_status, aggregation_jobs');
    log('Analytics (ANALYTICS_DB) — from clearlift-ai-prod:');
    log('  attribution_model_results');
    if (ORG_TAG) {
      log(`Analytics (ANALYTICS_DB) — by org_tag '${ORG_TAG}':`);
      log('  customer_identities, touchpoints,');
      log('  journeys, journey_analytics, funnel_transitions,');
      log('  daily_metrics, hourly_metrics, utm_performance,');
      log('  attribution_results, channel_transitions');
    } else {
      log('  SKIP org_tag tables: no tag mapping found');
    }
    log('Legacy transforms: stripe_charges, shopify_orders, jobber_invoices -> connector_events');
    log('Session: fresh token for dashboard login');
    return;
  }

  // ============================================================================
  // STEP 1: Reset local D1 (clean slate — no seed data)
  // ============================================================================
  if (!skipReset) {
    log('\n--- Step 1: Reset local D1 (clean slate) ---');

    const stateDir = path.join(WORK_DIR, '.wrangler/state/v3/d1');
    if (fs.existsSync(stateDir)) {
      log('Clearing old local D1 state...');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    log('Applying core migrations...');
    exec('npx wrangler d1 migrations apply DB --local --env local 2>&1', { timeout: 30000 });

    log('Applying analytics migrations...');
    exec('npx wrangler d1 migrations apply ANALYTICS_DB --local --env local 2>&1', { timeout: 30000 });

    log('Local D1 reset complete — fresh schema, zero data rows.');
  } else {
    log('\n--- Step 1: SKIPPED (--skip-reset) ---');
  }

  // ============================================================================
  // WHERE clause helpers
  // ============================================================================
  const orgWhere = `organization_id = '${ORG_ID}'`;
  // org_tag_mappings column is `short_tag` in prod, but analytics tables use `org_tag`
  const tagWhere = ORG_TAG ? `org_tag = '${ORG_TAG}'` : null;

  const stats = { tables: 0, rows: 0 };

  function track(n: number) {
    if (n > 0) stats.tables++;
    stats.rows += n;
  }

  // ============================================================================
  // STEP 2: Pull Core tables (DB)
  // ============================================================================
  log('\n--- Step 2: Pull Core tables (DB) ---');

  // Org
  track(pullTable('clearlift-db-prod', 'DB', 'organizations', `id = '${ORG_ID}'`));

  // All member users (not just owner — avoids FK violations on organization_members)
  for (const uid of allUserIds) {
    track(pullTable('clearlift-db-prod', 'DB', 'users', `id = '${uid}'`, `users (${uid.substring(0, 8)}...)`));
  }

  // Membership links
  track(pullTable('clearlift-db-prod', 'DB', 'organization_members', orgWhere));

  // Tag mapping
  track(pullTable('clearlift-db-prod', 'DB', 'org_tag_mappings', orgWhere));

  // Platform connections (OAuth tokens, conversion config)
  track(pullTable('clearlift-db-prod', 'DB', 'platform_connections', orgWhere));

  // Connector filter rules — FK to platform_connections(id), not organization_id
  if (connectionIds.length > 0) {
    const connIdList = connectionIds.map((id: string) => `'${id}'`).join(', ');
    track(pullTable('clearlift-db-prod', 'DB', 'connector_filter_rules', `connection_id IN (${connIdList})`, 'connector_filter_rules'));
  }

  // Tracking domains
  track(pullTable('clearlift-db-prod', 'DB', 'tracking_domains', orgWhere));

  // Tracking links — uses org_tag, NOT organization_id
  if (ORG_TAG) {
    track(pullTable('clearlift-db-prod', 'DB', 'tracking_links', `org_tag = '${ORG_TAG}'`, 'tracking_links (by org_tag)'));
  }

  // Script hashes (needed for tag snippet to work)
  track(pullTable('clearlift-db-prod', 'DB', 'script_hashes', orgWhere));

  // Settings — ai_optimization_settings PK is `org_id`, NOT `organization_id`
  track(pullTable('clearlift-db-prod', 'DB', 'ai_optimization_settings', `org_id = '${ORG_ID}'`, 'ai_optimization_settings (by org_id)'));
  track(pullTable('clearlift-db-prod', 'DB', 'dashboard_layouts', orgWhere));

  // Onboarding + terms (for each member user)
  for (const uid of allUserIds) {
    track(pullTable('clearlift-db-prod', 'DB', 'onboarding_progress', `user_id = '${uid}'`, `onboarding_progress (${uid.substring(0, 8)}...)`));
    track(pullTable('clearlift-db-prod', 'DB', 'terms_acceptance', `user_id = '${uid}'`, `terms_acceptance (${uid.substring(0, 8)}...)`));
  }

  // Webhook endpoints (user-configured webhooks)
  track(pullTable('clearlift-db-prod', 'DB', 'webhook_endpoints', orgWhere));

  // Event sync watermarks (by org_tag)
  if (ORG_TAG) {
    track(pullTable('clearlift-db-prod', 'DB', 'event_sync_watermarks', `org_tag = '${ORG_TAG}'`, 'event_sync_watermarks (by org_tag)'));
  }

  // Sync job tracking
  track(pullTable('clearlift-db-prod', 'DB', 'sync_jobs', orgWhere));

  // --- AI tables: live in clearlift-ai-prod (old AI_DB), merged into local DB ---
  log('\n  AI tables (from clearlift-ai-prod):');
  track(pullTable('clearlift-ai-prod', 'DB', 'ai_decisions', orgWhere, 'ai_decisions (from AI_DB)'));
  track(pullTable('clearlift-ai-prod', 'DB', 'cac_predictions', orgWhere, 'cac_predictions (from AI_DB)'));
  track(pullTable('clearlift-ai-prod', 'DB', 'cac_baselines', orgWhere, 'cac_baselines (from AI_DB)'));
  track(pullTable('clearlift-ai-prod', 'DB', 'analysis_jobs', orgWhere, 'analysis_jobs (from AI_DB)'));
  track(pullTable('clearlift-ai-prod', 'DB', 'analysis_summaries', orgWhere, 'analysis_summaries (from AI_DB)'));
  track(pullTable('clearlift-ai-prod', 'DB', 'analysis_logs', orgWhere, 'analysis_logs (from AI_DB)'));

  // connector_configs — seeded via migration 0002, no need to re-pull
  log('  connector_configs: already seeded via migration 0002');

  // NOTE: conversion_goals / goal_relationships exist in PROD but NOT in the
  // local consolidated schema (goals were removed). pullTable safely skips
  // tables that don't exist locally.
  track(pullTable('clearlift-db-prod', 'DB', 'conversion_goals', orgWhere, 'conversion_goals (legacy, may skip)'));
  track(pullTable('clearlift-db-prod', 'DB', 'goal_relationships', orgWhere, 'goal_relationships (legacy, may skip)'));

  // ============================================================================
  // STEP 3: Pull Analytics tables (ANALYTICS_DB)
  // ============================================================================
  log('\n--- Step 3: Pull Analytics tables (ANALYTICS_DB) ---');

  // --- Tables filtered by organization_id ---

  // Ad data
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'ad_campaigns', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'ad_groups', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'ads', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'ad_metrics', orgWhere));

  // Facebook pages (Meta Ads page data)
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'facebook_pages', orgWhere));

  // Conversions
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'conversions', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'conversion_daily_summary', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'conversion_value_allocations', orgWhere));

  // CAC
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'cac_history', orgWhere));

  // Conversion attribution (links conversions to ad clicks)
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'conversion_attribution', orgWhere));

  // Tracked clicks (deterministic attribution — click IDs from tag events)
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'tracked_clicks', orgWhere));

  // Identity tables
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'identity_link_events', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'identity_mappings', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'identity_merges', orgWhere));

  // Handoff data
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'handoff_observations', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'handoff_patterns', orgWhere));

  // Attribution model results — in old prod, lives in clearlift-ai-prod (AI_DB)
  track(pullTable('clearlift-ai-prod', 'ANALYTICS_DB', 'attribution_model_results', orgWhere, 'attribution_model_results (from AI_DB)'));

  // Pre-aggregation tables
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'org_daily_summary', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'org_timeseries', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'campaign_period_summary', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'platform_comparison', orgWhere));

  // Infrastructure
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'connector_sync_status', orgWhere));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'aggregation_jobs', orgWhere));

  // Goal tables (exist in prod, may not exist in local consolidated schema — safely skipped)
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'goal_conversions', orgWhere, 'goal_conversions (legacy, may skip)'));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'goal_metrics_daily', orgWhere, 'goal_metrics_daily (legacy, may skip)'));
  track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'goal_completion_metrics', orgWhere, 'goal_completion_metrics (legacy, may skip)'));

  // --- Tables filtered by org_tag ---
  // attribution_results, channel_transitions, journeys, funnel_transitions,
  // daily_metrics, hourly_metrics, customer_identities, touchpoints, utm_performance
  // all use org_tag — NOT organization_id

  if (tagWhere) {
    // Identity
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'customer_identities', tagWhere, 'customer_identities (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'touchpoints', tagWhere, 'touchpoints (by org_tag)'));

    // Attribution — uses org_tag, NOT organization_id
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'attribution_results', tagWhere, 'attribution_results (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'channel_transitions', tagWhere, 'channel_transitions (by org_tag)'));

    // Journeys & page flow
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'journeys', tagWhere, 'journeys (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'journey_analytics', tagWhere, 'journey_analytics (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'funnel_transitions', tagWhere, 'funnel_transitions (by org_tag)'));

    // Site metrics
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'daily_metrics', tagWhere, 'daily_metrics (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'hourly_metrics', tagWhere, 'hourly_metrics (by org_tag)'));
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'utm_performance', tagWhere, 'utm_performance (by org_tag)'));

    // Sync watermarks
    track(pullTable('clearlift-analytics-prod', 'ANALYTICS_DB', 'sync_watermarks', tagWhere, 'sync_watermarks (by org_tag)'));
  } else {
    log('  SKIP org_tag tables: no tag mapping found');
  }

  // NOTE: connector_events does NOT exist in old production ANALYTICS_DB.
  // It's a new table in the consolidated schema. Populated only via legacy
  // transforms below (stripe_charges, shopify_orders, jobber_invoices).

  // ============================================================================
  // STEP 4: Legacy transforms → connector_events
  // ============================================================================
  log('\n--- Step 4: Legacy transforms -> connector_events ---');

  track(pullLegacyStripeCharges(ORG_ID));
  track(pullLegacyShopifyOrders(ORG_ID));
  track(pullLegacyJobberInvoices(ORG_ID));

  // Verify connector_events total
  try {
    const ceCount = countLocal('ANALYTICS_DB', 'connector_events');
    log(`  connector_events total: ${ceCount} rows`);
  } catch { /* table might not exist */ }

  // ============================================================================
  // STEP 5: Create local session
  // ============================================================================
  log('\n--- Step 5: Create local session ---');

  const sessionToken = `migrate_${ORG_SLUG}_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const sessionSql = `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('${sessionToken}', '${primaryUserId}', datetime('now'), '${expiresAt}');`;

  const tmpFile = path.join(TMP_DIR, 'session.sql');
  fs.writeFileSync(tmpFile, sessionSql);
  exec(`npx wrangler d1 execute DB --local --env local --file ${tmpFile} 2>&1`, { timeout: 15000 });
  try { fs.unlinkSync(tmpFile); } catch {}

  log(`  Session token created (expires in 30 days)`);

  // ============================================================================
  // SUMMARY
  // ============================================================================
  log('\n=== Migration Complete ===');
  log(`Org: ${org.name} (${ORG_SLUG})`);
  log(`Tag: ${ORG_TAG || '(none)'}`);
  log(`Tables with data: ${stats.tables}`);
  log(`Total rows imported: ${stats.rows.toLocaleString()}`);

  log('\n--- Dashboard Login ---');
  log('Paste in browser console (localhost:3001):');
  log('');
  log(`  localStorage.setItem('adbliss_session', '${sessionToken}');`);
  log(`  localStorage.setItem('adbliss_current_org', '${ORG_ID}');`);
  log(`  location.reload();`);
  log('');

  // Clean up tmp dir
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
