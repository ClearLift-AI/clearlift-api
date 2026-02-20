/**
 * Entity Tree Builder
 *
 * Builds hierarchical tree of ad entities from D1 ANALYTICS_DB.
 * Normalizes platform differences (Meta adset = Google ad_group).
 * Uses Sessions API for read replication support.
 *
 * UPDATED: Now queries unified tables (ad_campaigns, ad_groups, ads)
 * and uses connector registry for dynamic platform discovery.
 * This allows AI to discover any connector without code changes.
 */

// D1 types (D1Database, D1DatabaseSession, etc.) come from worker-configuration.d.ts

// Dynamic platform type - no longer limited to hardcoded values
export type Platform = string;
export type EntityLevel = 'ad' | 'adset' | 'campaign' | 'account';

export interface Entity {
  id: string;
  externalId: string;  // Platform's ID (ad_id, campaign_id, etc.)
  name: string;
  platform: Platform;
  level: EntityLevel;
  status: 'active' | 'paused' | 'archived' | 'deleted' | string;  // Normalized status
  parentId?: string;  // Reference to parent entity's id
  children: Entity[];
  accountId?: string;  // For linking to account
  metadata?: Record<string, any>;  // Additional platform-specific data
}

export interface AccountEntity extends Entity {
  level: 'account';
  customerId?: string;  // Google customer ID
  adAccountId?: string;  // Meta ad account ID
}

export interface EntityTree {
  organizationId: string;
  accounts: Map<string, AccountEntity>;  // key: platform_accountId
  totalEntities: number;
  platforms: string[];  // Active platforms discovered
}

export class EntityTreeBuilder {
  private session: D1DatabaseSession;
  private mainDb?: D1Database;  // For connector registry queries

  constructor(db: D1Database, mainDb?: D1Database) {
    // Use Sessions API for read replication support
    this.session = db.withSession('first-unconstrained');
    this.mainDb = mainDb;
  }

  /**
   * Get active ad platforms from connector registry or database
   */
  private async getActivePlatforms(orgId: string): Promise<string[]> {
    // Query unified tables to discover which platforms have data for this org
    const result = await this.session.prepare(`
      SELECT DISTINCT platform FROM ad_campaigns
      WHERE organization_id = ?
    `).bind(orgId).all<{ platform: string }>();

    return (result.results || []).map(r => r.platform);
  }

  /**
   * Build complete entity tree for an organization
   * Now uses unified tables and dynamic platform discovery
   */
  async buildTree(orgId: string): Promise<EntityTree> {
    // Discover active platforms dynamically
    const platforms = await this.getActivePlatforms(orgId);

    const tree: EntityTree = {
      organizationId: orgId,
      accounts: new Map(),
      totalEntities: 0,
      platforms
    };

    // Build from unified tables (ad_campaigns, ad_groups, ads)
    const unifiedTree = await this.buildUnifiedTree(orgId);
    for (const [key, account] of unifiedTree) {
      tree.accounts.set(key, account);
    }

    // Count total entities
    tree.totalEntities = this.countEntities(tree);

    return tree;
  }

