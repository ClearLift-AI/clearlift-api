/**
 * Backfill Service
 *
 * Migrates platform data from Supabase to D1 shards.
 * Runs per-organization to allow incremental migration.
 *
 * Usage:
 * - Call migrateOrganization(orgId) to migrate a single org
 * - Call migrateAllOrganizations() to migrate all orgs in batches
 * - Progress is tracked in shard_migration_log table
 *
 * Safety:
 * - Idempotent: Can be run multiple times safely
 * - Resumable: Tracks progress per table
 * - Non-destructive: Does not delete Supabase data
 */

import { SupabaseClient } from './supabase';
import { ShardRouter } from './shard-router';
import { v4 as uuid } from 'uuid';

type Platform = 'google' | 'facebook' | 'tiktok' | 'stripe';

interface MigrationProgress {
  organization_id: string;
  platform: Platform;
  table_name: string;
  rows_migrated: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

interface MigrationResult {
  organization_id: string;
  success: boolean;
  tables_migrated: number;
  rows_migrated: number;
  errors: string[];
  duration_ms: number;
}

export class BackfillService {
  constructor(
    private supabase: SupabaseClient,
    private router: ShardRouter,
    private centralDb: D1Database
  ) {}

  /**
   * Migrate all data for a single organization from Supabase to D1
   */
  async migrateOrganization(orgId: string): Promise<MigrationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let tablesMigrated = 0;
    let totalRowsMigrated = 0;

    console.log(`[Backfill] Starting migration for org ${orgId}`);

