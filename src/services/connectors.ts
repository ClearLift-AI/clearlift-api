/**
 * Connector Service
 *
 * Manages platform connections with encrypted credential storage.
 * Handles OAuth state management and credential lifecycle.
 */

import { FieldEncryption } from '../utils/crypto';

export interface ConnectorConfig {
  id: string;
  provider: string;
  name: string;
  logo_url: string | null;
  auth_type: 'oauth2' | 'api_key' | 'basic';
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_scopes: string[];
  requires_api_key: boolean;
  is_active: boolean;
  config_schema: any;
}

export interface PlatformConnection {
  id: string;
  organization_id: string;
  platform: string;
  account_id: string;
  account_name: string | null;
  connected_by: string;
  connected_at: string;
  last_synced_at: string | null;
  sync_status: string;
  is_active: boolean;
  expires_at: string | null;
  scopes: string[];
}

export interface OAuthState {
  state: string;
  user_id: string;
  organization_id: string;
  provider: string;
  redirect_uri: string | null;
  expires_at: string;
  metadata: any;
}

export class ConnectorService {
  private encryption: FieldEncryption | null = null;

  constructor(private db: D1Database, encryptionKey?: string) {
    if (encryptionKey) {
      FieldEncryption.create(encryptionKey).then(enc => {
        this.encryption = enc;
      });
    }
  }

  /**
   * Get all available connector configurations
   */
  async getAvailableConnectors(): Promise<ConnectorConfig[]> {
    const result = await this.db.prepare(`
      SELECT * FROM connector_configs WHERE is_active = TRUE ORDER BY name
    `).all<ConnectorConfig>();

    return (result.results || []).map(config => ({
      ...config,
      oauth_scopes: config.oauth_scopes ? JSON.parse(config.oauth_scopes as any) : [],
      config_schema: config.config_schema ? JSON.parse(config.config_schema as any) : {}
    }));
  }

  /**
   * Get connector configuration by provider
   */
  async getConnectorConfig(provider: string): Promise<ConnectorConfig | null> {
    const result = await this.db.prepare(`
      SELECT * FROM connector_configs WHERE provider = ? AND is_active = TRUE
    `).bind(provider).first<ConnectorConfig>();

    if (!result) {
      return null;
    }

    return {
      ...result,
      oauth_scopes: result.oauth_scopes ? JSON.parse(result.oauth_scopes as any) : [],
      config_schema: result.config_schema ? JSON.parse(result.config_schema as any) : {}
    };
  }

  /**
   * Create OAuth state for CSRF protection
   */
  async createOAuthState(
    userId: string,
    organizationId: string,
    provider: string,
    redirectUri?: string,
    metadata?: any
  ): Promise<string> {
    const state = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.db.prepare(`
      INSERT INTO oauth_states (state, user_id, organization_id, provider, redirect_uri, expires_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      state,
      userId,
      organizationId,
      provider,
      redirectUri || null,
      expiresAt.toISOString(),
      JSON.stringify(metadata || {})
    ).run();

    return state;
  }

  /**
   * Validate and consume OAuth state
   */
  async validateOAuthState(state: string): Promise<OAuthState | null> {
    const result = await this.db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND expires_at > datetime('now')
    `).bind(state).first<OAuthState>();

    if (!result) {
      return null;
    }

    // Delete state after use (one-time use)
    await this.db.prepare(`
      DELETE FROM oauth_states WHERE state = ?
    `).bind(state).run();

    return {
      ...result,
      metadata: result.metadata ? JSON.parse(result.metadata as any) : {}
    };
  }

  /**
   * Create platform connection with encrypted credentials
   */
  async createConnection(params: {
    organizationId: string;
    platform: string;
    accountId: string;
    accountName: string;
    connectedBy: string;
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scopes?: string[];
  }): Promise<string> {
    const connectionId = `${params.organizationId}-${params.platform}-${params.accountId}`;

    if (!this.encryption) {
      throw new Error('Encryption not initialized');
    }

    // Encrypt credentials
    const encryptedAccessToken = await this.encryption.encrypt(params.accessToken);
    const encryptedRefreshToken = params.refreshToken
      ? await this.encryption.encrypt(params.refreshToken)
      : null;

    // Calculate expiration
    const expiresAt = params.expiresIn
      ? new Date(Date.now() + params.expiresIn * 1000).toISOString()
      : null;

    await this.db.prepare(`
      INSERT INTO platform_connections (
        id, organization_id, platform, account_id, account_name,
        connected_by, credentials_encrypted, refresh_token_encrypted,
        expires_at, scopes, is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(organization_id, platform, account_id) DO UPDATE SET
        account_name = excluded.account_name,
        connected_by = excluded.connected_by,
        credentials_encrypted = excluded.credentials_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        expires_at = excluded.expires_at,
        scopes = excluded.scopes,
        connected_at = datetime('now'),
        is_active = 1
    `).bind(
      connectionId,
      params.organizationId,
      params.platform,
      params.accountId,
      params.accountName,
      params.connectedBy,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt,
      JSON.stringify(params.scopes || [])
    ).run();

    return connectionId;
  }

