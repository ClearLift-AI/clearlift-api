/**
 * Schema V2 validation for Analysis Workflow SQL queries.
 *
 * Runs every SQL query used by the analysis workflow, exploration tools,
 * and metrics fetcher against the V2 consolidated schema (migrations-adbliss-core +
 * migrations-adbliss-analytics) to catch column/table mismatches before production.
 *
 * These tests don't validate data correctness — they validate that the SQL
 * compiles and references real columns. A "no such column" error here means
 * the code is using a stale column name from the old schema.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const ORG_ID = 'test-schema-v2-org';
const ORG_TAG = 'test-schema-v2';
const DATE_START = '2026-01-01';
const DATE_END = '2026-02-01';

/**
 * Helper: run a SQL query with dummy bind params to validate it compiles.
 * We only care that D1/SQLite doesn't throw "no such column" or "no such table".
 */
async function validateQuery(db: D1Database, sql: string, params: any[] = []) {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      await stmt.bind(...params).all();
    } else {
      await stmt.all();
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    // Re-throw schema errors (column/table not found) — these are real bugs
    if (msg.includes('no such column') || msg.includes('no such table') || msg.includes('SQLITE_ERROR')) {
      throw new Error(`Schema mismatch: ${msg}\n  SQL: ${sql.trim().substring(0, 200)}`);
    }
    // Other errors (e.g. no rows, constraint violations) are fine — query compiled
  }
}