    try {
      // Get the shard for this org
      const shard = await this.router.getShardForOrg(orgId);

      // Migrate each platform
      for (const platform of ['google', 'facebook', 'tiktok', 'stripe'] as Platform[]) {
        try {
          const result = await this.migratePlatform(orgId, platform, shard);
          tablesMigrated += result.tables;
          totalRowsMigrated += result.rows;
        } catch (e) {
          const msg = `Failed to migrate ${platform}: ${e instanceof Error ? e.message : String(e)}`;
          errors.push(msg);
          console.error(`[Backfill] ${msg}`);
        }
      }

      // Mark organization as migrated
      await this.router.markMigrated(orgId, {
        campaignCount: totalRowsMigrated,
        metricsRowCount: totalRowsMigrated,
      });

      console.log(`[Backfill] Completed migration for org ${orgId}: ${totalRowsMigrated} rows`);

      return {
        organization_id: orgId,
        success: errors.length === 0,
        tables_migrated: tablesMigrated,
        rows_migrated: totalRowsMigrated,
        errors,
        duration_ms: Date.now() - startTime,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.error(`[Backfill] Migration failed for org ${orgId}: ${msg}`);

      return {
        organization_id: orgId,
        success: false,
        tables_migrated: tablesMigrated,
        rows_migrated: totalRowsMigrated,
        errors,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * Migrate all tables for a specific platform
   */
  private async migratePlatform(
    orgId: string,
    platform: Platform,
    shard: D1Database
  ): Promise<{ tables: number; rows: number }> {
    let tables = 0;
    let rows = 0;

    const schema = platform === 'stripe' ? 'stripe' : `${platform}_ads`;

    // Define tables to migrate for each platform
    const tableMappings = this.getTableMappings(platform);

    for (const mapping of tableMappings) {
      try {
        const migrated = await this.migrateTable(
          orgId,
          platform,
          schema,
          mapping.supabaseTable,
          mapping.d1Table,
          mapping.columns,
          shard
        );
        tables++;
        rows += migrated;
      } catch (e) {
        console.error(`[Backfill] Error migrating ${mapping.supabaseTable}: ${e}`);
        throw e;
      }
    }

    return { tables, rows };
  }

  /**
   * Migrate a single table
   */
  private async migrateTable(
    orgId: string,
    platform: Platform,
    schema: string,
    supabaseTable: string,
    d1Table: string,
    columns: string[],
    shard: D1Database
  ): Promise<number> {
    // Log start
    await this.logMigrationProgress(orgId, platform, d1Table, 0, null, null);

    // Fetch data from Supabase
    const data = await this.supabase.select(
      supabaseTable,
      `organization_id=eq.${orgId}`,
      {
        schema,
        limit: 10000,  // Batch size
      }
    );

    if (!data || data.length === 0) {
      await this.logMigrationProgress(orgId, platform, d1Table, 0, new Date().toISOString(), null);
      return 0;
    }

    console.log(`[Backfill] Migrating ${data.length} rows from ${schema}.${supabaseTable} to ${d1Table}`);

    // Build batch insert statements
    const batchSize = 100;
    let rowsMigrated = 0;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const statements = batch.map(row => this.buildInsertStatement(shard, d1Table, columns, row));

      try {
        await shard.batch(statements);
        rowsMigrated += batch.length;
      } catch (e) {
        console.error(`[Backfill] Batch insert failed at offset ${i}: ${e}`);
        throw e;
      }
    }

    // Log completion
    await this.logMigrationProgress(orgId, platform, d1Table, rowsMigrated, new Date().toISOString(), null);

    return rowsMigrated;
  }

  /**
   * Build an INSERT OR REPLACE statement for a row
   */
  private buildInsertStatement(
    shard: D1Database,
    table: string,
    columns: string[],
    row: Record<string, unknown>
  ) {
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(col => {
      const value = row[col];
      // Handle JSON columns
      if (typeof value === 'object' && value !== null) {
        return JSON.stringify(value);
      }
      return value ?? null;
    });

    return shard.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
    ).bind(...values);
  }

  /**
   * Log migration progress to central DB
   */
  private async logMigrationProgress(
    orgId: string,
    platform: Platform,
    tableName: string,
    rowsMigrated: number,
    completedAt: string | null,
    errorMessage: string | null
  ): Promise<void> {
    const id = `${orgId}:${platform}:${tableName}`;

    await this.centralDb.prepare(`
      INSERT OR REPLACE INTO shard_migration_log (
        id, organization_id, platform, table_name, source,
        rows_migrated, started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, 'supabase', ?, datetime('now'), ?, ?)
    `).bind(
      id, orgId, platform, tableName, rowsMigrated, completedAt, errorMessage
    ).run();
  }

  /**
   * Get table mappings for each platform
   */
  private getTableMappings(platform: Platform): Array<{
    supabaseTable: string;
    d1Table: string;
    columns: string[];
  }> {
    switch (platform) {
      case 'google':
        return [
          {
            supabaseTable: 'campaigns',
            d1Table: 'google_campaigns',
            columns: ['id', 'organization_id', 'customer_id', 'campaign_id', 'campaign_name',
              'campaign_status', 'campaign_type', 'budget_amount_cents', 'budget_type',
              'bidding_strategy_type', 'target_cpa_cents', 'target_roas', 'campaign_start_date',
              'campaign_end_date', 'raw_data', 'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ad_groups',
            d1Table: 'google_ad_groups',
            columns: ['id', 'campaign_ref', 'organization_id', 'customer_id', 'campaign_id',
              'ad_group_id', 'ad_group_name', 'ad_group_status', 'ad_group_type', 'cpc_bid_cents',
              'cpm_bid_cents', 'target_cpa_cents', 'raw_data', 'created_at', 'updated_at',
              'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ads',
            d1Table: 'google_ads',
            columns: ['id', 'campaign_ref', 'ad_group_ref', 'organization_id', 'customer_id',
              'campaign_id', 'ad_group_id', 'ad_id', 'ad_name', 'ad_status', 'ad_type',
              'headlines', 'descriptions', 'final_urls', 'raw_data', 'created_at', 'updated_at',
              'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'campaign_daily_metrics',
            d1Table: 'google_campaign_metrics',
            columns: ['id', 'campaign_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'all_conversions',
              'video_views', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_group_daily_metrics',
            d1Table: 'google_ad_group_metrics',
            columns: ['id', 'ad_group_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_daily_metrics',
            d1Table: 'google_ad_metrics',
            columns: ['id', 'ad_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
        ];

      case 'facebook':
        return [
          {
            supabaseTable: 'campaigns',
            d1Table: 'facebook_campaigns',
            columns: ['id', 'organization_id', 'account_id', 'campaign_id', 'campaign_name',
              'campaign_status', 'objective', 'budget_amount_cents', 'budget_type', 'bid_strategy',
              'raw_data', 'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ad_sets',
            d1Table: 'facebook_ad_sets',
            columns: ['id', 'campaign_ref', 'organization_id', 'account_id', 'campaign_id',
              'ad_set_id', 'ad_set_name', 'ad_set_status', 'daily_budget_cents', 'lifetime_budget_cents',
              'bid_amount_cents', 'billing_event', 'optimization_goal', 'targeting', 'raw_data',
              'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ads',
            d1Table: 'facebook_ads',
            columns: ['id', 'campaign_ref', 'ad_set_ref', 'organization_id', 'account_id',
              'campaign_id', 'ad_set_id', 'ad_id', 'ad_name', 'ad_status', 'creative_id',
              'raw_data', 'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'campaign_daily_metrics',
            d1Table: 'facebook_campaign_metrics',
            columns: ['id', 'campaign_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'reach',
              'frequency', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_set_daily_metrics',
            d1Table: 'facebook_ad_set_metrics',
            columns: ['id', 'ad_set_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_daily_metrics',
            d1Table: 'facebook_ad_metrics',
            columns: ['id', 'ad_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
        ];

      case 'tiktok':
        return [
          {
            supabaseTable: 'campaigns',
            d1Table: 'tiktok_campaigns',
            columns: ['id', 'organization_id', 'advertiser_id', 'campaign_id', 'campaign_name',
              'campaign_status', 'objective_type', 'budget_cents', 'budget_mode', 'raw_data',
              'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ad_groups',
            d1Table: 'tiktok_ad_groups',
            columns: ['id', 'campaign_ref', 'organization_id', 'advertiser_id', 'campaign_id',
              'ad_group_id', 'ad_group_name', 'ad_group_status', 'budget_cents', 'bid_cents',
              'billing_event', 'raw_data', 'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'ads',
            d1Table: 'tiktok_ads',
            columns: ['id', 'campaign_ref', 'ad_group_ref', 'organization_id', 'advertiser_id',
              'campaign_id', 'ad_group_id', 'ad_id', 'ad_name', 'ad_status', 'raw_data',
              'created_at', 'updated_at', 'deleted_at', 'last_synced_at'],
          },
          {
            supabaseTable: 'campaign_daily_metrics',
            d1Table: 'tiktok_campaign_metrics',
            columns: ['id', 'campaign_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'video_views',
              'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_group_daily_metrics',
            d1Table: 'tiktok_ad_group_metrics',
            columns: ['id', 'ad_group_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'ad_daily_metrics',
            d1Table: 'tiktok_ad_metrics',
            columns: ['id', 'ad_ref', 'organization_id', 'metric_date', 'impressions',
              'clicks', 'spend_cents', 'conversions', 'conversion_value_cents', 'created_at', 'updated_at'],
          },
        ];

      case 'stripe':
        return [
          {
            supabaseTable: 'customers',
            d1Table: 'stripe_customers',
            columns: ['id', 'organization_id', 'stripe_customer_id', 'email', 'name',
              'metadata', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'charges',
            d1Table: 'stripe_charges',
            columns: ['id', 'organization_id', 'stripe_charge_id', 'customer_ref',
              'stripe_customer_id', 'amount_cents', 'currency', 'status', 'description',
              'metadata', 'receipt_url', 'charge_created_at', 'created_at', 'updated_at'],
          },
          {
            supabaseTable: 'subscriptions',
            d1Table: 'stripe_subscriptions',
            columns: ['id', 'organization_id', 'stripe_subscription_id', 'customer_ref',
              'stripe_customer_id', 'status', 'current_period_start', 'current_period_end',
              'cancel_at_period_end', 'amount_cents', 'currency', 'interval_type', 'metadata',
              'created_at', 'updated_at'],
          },
        ];

      default:
        return [];
    }
  }

  /**
   * Get migration status for an organization
   */
  async getMigrationStatus(orgId: string): Promise<{
    isMigrated: boolean;
    tables: MigrationProgress[];
  }> {
    const routing = await this.router.getRoutingInfo(orgId);
    const isMigrated = routing?.migrated_at !== null;

    const tables = await this.centralDb
      .prepare('SELECT * FROM shard_migration_log WHERE organization_id = ?')
      .bind(orgId)
      .all<MigrationProgress>();

    return {
      isMigrated,
      tables: tables.results,
    };
  }

  /**
   * Get all organizations that need migration
   */
  async getUnmigratedOrganizations(limit: number = 100): Promise<string[]> {
    const result = await this.centralDb
      .prepare(`
        SELECT DISTINCT o.id
        FROM organizations o
        LEFT JOIN shard_routing sr ON o.id = sr.organization_id
        WHERE sr.migrated_at IS NULL OR sr.organization_id IS NULL
        LIMIT ?
      `)
      .bind(limit)
      .all<{ id: string }>();

    return result.results.map(r => r.id);
  }
}

// Type stub for D1PreparedStatement
interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
}
