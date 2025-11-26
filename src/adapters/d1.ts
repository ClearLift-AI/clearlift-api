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

export class D1Adapter {
  constructor(private db: D1Database) {}

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<User | null> {
    const result = await this.db
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

    const result = await this.db
      .prepare(`UPDATE users SET ${fields} WHERE id = ?`)
      .bind(...values)
      .run();

    return result.success && result.meta.changes > 0;
  }

  /**
   * Get user's organizations
   */
  async getUserOrganizations(userId: string): Promise<any[]> {
    const result = await this.db
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
   * Get organization by ID
   */
  async getOrganization(orgId: string): Promise<Organization | null> {
    const result = await this.db
      .prepare("SELECT * FROM organizations WHERE id = ?")
      .bind(orgId)
      .first<Organization>();

    return result;
  }

  /**
   * Check if user has access to organization
   * Supports both organization ID (UUID) and slug
   */
  async checkOrgAccess(userId: string, orgIdOrSlug: string): Promise<boolean> {
    // Check if input looks like a UUID
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgIdOrSlug);

    if (isUUID) {
      const result = await this.db
        .prepare(
          "SELECT 1 FROM organization_members WHERE user_id = ? AND organization_id = ?"
        )
        .bind(userId, orgIdOrSlug)
        .first();
      return result !== null;
    }

    // Treat as slug - join with organizations table
    const result = await this.db
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
      const exists = await this.db
        .prepare("SELECT id FROM organizations WHERE id = ?")
        .bind(orgIdOrSlug)
        .first<{ id: string }>();
      return exists?.id || null;
    }

    // Lookup by slug
    const result = await this.db
      .prepare("SELECT id FROM organizations WHERE slug = ?")
      .bind(orgIdOrSlug)
      .first<{ id: string }>();

    return result?.id || null;
  }

  /**
   * Get organization's tag mapping for DuckDB access
   */
  async getOrgTag(orgId: string): Promise<string | null> {
    const result = await this.db
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
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `).bind(orgId, name, slug),

      this.db.prepare(`
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
    const result = await this.db
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

    const result = await this.db
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
}