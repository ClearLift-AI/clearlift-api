// D1Database type is globally available in Cloudflare Workers environment

export interface User {
  id: string;
  email: string;
  name: string | null;
  issuer: string;
  access_sub: string;
  created_at: string;
  last_login_at: string | null;
  avatar_url: string | null;
  updated_at?: string;
  is_admin: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  settings: string;
  subscription_tier: string;
}

export interface OrganizationMember {
  organization_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  invited_by: string | null;
}

export interface OrgTagMapping {
  id: string;
  organization_id: string;
  short_tag: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface IdentityMapping {
  id: string;
  organization_id: string;
  anonymous_id: string;
  user_id: string;
  canonical_user_id: string | null;
  identified_at: string;
  first_seen_at: string | null;
  source: 'identify' | 'login' | 'merge' | 'manual';
  confidence: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdentityMerge {
  id: string;
  organization_id: string;
  source_user_id: string;
  target_user_id: string;
  merged_at: string;
  merged_by: string | null;
  reason: string | null;
}

export interface OrganizationWithAttribution extends Organization {
  attribution_window_days: number;
  default_attribution_model: string;
  time_decay_half_life_days: number;
  conversion_source: 'platform' | 'tag' | 'hybrid';
}

export class D1Adapter {
  private session: D1DatabaseSession;

  constructor(db: D1Database) {
    // Use Sessions API for read replication support and sequential consistency
    // 'first-unconstrained' allows first query to hit any replica
    this.session = db.withSession('first-unconstrained');
  }

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<User | null> {
    const result = await this.session
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId)
      .first<User>();

    return result;
  }

  /**
   * Update user profile
   */
  async updateUser(userId: string, updates: Partial<User>): Promise<boolean> {
    const fields = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(", ");

    const values = Object.values(updates);
    values.push(userId);

    const result = await this.session
      .prepare(`UPDATE users SET ${fields} WHERE id = ?`)
      .bind(...values)
      .run();

    return result.success && result.meta.changes > 0;
  }

  /**
   * Get user's organizations
   */
  async getUserOrganizations(userId: string): Promise<any[]> {
    const result = await this.session
      .prepare(`
        SELECT
          o.id,
          o.name,
          o.slug,
          o.created_at,
          o.updated_at,
          o.subscription_tier,
          om.role,
          om.joined_at,
          otm.short_tag as org_tag,
          COALESCE(o.default_attribution_model, 'last_touch') as default_attribution_model,
          COALESCE(o.attribution_window_days, 30) as attribution_window_days,
          COALESCE(o.time_decay_half_life_days, 7) as time_decay_half_life_days,
          COALESCE(o.conversion_source, 'tag') as conversion_source,
          (SELECT COUNT(*) FROM organization_members WHERE organization_id = o.id) as members_count,
          (SELECT COUNT(*) FROM platform_connections WHERE organization_id = o.id AND is_active = 1) as platforms_count
        FROM organizations o
        JOIN organization_members om ON o.id = om.organization_id
        LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id
        WHERE om.user_id = ?
        ORDER BY om.joined_at DESC
      `)
      .bind(userId)
      .all();

    return result.results || [];
  }

  /**
   * Get ALL organizations in the system (for admin users)
   * Returns orgs with 'admin' role since admin has access to all
   */
  async getAllOrganizations(): Promise<any[]> {
    const result = await this.session
      .prepare(`
        SELECT
          o.id,
          o.name,
          o.slug,
          o.created_at,
          o.updated_at,
          o.subscription_tier,
          'admin' as role,
          o.created_at as joined_at,
          otm.short_tag as org_tag,
          COALESCE(o.default_attribution_model, 'last_touch') as default_attribution_model,
          COALESCE(o.attribution_window_days, 30) as attribution_window_days,
          COALESCE(o.time_decay_half_life_days, 7) as time_decay_half_life_days,
          COALESCE(o.conversion_source, 'tag') as conversion_source,
          (SELECT COUNT(*) FROM organization_members WHERE organization_id = o.id) as members_count,
          (SELECT COUNT(*) FROM platform_connections WHERE organization_id = o.id AND is_active = 1) as platforms_count
        FROM organizations o
        LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id
        ORDER BY o.created_at DESC
      `)
      .all();

    return result.results || [];
  }

  /**
   * Get organization by ID
   */
  async getOrganization(orgId: string): Promise<Organization | null> {
    const result = await this.session
      .prepare("SELECT * FROM organizations WHERE id = ?")
      .bind(orgId)
      .first<Organization>();

    return result;
  }

  /**
   * Check if user has access to organization
   * Supports both organization ID (UUID) and slug
   * Super admins (is_admin=true) have access to all organizations
   */
  async checkOrgAccess(userId: string, orgIdOrSlug: string): Promise<boolean> {
    // First check if user is a super admin - they have access to all orgs
    // D1 stores booleans as 0/1, so use Boolean() to handle both numeric and boolean values
    const user = await this.getUser(userId);
    if (Boolean(user?.is_admin)) {
      return true;
    }

    // Check if input looks like a UUID
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgIdOrSlug);

    if (isUUID) {
      const result = await this.session
        .prepare(
          "SELECT 1 FROM organization_members WHERE user_id = ? AND organization_id = ?"
        )
        .bind(userId, orgIdOrSlug)
        .first();
      return result !== null;
    }

    // Treat as slug - join with organizations table
    const result = await this.session
      .prepare(`
        SELECT 1 FROM organization_members om
        JOIN organizations o ON om.organization_id = o.id
        WHERE om.user_id = ? AND o.slug = ?
      `)
      .bind(userId, orgIdOrSlug)
      .first();

    return result !== null;
  }

