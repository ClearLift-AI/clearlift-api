/**
 * Analysis Workflow Helpers
 *
 * Serialization utilities for passing state between workflow steps.
 * Workflows require all step return values to be JSON-serializable.
 */

import {
  Entity,
  AccountEntity,
  EntityTree,
  Platform,
  EntityLevel
} from '../services/analysis/entity-tree';
import { AnalysisLevel } from '../services/analysis/llm-provider';

/**
 * Serializable version of Entity (no circular refs, no Maps)
 */
export interface SerializedEntity {
  id: string;
  externalId: string;
  name: string;
  platform: Platform;
  level: EntityLevel;
  status: string;
  parentId?: string;
  accountId?: string;
  children: SerializedEntity[];
  metadata?: Record<string, any>;
  // Account-specific fields
  customerId?: string;
  adAccountId?: string;
}

/**
 * Serializable version of EntityTree (Map converted to array)
 */
export interface SerializedEntityTree {
  organizationId: string;
  accounts: Array<[string, SerializedEntity]>;
  totalEntities: number;
  platforms: string[];  // Active platforms discovered
}

/**
 * Convert Entity to serializable form (recursive for children)
 */
function serializeEntity(entity: Entity | AccountEntity): SerializedEntity {
  const serialized: SerializedEntity = {
    id: entity.id,
    externalId: entity.externalId,
    name: entity.name,
    platform: entity.platform,
    level: entity.level,
    status: entity.status,
    children: entity.children.map(child => serializeEntity(child))
  };

  if (entity.parentId) serialized.parentId = entity.parentId;
  if (entity.accountId) serialized.accountId = entity.accountId;
  if (entity.metadata) serialized.metadata = entity.metadata;

  // Account-specific fields
  if (entity.level === 'account') {
    const account = entity as AccountEntity;
    if (account.customerId) serialized.customerId = account.customerId;
    if (account.adAccountId) serialized.adAccountId = account.adAccountId;
  }

  return serialized;
}

/**
 * Convert serialized entity back to Entity form
 */
function deserializeEntity(serialized: SerializedEntity): Entity {
  const entity: Entity = {
    id: serialized.id,
    externalId: serialized.externalId,
    name: serialized.name,
    platform: serialized.platform,
    level: serialized.level,
    status: serialized.status,
    children: serialized.children.map(child => deserializeEntity(child))
  };

  if (serialized.parentId) entity.parentId = serialized.parentId;
  if (serialized.accountId) entity.accountId = serialized.accountId;
  if (serialized.metadata) entity.metadata = serialized.metadata;

  return entity;
}

/**
 * Convert serialized entity to AccountEntity
 */
function deserializeAccountEntity(serialized: SerializedEntity): AccountEntity {
  const base = deserializeEntity(serialized);
  const account: AccountEntity = {
    ...base,
    level: 'account'
  };

  if (serialized.customerId) account.customerId = serialized.customerId;
  if (serialized.adAccountId) account.adAccountId = serialized.adAccountId;

  return account;
}

/**
 * Serialize EntityTree for passing between workflow steps
 */
export function serializeEntityTree(tree: EntityTree): SerializedEntityTree {
  const accountsArray: Array<[string, SerializedEntity]> = [];

  for (const [key, account] of tree.accounts) {
    accountsArray.push([key, serializeEntity(account)]);
  }

  return {
    organizationId: tree.organizationId,
    accounts: accountsArray,
    totalEntities: tree.totalEntities,
    platforms: tree.platforms || []
  };
}

/**
 * Deserialize EntityTree from workflow step state
 */
export function deserializeEntityTree(serialized: SerializedEntityTree): EntityTree {
  const accounts = new Map<string, AccountEntity>();

  for (const [key, serializedAccount] of serialized.accounts) {
    accounts.set(key, deserializeAccountEntity(serializedAccount));
  }

  return {
    organizationId: serialized.organizationId,
    accounts,
    totalEntities: serialized.totalEntities,
    platforms: serialized.platforms || []
  };
}

/**
 * Get all entities at a specific level from serialized tree
 */
export function getEntitiesAtLevel(
  serialized: SerializedEntityTree,
  level: EntityLevel
): SerializedEntity[] {
  const entities: SerializedEntity[] = [];

  const collectEntities = (entity: SerializedEntity) => {
    if (entity.level === level) {
      entities.push(entity);
    }
    for (const child of entity.children) {
      collectEntities(child);
    }
  };

  for (const [, account] of serialized.accounts) {
    collectEntities(account);
  }

  return entities;
}

/**
 * Check if an entity's status is considered "active"
 */
export function isActiveStatus(status: string | undefined): boolean {
  if (!status) return false;
  const activeStatuses = ['ACTIVE', 'ENABLED', 'RUNNING', 'LIVE'];
  return activeStatuses.includes(status.toUpperCase());
}

/**
 * Build a map of entity IDs that should be skipped due to disabled parent hierarchy.
 * If a campaign is disabled, all its ad sets and ads should be skipped.
 * If an ad set is disabled, all its ads should be skipped.
 *
 * This dramatically reduces LLM calls for accounts with many paused campaigns.
 */
