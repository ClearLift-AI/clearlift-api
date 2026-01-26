/**
 * Connector Registry Service
 *
 * Provides access to the database-driven connector registry.
 * Enables dynamic connector configuration without code changes.
 *
 * @see clearlift-cron/docs/SHARED_CODE.md for connector architecture
 */

/**
 * Connector Types - 15 categories for unified architecture
 *
 * @see clearlift-cron/docs/SHARED_CODE.md §20 Connector Roadmap
 */
export type ConnectorType =
  | 'ad_platform'     // Google Ads, Meta Ads, TikTok Ads, LinkedIn Ads
  | 'crm'             // HubSpot, Salesforce, Pipedrive
  | 'communication'   // Klaviyo, Mailchimp, SendGrid, Attentive
  | 'ecommerce'       // Shopify, WooCommerce
  | 'payments'        // Stripe, Paddle, Chargebee, Recurly, Lemon Squeezy
  | 'support'         // Zendesk, Intercom, Freshdesk
  | 'scheduling'      // Calendly, Acuity
  | 'forms'           // Typeform, JotForm
  | 'events'          // clearlift_tag, tracking_link (internal)
  | 'analytics'       // Mixpanel, Amplitude (read-only)
  | 'accounting'      // QuickBooks, Xero
  | 'attribution'     // AppsFlyer, Adjust, Branch
  | 'reviews'         // G2, Trustpilot, Capterra
  | 'affiliate'       // Impact, PartnerStack
  | 'social'          // LinkedIn Pages, Instagram Business
  | 'field_service';  // Jobber, ServiceTitan

/**
 * Connector Categories - UI grouping for dropdowns and settings
 */
export type ConnectorCategory =
  | 'advertising'     // ad_platform
  | 'sales'           // crm
  | 'marketing'       // communication, attribution
  | 'commerce'        // ecommerce, payments
  | 'operations'      // scheduling, support, field_service
  | 'analytics'       // events, analytics
  | 'finance'         // accounting, payments
  | 'communication'   // communication (email, sms)
  | 'field_service';  // field_service (legacy)
export type AuthType = 'oauth2' | 'oauth' | 'api_key' | 'basic' | 'internal';

/**
 * Event definition for Flow Builder
 */
export interface ConnectorEvent {
  id: string;
  name: string;
  fields: string[];
}

/**
 * Full connector definition from database
 */
export interface ConnectorDefinition {
  // Identity
  id: string;
  provider: string;
  name: string;
  platform_id: string | null;

  // Classification
  connector_type: ConnectorType;
  category: ConnectorCategory;
  auth_type: AuthType;

  // Display
  description: string | null;
  documentation_url: string | null;
  logo_url: string | null;
  icon_name: string | null;
  icon_color: string;
  sort_order: number;

  // Feature flags
  is_active: boolean;
  is_beta: boolean;
  supports_sync: boolean;
  supports_realtime: boolean;
  supports_webhooks: boolean;

  // OAuth configuration
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_scopes: string[];
  requires_api_key: boolean;
  config_schema: Record<string, any>;

  // Events for Flow Builder
  events: ConnectorEvent[];

  // Sync configuration
  default_concurrency: number;
  rate_limit_per_hour: number | null;
  default_lookback_days: number;
  default_sync_interval_hours: number;

  // UI theming
  theme_bg_color: string | null;
  theme_border_color: string | null;
  theme_text_color: string | null;

  // Value tracking
  has_actual_value: boolean;
  value_field: string | null;

  // Permissions
  permissions_description: string | null;
}

/**
 * Summarized connector info for lists
 */
export interface ConnectorSummary {
  id: string;
  provider: string;
  name: string;
  connector_type: ConnectorType;
  category: ConnectorCategory;
  icon_name: string | null;
  icon_color: string;
  is_active: boolean;
  is_beta: boolean;
  sort_order: number;
}

/**
 * Input for creating a new connector
 */
export interface CreateConnectorInput {
  provider: string;
  name: string;
  connector_type: ConnectorType;
  category: ConnectorCategory;
  auth_type: AuthType;
  description?: string;
  icon_name?: string;
  icon_color?: string;
  events_schema?: ConnectorEvent[];
  // ... other optional fields
}

/**
 * Database row type (before parsing JSON fields)
 */
interface ConnectorConfigRow {
  id: string;
  provider: string;
  name: string;
  logo_url: string | null;
  auth_type: string;
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_scopes: string | null;
  requires_api_key: number;
  is_active: number;
  config_schema: string | null;
  connector_type: string | null;
  category: string | null;
  description: string | null;
  documentation_url: string | null;
  icon_name: string | null;
  icon_color: string | null;
  sort_order: number | null;
  supports_sync: number | null;
  supports_realtime: number | null;
  supports_webhooks: number | null;
  is_beta: number | null;
  events_schema: string | null;
  default_concurrency: number | null;
  rate_limit_per_hour: number | null;
  default_lookback_days: number | null;
  default_sync_interval_hours: number | null;
  theme_bg_color: string | null;
  theme_border_color: string | null;
  theme_text_color: string | null;
  has_actual_value: number | null;
  value_field: string | null;
  permissions_description: string | null;
  platform_id: string | null;
}