describe('Analysis Workflow SQL vs V2 Schema', () => {
  // ─── analysis-workflow.ts queries ────────────────────────────────────────

  describe('analysis-workflow.ts', () => {
    it('cleanup_expired: DELETE FROM ai_decisions', async () => {
      await validateQuery(env.ADBLISS_DB,
        `DELETE FROM ai_decisions WHERE organization_id = ? AND status = 'pending'`,
        [ORG_ID]
      );
    });

    it('filter_active_entities: SELECT entity_ref from ad_metrics (active window)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT entity_ref, SUM(spend_cents) as total_spend
         FROM ad_metrics
         WHERE organization_id = ?
           AND metric_date >= ?
           AND metric_date <= ?
           AND (spend_cents > 0 OR impressions > 0)
         GROUP BY entity_ref
         ORDER BY total_spend DESC
         LIMIT ?`,
        [ORG_ID, DATE_START, DATE_END, 100]
      );
    });

    it('filter_active_entities: SELECT entity_ref from ad_metrics (historical fallback)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT entity_ref, SUM(spend_cents) as total_spend
         FROM ad_metrics
         WHERE organization_id = ?
         GROUP BY entity_ref`,
        [ORG_ID]
      );
    });

    it('analysis_events: INSERT INTO analysis_events', async () => {
      await validateQuery(env.ADBLISS_DB,
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status)
         VALUES (?, ?, 0, 'entity_tree', NULL, ?, NULL)`,
        ['job-1', ORG_ID, '{}']
      );
    });

    it('generate_cac_predictions: SELECT cac_cents FROM cac_history', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT cac_cents FROM cac_history
         WHERE organization_id = ?
         ORDER BY date DESC
         LIMIT 1`,
        [ORG_ID]
      );
    });

    it('generate_cac_predictions: SELECT spend/conversions from ad_metrics', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT SUM(spend_cents) as spend, SUM(conversions) as conversions
         FROM ad_metrics
         WHERE organization_id = ?
           AND entity_type = 'campaign'
           AND metric_date >= date('now', '-7 days')`,
        [ORG_ID]
      );
    });

    it('generate_cac_predictions: INSERT INTO cac_predictions', async () => {
      await validateQuery(env.ADBLISS_DB,
        `INSERT INTO cac_predictions (
           organization_id, prediction_date, predicted_cac_cents,
           recommendation_ids, analysis_run_id, assumptions
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, prediction_date)
         DO UPDATE SET
           predicted_cac_cents = excluded.predicted_cac_cents,
           recommendation_ids = excluded.recommendation_ids,
           analysis_run_id = excluded.analysis_run_id,
           assumptions = excluded.assumptions,
           created_at = datetime('now')`,
        [ORG_ID, '2026-02-01', 1000, '[]', 'run-1', '{}']
      );
    });

    it('ai_decisions: SELECT pending recommendations with simulation_data', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT id, simulation_data, predicted_impact
         FROM ai_decisions
         WHERE organization_id = ?
           AND status = 'pending'
           AND simulation_data IS NOT NULL`,
        [ORG_ID]
      );
    });

    it('journey_analytics: SELECT journey stats', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT total_sessions, converting_sessions, conversion_rate,
                avg_path_length, channel_distribution
         FROM journey_analytics
         WHERE org_tag = ?
         ORDER BY computed_at DESC LIMIT 1`,
        [ORG_TAG]
      );
    });

    it('daily_metrics: SELECT traffic summary (uses date, users)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT SUM(sessions) as sessions, SUM(users) as users,
                SUM(conversions) as conversions, SUM(revenue_cents) as revenue_cents
         FROM daily_metrics
         WHERE org_tag = ?
           AND date >= date('now', '-7 days')`,
        [ORG_TAG]
      );
    });

    it('cac_history: SELECT CAC trend', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT date, cac_cents FROM cac_history
         WHERE organization_id = ?
         ORDER BY date DESC LIMIT 14`,
        [ORG_ID]
      );
    });

    it('connector_events: Shopify revenue (uses status, not platform_status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as orders, COALESCE(SUM(value_cents), 0) as revenue_cents,
                AVG(value_cents) as aov_cents,
                COUNT(DISTINCT customer_external_id) as unique_customers
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'shopify'
           AND transacted_at >= date('now', '-7 days')
           AND status IN ('succeeded', 'paid', 'completed', 'active')`,
        [ORG_ID]
      );
    });

    it('connector_events: CRM deals (uses status, not platform_status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as deals,
                COUNT(CASE WHEN status = 'closedwon' THEN 1 END) as won,
                COUNT(CASE WHEN status = 'closedlost' THEN 1 END) as lost,
                COUNT(CASE WHEN status NOT IN ('closedwon', 'closedlost') THEN 1 END) as open_deals,
                SUM(value_cents) as pipeline_cents,
                SUM(CASE WHEN status = 'closedwon' THEN value_cents ELSE 0 END) as won_cents
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'hubspot' AND event_type = 'deal'
           AND transacted_at >= date('now', '-7 days')`,
        [ORG_ID]
      );
    });

    it('connector_events: Stripe subscriptions (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as total,
                COUNT(CASE WHEN status IN ('active', 'trialing') THEN 1 END) as active,
                COUNT(CASE WHEN status IN ('canceled', 'cancelled') THEN 1 END) as canceled,
                COALESCE(SUM(CASE WHEN status IN ('active', 'trialing') THEN value_cents ELSE 0 END), 0) as mrr_cents
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'stripe'
           AND event_type LIKE '%subscription%'`,
        [ORG_ID]
      );
    });

    it('connector_events: Email/SMS engagement', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT event_type, COUNT(*) as count
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform IN ('sendgrid', 'attentive', 'mailchimp', 'tracking_link')
           AND transacted_at >= date('now', '-7 days')
         GROUP BY event_type`,
        [ORG_ID]
      );
    });

    it('org_tag_mappings: resolve short_tag', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1`,
        [ORG_ID]
      );
    });

    it('ai_optimization_settings: load LLM config', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT custom_instructions, llm_default_provider, llm_claude_model,
                llm_gemini_model, llm_max_recommendations, llm_enable_exploration
         FROM ai_optimization_settings WHERE org_id = ?`,
        [ORG_ID]
      );
    });

    it('analysis_jobs: mark stuck jobs failed', async () => {
      await validateQuery(env.ADBLISS_DB,
        `UPDATE analysis_jobs
         SET status = 'failed', error_message = 'Timed out after 30 minutes'
         WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
           AND created_at < datetime('now', '-30 minutes')`,
        [ORG_ID]
      );
    });

    it('analysis_jobs: dedup check', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT id, status FROM analysis_jobs
         WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
           AND created_at > datetime('now', '-30 minutes')
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_ID]
      );
    });

    it('ai_decisions: expire old pending', async () => {
      await validateQuery(env.ADBLISS_DB,
        `UPDATE ai_decisions
         SET status = 'expired'
         WHERE organization_id = ? AND status = 'pending'
           AND expires_at < datetime('now')`,
        [ORG_ID]
      );
    });

    it('ai_decisions: recent recommendations history', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT tool, parameters, reason, status,
                CAST(julianday('now') - julianday(reviewed_at) AS INTEGER) as days_ago
         FROM ai_decisions
         WHERE organization_id = ?
           AND status IN ('approved', 'rejected')
           AND reviewed_at >= ?
         ORDER BY reviewed_at DESC
         LIMIT 30`,
        [ORG_ID, '2026-01-01T00:00:00Z']
      );
    });

    it('analysis_summaries: INSERT summary', async () => {
      await validateQuery(env.ADBLISS_DB,
        `INSERT INTO analysis_summaries (
           id, organization_id, level, platform, entity_id, entity_name,
           summary, metrics_snapshot, days, analysis_run_id, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['id-1', ORG_ID, 'campaign', 'google', 'entity-1', 'Test', 'summary', '{}', 7, 'run-1', '2026-03-01T00:00:00Z']
      );
    });

    it('ai_decisions: dedup check for recommendation', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT id FROM ai_decisions
         WHERE organization_id = ? AND tool = ? AND platform = ? AND entity_type = ? AND entity_id = ?
           AND status = 'pending'
         LIMIT 1`,
        [ORG_ID, 'set_budget', 'google', 'campaign', 'entity-1']
      );
    });

    it('ai_decisions: INSERT recommendation', async () => {
      await validateQuery(env.ADBLISS_DB,
        `INSERT INTO ai_decisions (
           id, organization_id, tool, platform, entity_type, entity_id, entity_name,
           parameters, current_state, reason, predicted_impact, confidence, status, expires_at,
           supporting_data, simulation_data, simulation_confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        ['id-2', ORG_ID, 'set_budget', 'google', 'campaign', 'entity-1', 'Test Campaign',
         '{}', '{}', 'test reason', 5.0, 'medium', '2026-03-01', '{}', null, null]
      );
    });
  });

  // ─── entity-tree.ts queries ──────────────────────────────────────────────

  describe('entity-tree.ts', () => {
    it('ad_campaigns: SELECT campaigns', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, platform, account_id, campaign_id, campaign_name, campaign_status
         FROM ad_campaigns
         WHERE organization_id = ? AND campaign_status != 'REMOVED'`,
        [ORG_ID]
      );
    });

    it('ad_groups: SELECT ad groups', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, platform, account_id, campaign_id, campaign_ref, ad_group_id, ad_group_name, ad_group_status
         FROM ad_groups
         WHERE organization_id = ?`,
        [ORG_ID]
      );
    });

    it('ads: SELECT ads', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, platform, account_id, campaign_id, ad_group_id, ad_group_ref, ad_id, ad_name, ad_status
         FROM ads
         WHERE organization_id = ?`,
        [ORG_ID]
      );
    });

    it('ad_campaigns: DISTINCT platforms', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT DISTINCT platform FROM ad_campaigns WHERE organization_id = ?`,
        [ORG_ID]
      );
    });
  });

  // ─── metrics-fetcher.ts queries ──────────────────────────────────────────

  describe('metrics-fetcher.ts', () => {
    it('ad_metrics: fetchMetrics with entity_ref', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT metric_date,
                COALESCE(impressions, 0) as impressions,
                COALESCE(clicks, 0) as clicks,
                COALESCE(spend_cents, 0) as spend_cents,
                COALESCE(conversions, 0) as conversions,
                COALESCE(conversion_value_cents, 0) as conversion_value_cents
         FROM ad_metrics
         WHERE entity_ref = ?
           AND entity_type = ?
           AND platform = ?
           AND metric_date >= ?
           AND metric_date <= ?
         ORDER BY metric_date ASC`,
        ['entity-1', 'campaign', 'google', DATE_START, DATE_END]
      );
    });
  });

  // ─── exploration-tools.ts queries ────────────────────────────────────────

  describe('exploration-tools.ts', () => {
    it('connector_events: verified revenue (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COALESCE(SUM(value_cents), 0) as total_cents, COUNT(*) as count
         FROM connector_events
         WHERE organization_id = ?
           AND transacted_at >= ? AND transacted_at <= ?
           AND status IN ('succeeded', 'paid', 'completed', 'active')`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('connector_events: Stripe charges (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT external_id as charge_id, value_cents as amount_cents, currency,
                status, customer_external_id as customer_id,
                transacted_at as created_at, metadata
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'stripe'
           AND transacted_at >= ? AND transacted_at <= ?`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('connector_events: Stripe charges with status filter', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT external_id as charge_id, value_cents as amount_cents, currency,
                status, customer_external_id as customer_id,
                transacted_at as created_at, metadata
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'stripe'
           AND transacted_at >= ? AND transacted_at <= ?
           AND status = ?`,
        [ORG_ID, DATE_START, DATE_END, 'succeeded']
      );
    });

    it('connector_events: Jobber revenue (uses external_id, status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT external_id as job_id, value_cents as total_amount_cents,
                customer_external_id as client_id, transacted_at as completed_at
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'jobber'
           AND status IN ('completed', 'paid', 'succeeded')
           AND transacted_at >= ? AND transacted_at <= ?
         ORDER BY transacted_at ASC`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('connector_events: Stripe subscriptions (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, external_id, customer_external_id, value_cents,
                status, event_type, transacted_at,
                metadata, currency
         FROM connector_events
         WHERE organization_id = ? AND source_platform = 'stripe' AND event_type LIKE '%subscription%'`,
        [ORG_ID]
      );
    });

    it('connector_events: CRM deals (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, external_id, event_type,
                status, value_cents, metadata, transacted_at
         FROM connector_events
         WHERE organization_id = ?
           AND event_type = 'deal'
           AND transacted_at >= ?`,
        [ORG_ID, DATE_START]
      );
    });

    it('connector_events: CRM deals with status filter', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, external_id, event_type,
                status, value_cents, metadata, transacted_at
         FROM connector_events
         WHERE organization_id = ?
           AND event_type = 'deal'
           AND transacted_at >= ?
           AND status IN (?, ?)`,
        [ORG_ID, DATE_START, 'closedwon', 'won']
      );
    });

    it('connector_events: unified data CRM aggregation (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT source_platform,
                COUNT(*) as deals,
                SUM(CASE WHEN status IN ('closedwon', 'won') THEN 1 ELSE 0 END) as won,
                SUM(value_cents) as total_value_cents
         FROM connector_events
         WHERE organization_id = ?
           AND event_type = 'deal'
           AND transacted_at >= ?
         GROUP BY source_platform`,
        [ORG_ID, DATE_START]
      );
    });

    it('connector_events: Shopify orders (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT external_id as shopify_order_id,
                value_cents as total_price_cents, currency,
                status as financial_status,
                customer_external_id,
                transacted_at as shopify_created_at,
                metadata
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'shopify'
           AND transacted_at >= ?`,
        [ORG_ID, DATE_START]
      );
    });

    it('connector_events: e-commerce orders (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, external_id, event_type, status,
                value_cents, metadata, transacted_at
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform IN (?, ?)
           AND event_type = 'order'
           AND transacted_at >= ?
         ORDER BY transacted_at DESC LIMIT 2000`,
        [ORG_ID, 'shopify', 'stripe', DATE_START]
      );
    });

    it('connector_events: status distribution (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT status, COUNT(*) as count, SUM(value_cents) as value_cents
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform IN (?, ?)
           AND transacted_at >= ?
         GROUP BY status
         ORDER BY count DESC LIMIT 20`,
        [ORG_ID, 'stripe', 'shopify', DATE_START]
      );
    });

    it('conversions: query by conversion_timestamp (not converted_at)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT conversion_source as goal_id,
                conversion_source as goal_name,
                COUNT(*) as conversion_count,
                COALESCE(SUM(value_cents), 0) as total_value_cents
         FROM conversions
         WHERE organization_id = ?
           AND conversion_timestamp >= ?
         GROUP BY conversion_source`,
        [ORG_ID, DATE_START]
      );
    });

    it('conversions: list active connectors (uses conversion_source, conversion_timestamp)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT conversion_source as source, COUNT(*) as count, MAX(conversion_timestamp) as last_sync
         FROM conversions
         WHERE organization_id = ?
         GROUP BY conversion_source`,
        [ORG_ID]
      );
    });

    it('conversions: attribution quality check', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, conversion_source, link_method, link_confidence,
                value_cents, currency, conversion_timestamp, source_platform
         FROM conversions
         WHERE organization_id = ?
           AND link_confidence >= ?
           AND conversion_timestamp >= ?
           AND conversion_timestamp <= ?`,
        [ORG_ID, 0.5, DATE_START, DATE_END]
      );
    });

    it('conversions: platform vs verified comparison', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as verified_count,
                SUM(value_cents) as verified_value_cents,
                AVG(link_confidence) as avg_confidence,
                link_method
         FROM conversions
         WHERE organization_id = ?
           AND link_confidence >= ?
           AND conversion_timestamp >= ?
           AND conversion_timestamp <= ?
         GROUP BY link_method`,
        [ORG_ID, 0.7, DATE_START, DATE_END]
      );
    });

    it('daily_metrics: date column (not metric_date)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as count, MAX(date) as last_date
         FROM daily_metrics
         WHERE org_tag = ?`,
        [ORG_TAG]
      );
    });

    it('journey_analytics: full query', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT total_sessions, converting_sessions, conversion_rate,
                avg_path_length, channel_distribution, common_paths, transition_matrix,
                computed_at
         FROM journey_analytics
         WHERE org_tag = ?
         ORDER BY computed_at DESC
         LIMIT 1`,
        [ORG_TAG]
      );
    });

    it('customer_identities: count', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as count, MAX(updated_at) as last_sync
         FROM customer_identities
         WHERE organization_id = ?`,
        [ORG_ID]
      );
    });
  });

  // ─── simulation-service.ts queries ───────────────────────────────────────

  describe('simulation-service.ts', () => {
    it('ad_metrics: portfolio metrics with entity_ref', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT entity_ref as id, entity_ref as name, platform,
                ? as entity_type,
                SUM(spend_cents) as spend_cents,
                SUM(conversions) as conversions,
                SUM(impressions) as impressions,
                SUM(clicks) as clicks,
                CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) ELSE 0 END as ctr,
                CASE WHEN SUM(clicks) > 0 THEN SUM(spend_cents) / SUM(clicks) ELSE 0 END as cpc_cents
         FROM ad_metrics
         WHERE organization_id = ?
           AND entity_type = ?
           AND metric_date >= date('now', '-7 days')
           AND spend_cents > 0
         GROUP BY entity_ref, platform
         HAVING conversions > 0`,
        ['campaign', ORG_ID, 'campaign']
      );
    });

    it('ad_metrics: entity history', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT metric_date as date, spend_cents, conversions
         FROM ad_metrics
         WHERE organization_id = ?
           AND entity_ref = ?
           AND entity_type = ?
           AND metric_date >= date('now', '-30 days')
           AND spend_cents > 0
         ORDER BY date ASC`,
        [ORG_ID, 'entity-1', 'campaign']
      );
    });
  });

  // ─── Negative tests: verify OLD column names fail ────────────────────────

  describe('Regression guards: old column names must fail', () => {
    it('FAILS: campaign_id in ad_metrics (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT campaign_id FROM ad_metrics WHERE organization_id = ?`,
          [ORG_ID]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: platform_status in connector_events (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT platform_status FROM connector_events WHERE organization_id = ?`,
          [ORG_ID]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: platform_external_id in connector_events (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT platform_external_id FROM connector_events WHERE organization_id = ?`,
          [ORG_ID]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: raw_metadata in connector_events (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT raw_metadata FROM connector_events WHERE organization_id = ?`,
          [ORG_ID]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: unique_users in daily_metrics (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT unique_users FROM daily_metrics WHERE org_tag = ?`,
          [ORG_TAG]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: metric_date in daily_metrics (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT metric_date FROM daily_metrics WHERE org_tag = ?`,
          [ORG_TAG]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: converted_at in conversions (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT id FROM conversions WHERE organization_id = ? AND converted_at >= ?`,
          [ORG_ID, DATE_START]
        )
      ).rejects.toThrow('Schema mismatch');
    });
  });

  // ─── Connector endpoint SQL (revenue-sources, aggregation, analytics) ───

  describe('revenue-sources (stripe/shopify/jobber)', () => {
    it('Stripe: revenue summary (uses status, value_cents)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT
           SUM(CASE WHEN status IN ('succeeded', 'paid', 'active') THEN 1 ELSE 0 END) as conversions,
           SUM(CASE WHEN status IN ('succeeded', 'paid', 'active') THEN value_cents ELSE 0 END) as revenue_cents,
           COUNT(DISTINCT customer_external_id) as unique_customers
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'stripe'
           AND transacted_at >= datetime('now', '-24 hours')`,
        [ORG_ID]
      );
    });

    it('Shopify: revenue summary (uses status, value_cents)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT
           SUM(CASE WHEN status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as conversions,
           SUM(CASE WHEN status IN ('paid', 'completed', 'succeeded') THEN COALESCE(value_cents, 0) ELSE 0 END) as revenue_cents,
           COUNT(DISTINCT customer_external_id) as unique_customers
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'shopify'
           AND transacted_at >= datetime('now', '-24 hours')`,
        [ORG_ID]
      );
    });

    it('Jobber: revenue summary (uses status, value_cents)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT
           SUM(CASE WHEN status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as conversions,
           SUM(CASE WHEN status IN ('paid', 'completed', 'succeeded') THEN value_cents ELSE 0 END) as revenue_cents,
           COUNT(DISTINCT customer_external_id) as unique_customers
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'jobber'
           AND transacted_at >= datetime('now', '-24 hours')`,
        [ORG_ID]
      );
    });

    it('Stripe: MRR subscription query (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as total,
                COUNT(CASE WHEN status IN ('active', 'trialing') THEN 1 END) as active,
                COUNT(CASE WHEN status IN ('canceled', 'cancelled', 'unpaid') THEN 1 END) as churned,
                COALESCE(SUM(CASE WHEN status IN ('active', 'trialing') THEN value_cents ELSE 0 END), 0) as mrr_cents
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'stripe'
           AND event_type LIKE '%subscription%'`,
        [ORG_ID]
      );
    });
  });

  describe('aggregation-service.ts', () => {
    it('connector daily summary (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT source_platform, COUNT(*) as events,
                SUM(CASE WHEN status IN ('succeeded', 'paid', 'completed', 'active') THEN value_cents ELSE 0 END) as revenue_cents
         FROM connector_events
         WHERE organization_id = ?
           AND transacted_at >= ? AND transacted_at < ?
         GROUP BY source_platform`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });
  });

  describe('analytics endpoints', () => {
    it('platforms.ts: connector conversions (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as conversions, COALESCE(SUM(value_cents), 0) as revenue_cents
         FROM connector_events
         WHERE organization_id = ?
           AND transacted_at >= ? AND transacted_at <= ?
           AND status IN ('succeeded', 'paid', 'active')`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('click-attribution.ts: total conversions (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COUNT(*) as total
         FROM connector_events
         WHERE organization_id = ?
           AND transacted_at >= ? AND transacted_at <= ?
           AND status IN ('succeeded', 'paid', 'completed', 'active')`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('journey.ts: connector events (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, external_id, event_type,
                status, value_cents, customer_external_id,
                transacted_at, metadata
         FROM connector_events
         WHERE organization_id = ?
           AND status IN ('succeeded', 'paid', 'completed', 'active')
           AND transacted_at >= ? AND transacted_at <= ?
         ORDER BY transacted_at DESC LIMIT 500`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('jobber.ts: invoices (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT external_id as invoice_number, value_cents, status,
                customer_external_id, transacted_at, metadata
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = 'jobber'
           AND status IN ('completed', 'paid', 'succeeded')
           AND transacted_at >= ? AND transacted_at <= ?`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });

    it('connectors/filters.ts: test filter (uses external_id, status, metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, external_id, event_type,
                status, value_cents, metadata, transacted_at
         FROM connector_events
         WHERE organization_id = ?
           AND source_platform = ?
         ORDER BY transacted_at DESC LIMIT 10`,
        [ORG_ID, 'stripe']
      );
    });
  });

  describe('attribution-workflow.ts', () => {
    it('conversion_attribution: joined with conversions (uses conversion_timestamp)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT ca.id, ca.conversion_id, ca.model, ca.touchpoint_platform,
                ca.credit_percent, ca.credit_value_cents,
                c.conversion_timestamp, c.conversion_source, c.value_cents
         FROM conversion_attribution ca
         JOIN conversions c ON c.id = ca.conversion_id
         WHERE ca.organization_id = ?
           AND c.conversion_timestamp >= ?
         ORDER BY c.anonymous_id, c.conversion_timestamp`,
        [ORG_ID, DATE_START]
      );
    });

    it('connector_events fallback: uses status and metadata (not platform_status/raw_metadata)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT id, source_platform, value_cents, metadata, transacted_at
         FROM connector_events
         WHERE organization_id = ?
           AND status IN ('succeeded', 'paid', 'completed', 'active')
           AND transacted_at >= ?`,
        [ORG_ID, DATE_START]
      );
    });
  });

  describe('smart-attribution.ts', () => {
    it('connector revenue (uses status)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT COALESCE(SUM(value_cents), 0) as total_cents, COUNT(*) as count
         FROM connector_events
         WHERE organization_id = ?
           AND transacted_at >= ? AND transacted_at <= ?
           AND status IN ('succeeded', 'paid', 'completed', 'active')`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });
  });

  describe('cron: click-extraction + index', () => {
    it('conversions by date (uses conversion_timestamp)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT DATE(conversion_timestamp) as date,
                COUNT(*) as conversions,
                COALESCE(SUM(value_cents), 0) as revenue_cents
         FROM conversions
         WHERE organization_id = ?
           AND DATE(conversion_timestamp) >= date('now', '-30 days')
         GROUP BY DATE(conversion_timestamp)`,
        [ORG_ID]
      );
    });

    it('click-extraction: conversion-based click matching (uses conversion_timestamp)', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT c.id, c.conversion_source, c.conversion_timestamp, c.anonymous_id
         FROM conversions c
         WHERE c.organization_id = ?
           AND c.conversion_timestamp >= ?
           AND c.conversion_timestamp <= ?
         ORDER BY c.conversion_timestamp DESC
         LIMIT 20`,
        [ORG_ID, DATE_START, DATE_END]
      );
    });
  });

  describe('daily_metrics: V2 column names (date, users)', () => {
    it('daily_metrics: uses date not metric_date', async () => {
      await validateQuery(env.ADBLISS_ANALYTICS_DB,
        `SELECT date, sessions, users, conversions, revenue_cents
         FROM daily_metrics
         WHERE org_tag = ?
           AND date >= ?
         ORDER BY date ASC`,
        [ORG_TAG, DATE_START]
      );
    });

    it('FAILS: metric_date in daily_metrics (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT metric_date FROM daily_metrics WHERE org_tag = ?`,
          [ORG_TAG]
        )
      ).rejects.toThrow('Schema mismatch');
    });

    it('FAILS: unique_users in daily_metrics (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_ANALYTICS_DB,
          `SELECT unique_users FROM daily_metrics WHERE org_tag = ?`,
          [ORG_TAG]
        )
      ).rejects.toThrow('Schema mismatch');
    });
  });

  describe('org_tag_mappings: V2 column names', () => {
    it('uses short_tag not org_tag', async () => {
      await validateQuery(env.ADBLISS_DB,
        `SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1`,
        [ORG_ID]
      );
    });

    it('FAILS: org_tag column in org_tag_mappings (old schema)', async () => {
      await expect(
        validateQuery(env.ADBLISS_DB,
          `SELECT org_tag FROM org_tag_mappings WHERE organization_id = ?`,
          [ORG_ID]
        )
      ).rejects.toThrow('Schema mismatch');
    });
  });
});
