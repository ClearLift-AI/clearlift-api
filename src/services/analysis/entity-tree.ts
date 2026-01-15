/**
 * Entity Tree Builder
 *
 * Builds hierarchical tree of ad entities from D1 ANALYTICS_DB.
 * Normalizes platform differences (Meta adset = Google ad_group).
 * Uses Sessions API for read replication support.
 */

// D1 types (D1Database, D1DatabaseSession, etc.) come from worker-configuration.d.ts

export type Platform = 'google' | 'facebook' | 'tiktok';
export type EntityLevel = 'ad' | 'adset' | 'campaign' | 'account';

export interface Entity {
  id: string;
  externalId: string;  // Platform's ID (ad_id, campaign_id, etc.)
  name: string;
  platform: Platform;
  level: EntityLevel;
  status: 'ENABLED' | 'PAUSED' | 'REMOVED' | string;
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
}

export class EntityTreeBuilder {
  private session: D1DatabaseSession;

  constructor(db: D1Database) {
    // Use Sessions API for read replication support
    this.session = db.withSession('first-unconstrained');
  }

  /**
   * Build complete entity tree for an organization
   */
  async buildTree(orgId: string): Promise<EntityTree> {
    const tree: EntityTree = {
      organizationId: orgId,
      accounts: new Map(),
      totalEntities: 0
    };

    // Build trees for each platform in parallel
    const [googleTree, facebookTree] = await Promise.all([
      this.buildGoogleTree(orgId),
      this.buildFacebookTree(orgId)
    ]);

    // Merge into main tree
    for (const [key, account] of googleTree) {
      tree.accounts.set(key, account);
    }
    for (const [key, account] of facebookTree) {
      tree.accounts.set(key, account);
    }

    // Count total entities
    tree.totalEntities = this.countEntities(tree);

    return tree;
  }