  /**
   * Resolve org slug to ID, or return ID if already a UUID
   */
  async resolveOrgId(orgIdOrSlug: string): Promise<string | null> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgIdOrSlug);

    if (isUUID) {
      // Verify it exists
      const exists = await this.session
        .prepare("SELECT id FROM organizations WHERE id = ?")
        .bind(orgIdOrSlug)
        .first<{ id: string }>();
      return exists?.id || null;
    }

    // Lookup by slug
    const result = await this.session
      .prepare("SELECT id FROM organizations WHERE slug = ?")
      .bind(orgIdOrSlug)
      .first<{ id: string }>();

    return result?.id || null;
  }

  /**
   * Get organization's tag mapping for DuckDB access
   */
  async getOrgTag(orgId: string): Promise<string | null> {
    const result = await this.session
      .prepare(
        "SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1"
      )
      .bind(orgId)
      .first<{ short_tag: string }>();

    return result?.short_tag || null;
  }

  /**
   * Create new organization
   */
  async createOrganization(
    name: string,
    slug: string,
    ownerId: string
  ): Promise<string> {
    const orgId = crypto.randomUUID();

    // Start a batch to ensure atomicity
    await this.session.batch([
      this.session.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `).bind(orgId, name, slug),

      this.session.prepare(`
        INSERT INTO organization_members (organization_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', datetime('now'))
      `).bind(orgId, ownerId)
    ]);

    return orgId;
  }


  /**
   * Get platform connections for organization
   */
  async getPlatformConnections(orgId: string): Promise<any[]> {
    const result = await this.session
      .prepare(`
        SELECT
          id,
          platform,
          account_id,
          account_name,
          connected_by,
          connected_at,
          last_synced_at,
          sync_status,
          is_active
        FROM platform_connections
        WHERE organization_id = ?
        ORDER BY connected_at DESC
      `)
      .bind(orgId)
      .all();

    return result.results || [];
  }

  /**
   * Get list of active platform connections for organization
   * Returns platform names (e.g., ['facebook', 'google'])
   */
  async getActiveConnections(orgId: string): Promise<string[]> {
    const result = await this.session
      .prepare(`
        SELECT DISTINCT platform FROM platform_connections
        WHERE organization_id = ? AND is_active = 1
      `)
      .bind(orgId)
      .all<{ platform: string }>();

    return result.results?.map(r => r.platform) || [];
  }

  /**
   * Check if organization has an active connection for a specific platform
   */
  async hasActiveConnection(orgId: string, platform: string): Promise<boolean> {
    const result = await this.session
      .prepare(`
        SELECT 1 FROM platform_connections
        WHERE organization_id = ? AND platform = ? AND is_active = 1
        LIMIT 1
      `)
      .bind(orgId, platform)
      .first();

    return result !== null;
  }

  /**
   * Create or update platform connection
   */
  async upsertPlatformConnection(
    orgId: string,
    platform: string,
    accountId: string,
    accountName: string,
    connectedBy: string
  ): Promise<boolean> {
    const id = `${orgId}-${platform}-${accountId}`;

    const result = await this.session
      .prepare(`
        INSERT INTO platform_connections (
          id, organization_id, platform, account_id, account_name,
          connected_by, connected_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)
        ON CONFLICT(organization_id, platform, account_id) DO UPDATE SET
          account_name = excluded.account_name,
          connected_by = excluded.connected_by,
          connected_at = excluded.connected_at,
          is_active = 1
      `)
      .bind(id, orgId, platform, accountId, accountName, connectedBy)
      .run();

    return result.success;
  }

  // ===== Identity Resolution Methods =====

  /**
   * Create or update an identity mapping (anonymous_id → user_id link)
   */
  async upsertIdentityMapping(
    orgId: string,
    anonymousId: string,
    userId: string,
    identifiedAt: string,
    options: {
      firstSeenAt?: string;
      source?: 'identify' | 'login' | 'merge' | 'manual';
      confidence?: number;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<{ id: string; isNew: boolean }> {
    const id = crypto.randomUUID();
    const source = options.source || 'identify';
    const confidence = options.confidence ?? 1.0;
    const metadata = options.metadata ? JSON.stringify(options.metadata) : null;

    // Check if mapping already exists
    const existing = await this.session
      .prepare(`
        SELECT id FROM identity_mappings
        WHERE organization_id = ? AND anonymous_id = ? AND user_id = ?
      `)
      .bind(orgId, anonymousId, userId)
      .first<{ id: string }>();

    if (existing) {
      // Update existing mapping
      await this.session
        .prepare(`
          UPDATE identity_mappings
          SET identified_at = ?, source = ?, confidence = ?, metadata = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
        .bind(identifiedAt, source, confidence, metadata, existing.id)
        .run();
      return { id: existing.id, isNew: false };
    }

    // Insert new mapping
    await this.session
      .prepare(`
        INSERT INTO identity_mappings (
          id, organization_id, anonymous_id, user_id, identified_at,
          first_seen_at, source, confidence, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `)
      .bind(id, orgId, anonymousId, userId, identifiedAt, options.firstSeenAt || null, source, confidence, metadata)
      .run();

    return { id, isNew: true };
  }

  /**
   * Get all anonymous_ids linked to a user_id (including canonical lookups)
   */
  async getAnonymousIdsByUserId(orgId: string, userId: string): Promise<string[]> {
    // First check if this user_id has been merged into a canonical
    const canonical = await this.session
      .prepare(`
        SELECT target_user_id FROM identity_merges
        WHERE organization_id = ? AND source_user_id = ?
        ORDER BY merged_at DESC LIMIT 1
      `)
      .bind(orgId, userId)
      .first<{ target_user_id: string }>();

    const effectiveUserId = canonical?.target_user_id || userId;

    // Get all anonymous_ids for this user_id (and any merged user_ids)
    const result = await this.session
      .prepare(`
        SELECT DISTINCT anonymous_id FROM identity_mappings
        WHERE organization_id = ? AND (
          user_id = ?
          OR canonical_user_id = ?
          OR user_id IN (
            SELECT source_user_id FROM identity_merges
            WHERE organization_id = ? AND target_user_id = ?
          )
        )
      `)
      .bind(orgId, effectiveUserId, effectiveUserId, orgId, effectiveUserId)
      .all<{ anonymous_id: string }>();

    return result.results?.map(r => r.anonymous_id) || [];
  }

  /**
   * Get the user_id (or canonical user_id) for an anonymous_id
   */
  async getUserIdByAnonymousId(orgId: string, anonymousId: string): Promise<string | null> {
    const result = await this.session
      .prepare(`
        SELECT user_id, canonical_user_id FROM identity_mappings
        WHERE organization_id = ? AND anonymous_id = ?
        ORDER BY identified_at DESC LIMIT 1
      `)
      .bind(orgId, anonymousId)
      .first<{ user_id: string; canonical_user_id: string | null }>();

    if (!result) return null;
    return result.canonical_user_id || result.user_id;
  }

  /**
   * Get all identity mappings for a user (full identity graph)
   */
  async getIdentityGraph(orgId: string, userId: string): Promise<IdentityMapping[]> {
    const anonymousIds = await this.getAnonymousIdsByUserId(orgId, userId);

    if (anonymousIds.length === 0) return [];

    const placeholders = anonymousIds.map(() => '?').join(',');
    const result = await this.session
      .prepare(`
        SELECT * FROM identity_mappings
        WHERE organization_id = ? AND anonymous_id IN (${placeholders})
        ORDER BY identified_at ASC
      `)
      .bind(orgId, ...anonymousIds)
      .all<IdentityMapping>();

    return result.results || [];
  }

  /**
   * Merge two user identities (make one canonical)
   */
  async mergeIdentities(
    orgId: string,
    sourceUserId: string,
    targetUserId: string,
    mergedBy?: string,
    reason?: string
  ): Promise<boolean> {
    const id = crypto.randomUUID();

    // Create merge record
    await this.session
      .prepare(`
        INSERT INTO identity_merges (id, organization_id, source_user_id, target_user_id, merged_by, reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(id, orgId, sourceUserId, targetUserId, mergedBy || 'system', reason || 'manual')
      .run();

    // Update all identity mappings for source_user_id to point to target
    await this.session
      .prepare(`
        UPDATE identity_mappings
        SET canonical_user_id = ?, updated_at = datetime('now')
        WHERE organization_id = ? AND user_id = ? AND canonical_user_id IS NULL
      `)
      .bind(targetUserId, orgId, sourceUserId)
      .run();

    return true;
  }

  /**
   * Get organization with attribution settings
   */
  async getOrganizationWithAttribution(orgId: string): Promise<OrganizationWithAttribution | null> {
    const result = await this.session
      .prepare(`
        SELECT
          id, name, slug, created_at, updated_at, settings, subscription_tier,
          COALESCE(attribution_window_days, 30) as attribution_window_days,
          COALESCE(default_attribution_model, 'last_touch') as default_attribution_model,
          COALESCE(time_decay_half_life_days, 7) as time_decay_half_life_days,
          COALESCE(conversion_source, 'tag') as conversion_source
        FROM organizations WHERE id = ?
      `)
      .bind(orgId)
      .first<OrganizationWithAttribution>();

    return result;
  }

  /**
   * Get count of linked anonymous_ids for a user
   */
  async getLinkedIdentityCount(orgId: string, userId: string): Promise<number> {
    const result = await this.session
      .prepare(`
        SELECT COUNT(DISTINCT anonymous_id) as count FROM identity_mappings
        WHERE organization_id = ? AND (user_id = ? OR canonical_user_id = ?)
      `)
      .bind(orgId, userId, userId)
      .first<{ count: number }>();

    return result?.count || 0;
  }
}