export function buildHierarchySkipSet(tree: SerializedEntityTree): Set<string> {
  const skipSet = new Set<string>();

  const markChildrenForSkip = (entity: SerializedEntity) => {
    for (const child of entity.children) {
      skipSet.add(child.id);
      // Recursively mark all descendants
      markChildrenForSkip(child);
    }
  };

  // Traverse the tree and mark children of disabled entities
  for (const [, account] of tree.accounts) {
    // Check each campaign
    for (const campaign of account.children) {
      if (!isActiveStatus(campaign.status)) {
        // Campaign is disabled - skip ALL its children (ad sets and ads)
        markChildrenForSkip(campaign);
      } else {
        // Campaign is active - check ad sets
        for (const adset of campaign.children) {
          if (!isActiveStatus(adset.status)) {
            // Ad set is disabled - skip its ads
            markChildrenForSkip(adset);
          }
        }
      }
    }
  }

  return skipSet;
}


/**
 * Maximum entities to process per workflow to avoid hitting subrequest limits.
 * With ~3 subrequests per entity (metrics + template + LLM), 500 entities = ~1500 internal subrequests
 * plus step overhead. This keeps us safely under the Cloudflare Workflow limits.
 */
export const MAX_ENTITIES_PER_WORKFLOW = 500;

/**
 * Prune entity tree to only include entities with IDs in the activeSet.
 * Ancestors are kept if any descendant is active (so the hierarchy stays intact).
 * Returns a new serialized tree with updated totalEntities count.
 */
export function pruneEntityTree(
  tree: SerializedEntityTree,
  activeEntityIds: Set<string>
): SerializedEntityTree {
  const prunedAccounts: Array<[string, SerializedEntity]> = [];
  let totalEntities = 0;

  for (const [key, account] of tree.accounts) {
    const prunedCampaigns: SerializedEntity[] = [];

    for (const campaign of account.children) {
      const prunedAdsets: SerializedEntity[] = [];

      for (const adset of campaign.children) {
        // Keep ads that have activity
        const prunedAds = adset.children.filter(ad => activeEntityIds.has(ad.id));

        // Keep adset if it has active children or itself has activity
        if (prunedAds.length > 0 || activeEntityIds.has(adset.id)) {
          prunedAdsets.push({ ...adset, children: prunedAds });
        }
      }

      // Keep campaign if it has active children or itself has activity
      if (prunedAdsets.length > 0 || activeEntityIds.has(campaign.id)) {
        prunedCampaigns.push({ ...campaign, children: prunedAdsets });
      }
    }

    // Keep account if it has active children
    if (prunedCampaigns.length > 0) {
      const prunedAccount = { ...account, children: prunedCampaigns };
      prunedAccounts.push([key, prunedAccount]);
    }
  }

  // Count entities in pruned tree
  const countNode = (entity: SerializedEntity): number => {
    let count = 1;
    for (const child of entity.children) {
      count += countNode(child);
    }
    return count;
  };
  for (const [, account] of prunedAccounts) {
    totalEntities += countNode(account);
  }

  return {
    organizationId: tree.organizationId,
    accounts: prunedAccounts,
    totalEntities,
    platforms: tree.platforms
  };
}

/**
 * Parameters for the analysis workflow
 */
export interface AnalysisWorkflowParams {
  orgId: string;
  days: number;
  jobId: string;
  customInstructions: string | null;
  config: {
    llm?: {
      defaultProvider: 'auto' | 'claude' | 'gemini';
      claudeModel: 'opus' | 'sonnet' | 'haiku';
      geminiModel: 'pro' | 'flash' | 'flash_lite';
    };
    agentic?: {
      maxRecommendations?: number;
      enableExploration?: boolean;
    };
  };
}

/**
 * Result from analyzing a single level
 */
export interface LevelAnalysisResult {
  summaries: Record<string, string>;  // entityId -> summary
  processedCount: number;
}

/**
 * Accumulated insight data structure
 */
export interface AccumulatedInsightData {
  title: string;
  insight: string;
  category: string;
  affected_entities?: string;
  suggested_action?: string;
  confidence?: string;
}

/**
 * Result from a single agentic iteration
 */
export interface AgenticIterationResult {
  messages: any[];  // Conversation history
  recommendations: any[];  // All recommendations (insight + actions)
  actionRecommendations?: any[];  // Just action recommendations (set_budget, set_status, etc.)
  shouldStop: boolean;
  stopReason?: 'max_recommendations' | 'no_tool_calls' | 'max_iterations' | 'early_termination';
  terminationReason?: string;
  // Accumulated insight state (passed between iterations)
  accumulatedInsightId?: string;
  accumulatedInsights?: AccumulatedInsightData[];
}

/**
 * Create concurrency limiter for LLM calls within a step
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          active--;
          next();
        }
      };

      queue.push(run);
      next();
    });
  };
}
