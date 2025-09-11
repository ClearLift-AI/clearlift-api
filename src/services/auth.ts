import { D1Database } from '@cloudflare/workers-types';

export interface User {
  id: string;
  email: string;
  name: string | null;
  issuer: string;
  access_sub: string;
  created_at: string;
  last_login_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  settings: Record<string, any>;
  subscription_tier: string;
  role?: string;
}

export interface Session {
  token: string;
  user_id: string;
  current_organization_id: string | null;
  created_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  user?: User;
  organization?: Organization | null;
}

export class AuthService {
  constructor(private db: D1Database) {}

  /**
   * Validate a session token and return session details with user and organization
   */
  async validateSession(token: string): Promise<Session | null> {
    if (!token) return null;

    try {
      const result = await this.db.prepare(`
        SELECT 
          s.token, s.user_id, s.current_organization_id, s.expires_at,
          s.created_at, s.ip_address, s.user_agent,
          u.email, u.name, u.issuer, u.access_sub, u.created_at as user_created_at,
          u.last_login_at,
          o.id as org_id, o.name as org_name, o.slug as org_slug,
          o.created_at as org_created_at, o.updated_at as org_updated_at,
          o.settings as org_settings, o.subscription_tier,
          om.role
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN organizations o ON s.current_organization_id = o.id
        LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = o.id
        WHERE s.token = ? AND s.expires_at > datetime('now')
      `).bind(token).first();

      if (!result) return null;

      return {
        token: result.token as string,
        user_id: result.user_id as string,
        current_organization_id: result.current_organization_id as string | null,
        created_at: result.created_at as string,
        expires_at: result.expires_at as string,
        ip_address: result.ip_address as string | null,
        user_agent: result.user_agent as string | null,
        user: {
          id: result.user_id as string,
          email: result.email as string,
          name: result.name as string | null,
          issuer: result.issuer as string,
          access_sub: result.access_sub as string,
          created_at: result.user_created_at as string,
          last_login_at: result.last_login_at as string | null
        },
        organization: result.org_id ? {
          id: result.org_id as string,
          name: result.org_name as string,
          slug: result.org_slug as string,
          created_at: result.org_created_at as string,
          updated_at: result.org_updated_at as string,
          settings: JSON.parse(result.org_settings as string || '{}'),
          subscription_tier: result.subscription_tier as string,
          role: result.role as string
        } : null
      };
    } catch (error) {
      console.error('Session validation error:', error);
      return null;
    }
  }

  /**
   * Create a new session for a user
   */
  async createSession(
    userId: string, 
    organizationId: string | null = null,
    ipAddress: string | null = null,
    userAgent: string | null = null
  ): Promise<string> {
    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    await this.db.prepare(`
      INSERT INTO sessions (token, user_id, current_organization_id, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      token,
      userId,
      organizationId,
      expiresAt.toISOString(),
      ipAddress,
      userAgent
    ).run();

    return token;
  }

  /**
   * Delete a session (logout)
   */
  async deleteSession(token: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM sessions WHERE token = ?
    `).bind(token).run();
  }

  /**
   * Update session's current organization
   */
  async updateSessionOrganization(token: string, organizationId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE sessions 
      SET current_organization_id = ?
      WHERE token = ? AND expires_at > datetime('now')
    `).bind(organizationId, token).run();

    return result.meta.changes > 0;
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.db.prepare(`
      SELECT * FROM users WHERE email = ?
    `).bind(email).first();

    if (!result) return null;

    return result as User;
  }

  /**
   * Create or update user (for OAuth login)
   */
  async upsertUser(userData: {
    email: string;
    issuer: string;
    access_sub: string;
    name?: string;
    avatar_url?: string;
    identity_nonce?: string;
  }): Promise<User> {
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO users (id, email, issuer, access_sub, name, avatar_url, identity_nonce, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issuer, access_sub) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        last_login_at = excluded.last_login_at,
        updated_at = datetime('now')
    `).bind(
      userId,
      userData.email,
      userData.issuer,
      userData.access_sub,
      userData.name || null,
      userData.avatar_url || null,
      userData.identity_nonce || null,
      now,
      now
    ).run();

    // Get the user (either newly created or updated)
    const user = await this.db.prepare(`
      SELECT * FROM users WHERE issuer = ? AND access_sub = ?
    `).bind(userData.issuer, userData.access_sub).first();

    return user as User;
  }

  /**
   * Check if user has access to organization
   */
  async hasOrgAccess(userId: string, organizationId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      SELECT 1 FROM organization_members 
      WHERE user_id = ? AND organization_id = ?
    `).bind(userId, organizationId).first();

    return !!result;
  }

  /**
   * Get user's organizations
   */
  async getUserOrganizations(userId: string): Promise<Organization[]> {
    const results = await this.db.prepare(`
      SELECT o.*, om.role 
      FROM organizations o
      JOIN organization_members om ON o.id = om.organization_id
      WHERE om.user_id = ?
      ORDER BY o.created_at DESC
    `).bind(userId).all();

    return results.results.map(row => ({
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      settings: JSON.parse(row.settings as string || '{}'),
      subscription_tier: row.subscription_tier as string,
      role: row.role as string
    }));
  }
}