  /**
   * Build Google Ads entity tree from D1 ANALYTICS_DB
   */
  private async buildGoogleTree(orgId: string): Promise<Map<string, AccountEntity>> {
    const accounts = new Map<string, AccountEntity>();

    // Fetch all campaigns from D1
    const campaignsResult = await this.session.prepare(`
      SELECT id, customer_id, campaign_id, campaign_name, campaign_status
      FROM google_campaigns
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      customer_id: string;
      campaign_id: string;
      campaign_name: string;
      campaign_status: string;
    }>();
    const campaigns = campaignsResult.results || [];

    // Fetch all ad groups from D1
    const adGroupsResult = await this.session.prepare(`
      SELECT id, customer_id, campaign_id, ad_group_id, ad_group_name, ad_group_status
      FROM google_ad_groups
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      customer_id: string;
      campaign_id: string;
      ad_group_id: string;
      ad_group_name: string;
      ad_group_status: string;
    }>();
    const adGroups = adGroupsResult.results || [];

    // Fetch all ads from D1
    const adsResult = await this.session.prepare(`
      SELECT id, customer_id, campaign_id, ad_group_id, ad_id, ad_name, ad_status
      FROM google_ads
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      customer_id: string;
      campaign_id: string;
      ad_group_id: string;
      ad_id: string;
      ad_name: string;
      ad_status: string;
    }>();
    const ads = adsResult.results || [];

    // Pre-index data with Maps for O(1) lookups instead of O(n) filter operations
    // This changes complexity from O(n³) to O(n) where n = total entities
    const campaignsByCustomer = new Map<string, typeof campaigns>();
    for (const c of campaigns) {
      const list = campaignsByCustomer.get(c.customer_id) || [];
      list.push(c);
      campaignsByCustomer.set(c.customer_id, list);
    }

    const adGroupsByCampaign = new Map<string, typeof adGroups>();
    for (const ag of adGroups) {
      const list = adGroupsByCampaign.get(ag.campaign_id) || [];
      list.push(ag);
      adGroupsByCampaign.set(ag.campaign_id, list);
    }

    const adsByAdGroup = new Map<string, typeof ads>();
    for (const a of ads) {
      const list = adsByAdGroup.get(a.ad_group_id) || [];
      list.push(a);
      adsByAdGroup.set(a.ad_group_id, list);
    }

    // Get unique customer IDs from the index keys
    for (const customerId of campaignsByCustomer.keys()) {
      const accountKey = `google_${customerId}`;

      // Create account entity
      const account: AccountEntity = {
        id: accountKey,
        externalId: customerId,
        name: `Google Ads ${customerId}`,
        platform: 'google',
        level: 'account',
        status: 'ENABLED',
        customerId,
        children: []
      };

      // Build campaign entities (O(1) Map lookup)
      const accountCampaigns = campaignsByCustomer.get(customerId) || [];
      for (const campaign of accountCampaigns) {
        const campaignEntity: Entity = {
          id: campaign.id,
          externalId: campaign.campaign_id,
          name: campaign.campaign_name,
          platform: 'google',
          level: 'campaign',
          status: campaign.campaign_status,
          parentId: accountKey,
          accountId: customerId,
          children: []
        };

        // Build ad group entities (O(1) Map lookup, normalized as 'adset')
        const campaignAdGroups = adGroupsByCampaign.get(campaign.campaign_id) || [];
        for (const adGroup of campaignAdGroups) {
          const adGroupEntity: Entity = {
            id: adGroup.id,
            externalId: adGroup.ad_group_id,
            name: adGroup.ad_group_name,
            platform: 'google',
            level: 'adset',  // Normalized
            status: adGroup.ad_group_status,
            parentId: campaign.id,
            accountId: customerId,
            children: []
          };

          // Build ad entities (O(1) Map lookup)
          const groupAds = adsByAdGroup.get(adGroup.ad_group_id) || [];
          for (const ad of groupAds) {
            const adEntity: Entity = {
              id: ad.id,
              externalId: ad.ad_id,
              name: ad.ad_name || `Ad ${ad.ad_id}`,
              platform: 'google',
              level: 'ad',
              status: ad.ad_status,
              parentId: adGroup.id,
              accountId: customerId,
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
   * Build Facebook Ads entity tree from D1 ANALYTICS_DB
   */
  private async buildFacebookTree(orgId: string): Promise<Map<string, AccountEntity>> {
    const accounts = new Map<string, AccountEntity>();

    // Fetch all campaigns from D1
    const campaignsResult = await this.session.prepare(`
      SELECT id, account_id, campaign_id, campaign_name as name, campaign_status as status
      FROM facebook_campaigns
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      account_id: string;
      campaign_id: string;
      name: string;
      status: string;
    }>();
    const campaigns = (campaignsResult.results || []).map(c => ({
      ...c,
      ad_account_id: c.account_id  // Normalize to old naming
    }));

    // Fetch all ad sets from D1
    const adSetsResult = await this.session.prepare(`
      SELECT id, account_id, campaign_id, ad_set_id as adset_id, ad_set_name as name, ad_set_status as status
      FROM facebook_ad_sets
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      account_id: string;
      campaign_id: string;
      adset_id: string;
      name: string;
      status: string;
    }>();
    const adSets = (adSetsResult.results || []).map(as => ({
      ...as,
      ad_account_id: as.account_id
    }));

    // Fetch all ads from D1
    const adsResult = await this.session.prepare(`
      SELECT id, account_id, campaign_id, ad_set_id as adset_id, ad_id, ad_name as name, ad_status as status
      FROM facebook_ads
      WHERE organization_id = ?
    `).bind(orgId).all<{
      id: string;
      account_id: string;
      campaign_id: string;
      adset_id: string;
      ad_id: string;
      name: string;
      status: string;
    }>();
    const ads = (adsResult.results || []).map(a => ({
      ...a,
      ad_account_id: a.account_id
    }));

    // Pre-index data with Maps for O(1) lookups instead of O(n) filter operations
    // This changes complexity from O(n³) to O(n) where n = total entities
    const campaignsByAccount = new Map<string, typeof campaigns>();
    for (const c of campaigns) {
      const list = campaignsByAccount.get(c.ad_account_id) || [];
      list.push(c);
      campaignsByAccount.set(c.ad_account_id, list);
    }

    const adSetsByCampaign = new Map<string, typeof adSets>();
    for (const as of adSets) {
      const list = adSetsByCampaign.get(as.campaign_id) || [];
      list.push(as);
      adSetsByCampaign.set(as.campaign_id, list);
    }

    const adsByAdSet = new Map<string, typeof ads>();
    for (const a of ads) {
      const list = adsByAdSet.get(a.adset_id) || [];
      list.push(a);
      adsByAdSet.set(a.adset_id, list);
    }

    // Get unique account IDs from the index keys
    for (const adAccountId of campaignsByAccount.keys()) {
      const accountKey = `facebook_${adAccountId}`;

      // Create account entity
      const account: AccountEntity = {
        id: accountKey,
        externalId: adAccountId,
        name: `Meta Ads ${adAccountId}`,
        platform: 'facebook',
        level: 'account',
        status: 'ENABLED',
        adAccountId,
        children: []
      };

      // Build campaign entities (O(1) Map lookup)
      const accountCampaigns = campaignsByAccount.get(adAccountId) || [];
      for (const campaign of accountCampaigns) {
        const campaignEntity: Entity = {
          id: campaign.id,
          externalId: campaign.campaign_id,
          name: campaign.name,
          platform: 'facebook',
          level: 'campaign',
          status: campaign.status,
          parentId: accountKey,
          accountId: adAccountId,
          children: []
        };

        // Build adset entities (O(1) Map lookup)
        const campaignAdSets = adSetsByCampaign.get(campaign.campaign_id) || [];
        for (const adSet of campaignAdSets) {
          const adSetEntity: Entity = {
            id: adSet.id,
            externalId: adSet.adset_id,
            name: adSet.name,
            platform: 'facebook',
            level: 'adset',
            status: adSet.status,
            parentId: campaign.id,
            accountId: adAccountId,
            children: []
          };

          // Build ad entities (O(1) Map lookup)
          const setAds = adsByAdSet.get(adSet.adset_id) || [];
          for (const ad of setAds) {
            const adEntity: Entity = {
              id: ad.id,
              externalId: ad.ad_id,
              name: ad.name || `Ad ${ad.ad_id}`,
              platform: 'facebook',
              level: 'ad',
              status: ad.status,
              parentId: adSet.id,
              accountId: adAccountId,
              children: []
            };
            adSetEntity.children.push(adEntity);
          }

          campaignEntity.children.push(adSetEntity);
        }

        account.children.push(campaignEntity);
      }

      accounts.set(accountKey, account);
    }

    return accounts;
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
