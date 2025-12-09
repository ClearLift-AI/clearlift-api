/**
 * Entity Tree Builder
 *
 * Builds hierarchical tree of ad entities from Supabase data
 * Normalizes platform differences (Meta adset = Google ad_group)
 */

import { SupabaseClient } from '../supabase';

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
  constructor(private supabase: SupabaseClient) {}

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
   * Build Google Ads entity tree
   */
  private async buildGoogleTree(orgId: string): Promise<Map<string, AccountEntity>> {
    const accounts = new Map<string, AccountEntity>();

    // Fetch all campaigns
    const campaigns = await this.supabase.select<{
      id: string;
      customer_id: string;
      campaign_id: string;
      campaign_name: string;
      campaign_status: string;
    }>('campaigns', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'google_ads'
    });

    // Fetch all ad groups
    const adGroups = await this.supabase.select<{
      id: string;
      customer_id: string;
      campaign_id: string;
      ad_group_id: string;
      ad_group_name: string;
      ad_group_status: string;
    }>('ad_groups', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'google_ads'
    });

    // Fetch all ads
    const ads = await this.supabase.select<{
      id: string;
      customer_id: string;
      campaign_id: string;
      ad_group_id: string;
      ad_id: string;
      ad_name: string;
      ad_status: string;
    }>('ads', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'google_ads'
    });

    // Group by customer_id (account)
    const customerIds = new Set<string>();
    for (const c of campaigns) customerIds.add(c.customer_id);

    for (const customerId of customerIds) {
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

      // Build campaign entities
      const accountCampaigns = campaigns.filter(c => c.customer_id === customerId);
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

        // Build ad group entities (normalized as 'adset')
        const campaignAdGroups = adGroups.filter(ag => ag.campaign_id === campaign.campaign_id);
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

          // Build ad entities
          const groupAds = ads.filter(a => a.ad_group_id === adGroup.ad_group_id);
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
   * Build Facebook Ads entity tree
   */
  private async buildFacebookTree(orgId: string): Promise<Map<string, AccountEntity>> {
    const accounts = new Map<string, AccountEntity>();

    // Fetch all campaigns
    const campaigns = await this.supabase.select<{
      id: string;
      ad_account_id: string;
      campaign_id: string;
      name: string;
      status: string;
    }>('campaigns', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'facebook_ads'
    });

    // Fetch all ad sets
    const adSets = await this.supabase.select<{
      id: string;
      ad_account_id: string;
      campaign_id: string;
      adset_id: string;
      name: string;
      status: string;
    }>('ad_sets', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'facebook_ads'
    });

    // Fetch all ads
    const ads = await this.supabase.select<{
      id: string;
      ad_account_id: string;
      campaign_id: string;
      adset_id: string;
      ad_id: string;
      name: string;
      status: string;
    }>('ads', `organization_id.eq.${orgId}&deleted_at.is.null`, {
      schema: 'facebook_ads'
    });

    // Group by ad_account_id
    const adAccountIds = new Set<string>();
    for (const c of campaigns) adAccountIds.add(c.ad_account_id);

    for (const adAccountId of adAccountIds) {
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

      // Build campaign entities
      const accountCampaigns = campaigns.filter(c => c.ad_account_id === adAccountId);
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

        // Build adset entities
        const campaignAdSets = adSets.filter(as => as.campaign_id === campaign.campaign_id);
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

          // Build ad entities
          const setAds = ads.filter(a => a.adset_id === adSet.adset_id);
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
