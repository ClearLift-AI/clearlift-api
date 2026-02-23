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
    budgetStrategy?: 'conservative' | 'moderate' | 'aggressive';
    dailyCapCents?: number | null;
    monthlyCapCents?: number | null;
    maxCacCents?: number | null;
  };
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
  // Tool call names from this iteration (for sequential pattern detection)
  toolCallNames?: string[];
}