  /**
   * Get platform connection by ID
   */
  async getConnection(connectionId: string): Promise<PlatformConnection | null> {
    const result = await this.db.prepare(`
      SELECT
        id, organization_id, platform, account_id, account_name,
        connected_by, connected_at, last_synced_at, sync_status,
        is_active, expires_at, scopes
      FROM platform_connections
      WHERE id = ?
    `).bind(connectionId).first<PlatformConnection>();

    if (!result) {
      return null;
    }

    return {
      ...result,
      scopes: result.scopes ? JSON.parse(result.scopes as any) : []
    };
  }

  /**
   * Get decrypted access token for connection
   */
  async getAccessToken(connectionId: string): Promise<string | null> {
    if (!this.encryption) {
      throw new Error('Encryption not initialized');
    }

    const result = await this.db.prepare(`
      SELECT credentials_encrypted FROM platform_connections WHERE id = ? AND is_active = 1
    `).bind(connectionId).first<{ credentials_encrypted: string }>();

    if (!result || !result.credentials_encrypted) {
      return null;
    }

    return await this.encryption.decrypt(result.credentials_encrypted);
  }

  /**
   * Get decrypted refresh token for connection
   */
  async getRefreshToken(connectionId: string): Promise<string | null> {
    if (!this.encryption) {
      throw new Error('Encryption not initialized');
    }

    const result = await this.db.prepare(`
      SELECT refresh_token_encrypted FROM platform_connections WHERE id = ? AND is_active = 1
    `).bind(connectionId).first<{ refresh_token_encrypted: string | null }>();

    if (!result || !result.refresh_token_encrypted) {
      return null;
    }

    return await this.encryption.decrypt(result.refresh_token_encrypted);
  }

  /**
   * Update access token (after refresh)
   */
  async updateAccessToken(
    connectionId: string,
    accessToken: string,
    expiresIn?: number
  ): Promise<void> {
    if (!this.encryption) {
      throw new Error('Encryption not initialized');
    }

    const encryptedAccessToken = await this.encryption.encrypt(accessToken);
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    await this.db.prepare(`
      UPDATE platform_connections
      SET credentials_encrypted = ?,
          expires_at = ?
      WHERE id = ?
    `).bind(encryptedAccessToken, expiresAt, connectionId).run();
  }

  /**
   * Get all connections for organization
   */
  async getOrganizationConnections(organizationId: string): Promise<PlatformConnection[]> {
    const result = await this.db.prepare(`
      SELECT
        id, organization_id, platform, account_id, account_name,
        connected_by, connected_at, last_synced_at, sync_status,
        is_active, expires_at, scopes
      FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
      ORDER BY connected_at DESC
    `).bind(organizationId).all<PlatformConnection>();

    return (result.results || []).map(conn => ({
      ...conn,
      scopes: conn.scopes ? JSON.parse(conn.scopes as any) : []
    }));
  }

  /**
   * Disconnect platform
   */
  async disconnectPlatform(connectionId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE platform_connections
      SET is_active = 0,
          credentials_encrypted = NULL,
          refresh_token_encrypted = NULL
      WHERE id = ?
    `).bind(connectionId).run();
  }

  /**
   * Update sync status
   */
  async updateSyncStatus(
    connectionId: string,
    status: string,
    error?: string
  ): Promise<void> {
    await this.db.prepare(`
      UPDATE platform_connections
      SET sync_status = ?,
          sync_error = ?,
          last_synced_at = datetime('now')
      WHERE id = ?
    `).bind(status, error || null, connectionId).run();
  }

  /**
   * Check if token is expired
   */
  async isTokenExpired(connectionId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      SELECT expires_at FROM platform_connections WHERE id = ?
    `).bind(connectionId).first<{ expires_at: string | null }>();

    if (!result || !result.expires_at) {
      return false;
    }

    return new Date(result.expires_at) < new Date();
  }

  /**
   * Clean up expired OAuth states
   */
  async cleanupExpiredStates(): Promise<void> {
    await this.db.prepare(`
      DELETE FROM oauth_states WHERE expires_at < datetime('now')
    `).run();
  }
}