  /**
   * Build entity tree from unified tables (ad_campaigns, ad_groups, ads)
   * This is the primary method - works for any platform
   */
  private async buildUnifiedTree(orgId: string): Promise<Map<string, AccountEntity>> {
    const accounts = new Map<string, AccountEntity>();

    // Fetch all campaigns from unified table
    const campaignsResult = await this.session.prepare(`
      SELECT id, platform, account_id, campaign_id, campaign_name, campaign_status
      FROM ad_campaigns
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      platform: string;
      account_id: string;
      campaign_id: string;
      campaign_name: string;
      campaign_status: string;
    }>();
    const campaigns = campaignsResult.results || [];

    if (campaigns.length === 0) return accounts;

    // Fetch all ad groups from unified table
    const adGroupsResult = await this.session.prepare(`
      SELECT id, platform, account_id, campaign_id, campaign_ref, ad_group_id, ad_group_name, ad_group_status
      FROM ad_groups
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      platform: string;
      account_id: string;
      campaign_id: string;
      campaign_ref: string;
      ad_group_id: string;
      ad_group_name: string;
      ad_group_status: string;
    }>();
    const adGroups = adGroupsResult.results || [];

    // Fetch all ads from unified table
    const adsResult = await this.session.prepare(`
      SELECT id, platform, account_id, campaign_id, ad_group_id, ad_group_ref, ad_id, ad_name, ad_status
      FROM ads
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      platform: string;
      account_id: string;
      campaign_id: string;
      ad_group_id: string;
      ad_group_ref: string;
      ad_id: string;
      ad_name: string;
      ad_status: string;
    }>();
    const ads = adsResult.results || [];

    // Index by platform and account
    const campaignsByPlatformAccount = new Map<string, typeof campaigns>();
    for (const c of campaigns) {
      const key = `${c.platform}_${c.account_id}`;
      const list = campaignsByPlatformAccount.get(key) || [];
      list.push(c);
      campaignsByPlatformAccount.set(key, list);
    }

    const adGroupsByCampaignRef = new Map<string, typeof adGroups>();
    for (const ag of adGroups) {
      const list = adGroupsByCampaignRef.get(ag.campaign_ref) || [];
      list.push(ag);
      adGroupsByCampaignRef.set(ag.campaign_ref, list);
    }

    const adsByAdGroupRef = new Map<string, typeof ads>();
    for (const a of ads) {
      const list = adsByAdGroupRef.get(a.ad_group_ref) || [];
      list.push(a);
      adsByAdGroupRef.set(a.ad_group_ref, list);
    }

    // Build tree for each platform_account combination
    for (const [platformAccountKey, accountCampaigns] of campaignsByPlatformAccount) {
      const [platform, accountId] = this.parsePlatformAccountKey(platformAccountKey);
      const accountKey = platformAccountKey;

      // Create account entity
      const account: AccountEntity = {
        id: accountKey,
        externalId: accountId,
        name: this.getPlatformDisplayName(platform) + ' ' + accountId,
        platform,
        level: 'account',
        status: 'active',
        customerId: platform === 'google' ? accountId : undefined,
        adAccountId: platform !== 'google' ? accountId : undefined,
        children: []
      };

      // Build campaign entities
      for (const campaign of accountCampaigns) {
        const campaignEntity: Entity = {
          id: campaign.id,
          externalId: campaign.campaign_id,
          name: campaign.campaign_name,
          platform,
          level: 'campaign',
          status: campaign.campaign_status,
          parentId: accountKey,
          accountId,
          children: []
        };

        // Build ad group entities (using campaign_ref for lookup)
        const campaignAdGroups = adGroupsByCampaignRef.get(campaign.id) || [];
        for (const adGroup of campaignAdGroups) {
          const adGroupEntity: Entity = {
            id: adGroup.id,
            externalId: adGroup.ad_group_id,
            name: adGroup.ad_group_name,
            platform,
            level: 'adset',  // Normalized
            status: adGroup.ad_group_status,
            parentId: campaign.id,
            accountId,
            children: []
          };

          // Build ad entities (using ad_group_ref for lookup)
          const groupAds = adsByAdGroupRef.get(adGroup.id) || [];
          for (const ad of groupAds) {
            const adEntity: Entity = {
              id: ad.id,
              externalId: ad.ad_id,
              name: ad.ad_name || `Ad ${ad.ad_id}`,
              platform,
              level: 'ad',
              status: ad.ad_status,
              parentId: adGroup.id,
              accountId,
              children: []
            };
            adGroupEntity.children.push(adEntity);
          }

          campaignEntity.children.push(adGroupEntity);
        }

        account.children.push(campaignEntity);
      }

      accounts.set(accountKey, account);
    }

    return accounts;
  }

  /**
   * Parse platform_accountId key back into components
   */
  private parsePlatformAccountKey(key: string): [string, string] {
    const underscoreIndex = key.indexOf('_');
    if (underscoreIndex === -1) return [key, ''];
    return [key.substring(0, underscoreIndex), key.substring(underscoreIndex + 1)];
  }

  /**
   * Get display name for platform
   */
  private getPlatformDisplayName(platform: string): string {
    const names: Record<string, string> = {
      google: 'Google Ads',
      facebook: 'Meta Ads',
      tiktok: 'TikTok Ads',
      linkedin: 'LinkedIn Ads',
      twitter: 'Twitter Ads',
      pinterest: 'Pinterest Ads',
      snapchat: 'Snapchat Ads',
      microsoft: 'Microsoft Ads'
    };
    return names[platform] || `${platform.charAt(0).toUpperCase() + platform.slice(1)} Ads`;
  }

  /**
   * Count total entities in the tree
   */
  private countEntities(tree: EntityTree): number {
    let count = 0;

    const countNode = (entity: Entity): number => {
      let nodeCount = 1;
      for (const child of entity.children) {
        nodeCount += countNode(child);
      }
      return nodeCount;
    };

    for (const account of tree.accounts.values()) {
      count += countNode(account);
    }

    return count;
  }

  /**
   * Get all entities at a specific level
   */
  getEntitiesAtLevel(tree: EntityTree, level: EntityLevel): Entity[] {
    const entities: Entity[] = [];

    const collectAtLevel = (entity: Entity) => {
      if (entity.level === level) {
        entities.push(entity);
      }
      for (const child of entity.children) {
        collectAtLevel(child);
      }
    };

    for (const account of tree.accounts.values()) {
      collectAtLevel(account);
    }

    return entities;
  }
}