export class ConnectorRegistryService {
  constructor(private db: D1Database) {}

  /**
   * Transform database row to ConnectorDefinition
   */
  private transformRow(row: ConnectorConfigRow): ConnectorDefinition {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      platform_id: row.platform_id || row.provider,
      connector_type: (row.connector_type || 'revenue') as ConnectorType,
      category: (row.category || 'payments') as ConnectorCategory,
      auth_type: row.auth_type as AuthType,
      description: row.description,
      documentation_url: row.documentation_url,
      logo_url: row.logo_url,
      icon_name: row.icon_name,
      icon_color: row.icon_color || '#6B7280',
      sort_order: row.sort_order ?? 100,
      is_active: Boolean(row.is_active),
      is_beta: Boolean(row.is_beta),
      supports_sync: row.supports_sync !== 0,
      supports_realtime: Boolean(row.supports_realtime),
      supports_webhooks: Boolean(row.supports_webhooks),
      oauth_authorize_url: row.oauth_authorize_url,
      oauth_token_url: row.oauth_token_url,
      oauth_scopes: row.oauth_scopes ? this.parseJson(row.oauth_scopes, []) : [],
      requires_api_key: Boolean(row.requires_api_key),
      config_schema: row.config_schema ? this.parseJson(row.config_schema, {}) : {},
      events: row.events_schema ? this.parseJson(row.events_schema, []) : [],
      default_concurrency: row.default_concurrency ?? 2,
      rate_limit_per_hour: row.rate_limit_per_hour,
      default_lookback_days: row.default_lookback_days ?? 90,
      default_sync_interval_hours: row.default_sync_interval_hours ?? 24,
      theme_bg_color: row.theme_bg_color,
      theme_border_color: row.theme_border_color,
      theme_text_color: row.theme_text_color,
      has_actual_value: Boolean(row.has_actual_value),
      value_field: row.value_field,
      permissions_description: row.permissions_description,
    };
  }

  /**
   * Safely parse JSON with fallback
   */
  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * List all connectors (optionally filtered by type or active status)
   */
  async listConnectors(options?: {
    type?: ConnectorType;
    category?: ConnectorCategory;
    activeOnly?: boolean;
    includeInternal?: boolean;
  }): Promise<ConnectorDefinition[]> {
    let query = 'SELECT * FROM connector_configs WHERE 1=1';
    const params: any[] = [];

    if (options?.activeOnly !== false) {
      query += ' AND is_active = TRUE';
    }

    if (options?.type) {
      query += ' AND connector_type = ?';
      params.push(options.type);
    }

    if (options?.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    if (!options?.includeInternal) {
      query += " AND auth_type != 'internal'";
    }

    query += ' ORDER BY sort_order, name';

    const stmt = this.db.prepare(query);
    const result = params.length > 0
      ? await stmt.bind(...params).all<ConnectorConfigRow>()
      : await stmt.all<ConnectorConfigRow>();

    return (result.results || []).map(row => this.transformRow(row));
  }

  /**
   * Get a single connector by provider
   */
  async getConnector(provider: string): Promise<ConnectorDefinition | null> {
    const result = await this.db.prepare(`
      SELECT * FROM connector_configs WHERE provider = ?
    `).bind(provider).first<ConnectorConfigRow>();

    return result ? this.transformRow(result) : null;
  }

  /**
   * Get connectors by type (ad_platform, revenue, etc.)
   */
  async getConnectorsByType(type: ConnectorType): Promise<ConnectorDefinition[]> {
    return this.listConnectors({ type, activeOnly: true });
  }

  /**
   * Get all ad platforms
   */
  async getAdPlatforms(): Promise<ConnectorDefinition[]> {
    return this.getConnectorsByType('ad_platform');
  }

  /**
   * Get all revenue/payments platforms (Stripe, Shopify, etc.)
   */
  async getRevenuePlatforms(): Promise<ConnectorDefinition[]> {
    // Query both payments and ecommerce types
    const [payments, ecommerce] = await Promise.all([
      this.getConnectorsByType('payments'),
      this.getConnectorsByType('ecommerce')
    ]);
    return [...payments, ...ecommerce];
  }

  /**
   * Get events schema for a connector (for Flow Builder)
   */
  async getConnectorEvents(provider: string): Promise<ConnectorEvent[]> {
    const connector = await this.getConnector(provider);
    return connector?.events || [];
  }

  /**
   * Get platform IDs for a connector type (for SQL IN clauses)
   */
  async getPlatformIds(type: ConnectorType): Promise<string[]> {
    const connectors = await this.getConnectorsByType(type);
    return connectors.map(c => c.platform_id || c.provider);
  }

  /**
   * Get SQL IN clause string for a connector type
   * e.g., "'stripe', 'shopify', 'jobber'"
   */
  async getPlatformInClause(type: ConnectorType): Promise<string> {
    const ids = await this.getPlatformIds(type);
    return ids.map(id => `'${id}'`).join(', ');
  }

  /**
   * Check if a provider is registered
   */
  async isRegistered(provider: string): Promise<boolean> {
    const result = await this.db.prepare(`
      SELECT 1 FROM connector_configs WHERE provider = ?
    `).bind(provider).first();
    return !!result;
  }

  /**
   * Get summarized connector list (for dropdowns, etc.)
   */
  async listConnectorSummaries(options?: {
    type?: ConnectorType;
    activeOnly?: boolean;
  }): Promise<ConnectorSummary[]> {
    let query = `
      SELECT id, provider, name, connector_type, category,
             icon_name, icon_color, is_active, is_beta, sort_order
      FROM connector_configs
      WHERE 1=1
    `;
    const params: any[] = [];

    if (options?.activeOnly !== false) {
      query += ' AND is_active = TRUE';
    }

    if (options?.type) {
      query += ' AND connector_type = ?';
      params.push(options.type);
    }

    query += ' ORDER BY sort_order, name';

    const stmt = this.db.prepare(query);
    const result = params.length > 0
      ? await stmt.bind(...params).all<any>()
      : await stmt.all<any>();

    return (result.results || []).map(row => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      connector_type: row.connector_type || 'revenue',
      category: row.category || 'payments',
      icon_name: row.icon_name,
      icon_color: row.icon_color || '#6B7280',
      is_active: Boolean(row.is_active),
      is_beta: Boolean(row.is_beta),
      sort_order: row.sort_order ?? 100,
    }));
  }

  /**
   * Create a new connector (admin only)
   */
  async createConnector(input: CreateConnectorInput): Promise<ConnectorDefinition> {
    const id = `${input.provider}-001`;

    await this.db.prepare(`
      INSERT INTO connector_configs (
        id, provider, name, auth_type, connector_type, category,
        description, icon_name, icon_color, events_schema,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, datetime('now'), datetime('now'))
    `).bind(
      id,
      input.provider,
      input.name,
      input.auth_type,
      input.connector_type,
      input.category,
      input.description || null,
      input.icon_name || null,
      input.icon_color || '#6B7280',
      input.events_schema ? JSON.stringify(input.events_schema) : null
    ).run();

    const connector = await this.getConnector(input.provider);
    if (!connector) {
      throw new Error('Failed to create connector');
    }
    return connector;
  }

  /**
   * Update connector configuration (admin only)
   */
  async updateConnector(
    provider: string,
    updates: Partial<Omit<ConnectorDefinition, 'id' | 'provider'>>
  ): Promise<ConnectorDefinition> {
    const setClauses: string[] = [];
    const params: any[] = [];

    // Build dynamic UPDATE query
    const fieldMap: Record<string, string> = {
      name: 'name',
      connector_type: 'connector_type',
      category: 'category',
      description: 'description',
      documentation_url: 'documentation_url',
      icon_name: 'icon_name',
      icon_color: 'icon_color',
      sort_order: 'sort_order',
      is_active: 'is_active',
      is_beta: 'is_beta',
      supports_sync: 'supports_sync',
      supports_realtime: 'supports_realtime',
      supports_webhooks: 'supports_webhooks',
      default_concurrency: 'default_concurrency',
      rate_limit_per_hour: 'rate_limit_per_hour',
      default_lookback_days: 'default_lookback_days',
      default_sync_interval_hours: 'default_sync_interval_hours',
      theme_bg_color: 'theme_bg_color',
      theme_border_color: 'theme_border_color',
      theme_text_color: 'theme_text_color',
      has_actual_value: 'has_actual_value',
      value_field: 'value_field',
      permissions_description: 'permissions_description',
      platform_id: 'platform_id',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in updates) {
        setClauses.push(`${column} = ?`);
        params.push((updates as any)[key]);
      }
    }

    // Handle JSON fields separately
    if ('events' in updates) {
      setClauses.push('events_schema = ?');
      params.push(JSON.stringify(updates.events));
    }

    if (setClauses.length === 0) {
      throw new Error('No updates provided');
    }

    setClauses.push("updated_at = datetime('now')");
    params.push(provider);

    await this.db.prepare(`
      UPDATE connector_configs
      SET ${setClauses.join(', ')}
      WHERE provider = ?
    `).bind(...params).run();

    const connector = await this.getConnector(provider);
    if (!connector) {
      throw new Error('Connector not found');
    }
    return connector;
  }
}
