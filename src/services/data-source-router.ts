/**
 * Data Source Router
 *
 * Routes reads and writes to the correct data source (Supabase or D1)
 * based on per-organization configuration in shard_routing table.
 *
 * Migration path per org:
 * 1. read=supabase, write=supabase (default)
 * 2. read=supabase, write=dual (start populating D1)
 * 3. Backfill historical data to D1
 * 4. read=d1, write=dual (switch reads, verify)
 * 5. read=d1, write=d1 (fully migrated, disable Supabase)
 */

import { SupabaseClient } from './supabase';
import { ShardRouter } from './shard-router';

export type ReadSource = 'supabase' | 'd1';
export type WriteMode = 'supabase' | 'dual' | 'd1';

export interface OrgRoutingConfig {
  organization_id: string;
  shard_id: number;
  read_source: ReadSource;
  write_mode: WriteMode;
  migrated_at: string | null;
  verified_at: string | null;
  d1_enabled_at: string | null;
}

export class DataSourceRouter {
  private configCache: Map<string, OrgRoutingConfig> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(
    private centralDb: D1Database,
    private supabase: SupabaseClient,
    private shardRouter: ShardRouter
  ) {}

  /**
   * Get routing config for an organization
   */
  async getRoutingConfig(orgId: string): Promise<OrgRoutingConfig> {
    // Check cache
    const cached = this.configCache.get(orgId);
    const expiry = this.cacheExpiry.get(orgId);
    if (cached && expiry && Date.now() < expiry) {
      return cached;
    }

    // Fetch from DB
    const result = await this.centralDb
      .prepare(`
        SELECT organization_id, shard_id, read_source, write_mode,
               migrated_at, verified_at, d1_enabled_at
        FROM shard_routing
        WHERE organization_id = ?
      `)
      .bind(orgId)
      .first<OrgRoutingConfig>();

    if (result) {
      this.configCache.set(orgId, result);
      this.cacheExpiry.set(orgId, Date.now() + this.CACHE_TTL_MS);
      return result;
    }

    // Default config for orgs not in routing table
    const defaultConfig: OrgRoutingConfig = {
      organization_id: orgId,
      shard_id: 0,
      read_source: 'supabase',
      write_mode: 'supabase',
      migrated_at: null,
      verified_at: null,
      d1_enabled_at: null,
    };

    return defaultConfig;
  }

  /**
   * Check if org should read from D1
   */
  async shouldReadFromD1(orgId: string): Promise<boolean> {
    const config = await this.getRoutingConfig(orgId);
    return config.read_source === 'd1';
  }

  /**
   * Check if org should write to D1 (either dual or d1-only)
   */
  async shouldWriteToD1(orgId: string): Promise<boolean> {
    const config = await this.getRoutingConfig(orgId);
    return config.write_mode === 'dual' || config.write_mode === 'd1';
  }

  /**
   * Check if org should write to Supabase (either supabase or dual)
   */
  async shouldWriteToSupabase(orgId: string): Promise<boolean> {
    const config = await this.getRoutingConfig(orgId);
    return config.write_mode === 'supabase' || config.write_mode === 'dual';
  }

  /**
   * Get the D1 shard for an organization
   */
  async getD1Shard(orgId: string): Promise<D1Database> {
    return this.shardRouter.getShardForOrg(orgId);
  }

  /**
   * Get Supabase client
   */
  getSupabase(): SupabaseClient {
    return this.supabase;
  }

  /**
   * Update routing config for an organization
   */
  async updateRoutingConfig(
    orgId: string,
    updates: Partial<Pick<OrgRoutingConfig, 'read_source' | 'write_mode'>>
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.read_source !== undefined) {
      setClauses.push('read_source = ?');
      values.push(updates.read_source);

      // Track when D1 reads are enabled
      if (updates.read_source === 'd1') {
        setClauses.push('d1_enabled_at = datetime("now")');
      }
    }

    if (updates.write_mode !== undefined) {
      setClauses.push('write_mode = ?');
      values.push(updates.write_mode);
    }

    if (setClauses.length === 0) return;

    values.push(orgId);

    await this.centralDb
      .prepare(`
        UPDATE shard_routing
        SET ${setClauses.join(', ')}
        WHERE organization_id = ?
      `)
      .bind(...values)
      .run();

    // Invalidate cache
    this.configCache.delete(orgId);
    this.cacheExpiry.delete(orgId);
  }

  /**
   * Enable dual-write for an organization (step 2 of migration)
   */
  async enableDualWrite(orgId: string): Promise<void> {
    await this.ensureOrgInRoutingTable(orgId);
    await this.updateRoutingConfig(orgId, { write_mode: 'dual' });
  }

  /**
   * Switch an org to read from D1 (step 4 of migration)
   */
  async enableD1Reads(orgId: string): Promise<void> {
    const config = await this.getRoutingConfig(orgId);

    // Verify org has been migrated
    if (!config.migrated_at) {
      throw new Error(`Organization ${orgId} has not been migrated to D1 yet`);
    }

    await this.updateRoutingConfig(orgId, { read_source: 'd1' });
  }

  /**
   * Fully migrate to D1 (step 5 of migration)
   */
  async enableD1Only(orgId: string): Promise<void> {
    const config = await this.getRoutingConfig(orgId);

    if (config.read_source !== 'd1') {
      throw new Error(`Organization ${orgId} is not reading from D1 yet`);
    }

    await this.updateRoutingConfig(orgId, { write_mode: 'd1' });
  }

  /**
   * Rollback to Supabase (emergency)
   */
  async rollbackToSupabase(orgId: string): Promise<void> {
    await this.updateRoutingConfig(orgId, {
      read_source: 'supabase',
      write_mode: 'supabase',
    });
  }

  /**
   * Ensure org exists in routing table
   */
  private async ensureOrgInRoutingTable(orgId: string): Promise<void> {
    const shardId = this.shardRouter.computeShardId(orgId);

    await this.centralDb
      .prepare(`
        INSERT OR IGNORE INTO shard_routing (organization_id, shard_id)
        VALUES (?, ?)
      `)
      .bind(orgId, shardId)
      .run();
  }

  /**
   * Get rollout statistics
   */
  async getRolloutStats(): Promise<{
    total: number;
    readingFromD1: number;
    dualWrite: number;
    d1Only: number;
    supabaseOnly: number;
  }> {
    const result = await this.centralDb
      .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN read_source = 'd1' THEN 1 ELSE 0 END) as reading_from_d1,
          SUM(CASE WHEN write_mode = 'dual' THEN 1 ELSE 0 END) as dual_write,
          SUM(CASE WHEN write_mode = 'd1' THEN 1 ELSE 0 END) as d1_only,
          SUM(CASE WHEN write_mode = 'supabase' THEN 1 ELSE 0 END) as supabase_only
        FROM shard_routing
      `)
      .first<{
        total: number;
        reading_from_d1: number;
        dual_write: number;
        d1_only: number;
        supabase_only: number;
      }>();

    return {
      total: result?.total || 0,
      readingFromD1: result?.reading_from_d1 || 0,
      dualWrite: result?.dual_write || 0,
      d1Only: result?.d1_only || 0,
      supabaseOnly: result?.supabase_only || 0,
    };
  }

  /**
   * List orgs by their routing status
   */
  async listOrgsByStatus(
    readSource?: ReadSource,
    writeMode?: WriteMode,
    limit = 100
  ): Promise<OrgRoutingConfig[]> {
    let query = 'SELECT * FROM shard_routing WHERE 1=1';
    const params: unknown[] = [];

    if (readSource) {
      query += ' AND read_source = ?';
      params.push(readSource);
    }

    if (writeMode) {
      query += ' AND write_mode = ?';
      params.push(writeMode);
    }

    query += ' LIMIT ?';
    params.push(limit);

    const result = await this.centralDb
      .prepare(query)
      .bind(...params)
      .all<OrgRoutingConfig>();

    return result.results;
  }

  /**
   * Clear cache (for testing or after bulk updates)
   */
  clearCache(): void {
    this.configCache.clear();
    this.cacheExpiry.clear();
  }
}
