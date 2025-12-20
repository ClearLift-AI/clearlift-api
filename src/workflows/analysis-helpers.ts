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
    totalEntities: tree.totalEntities
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
    totalEntities: serialized.totalEntities
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
 * Result from a single agentic iteration
 */
export interface AgenticIterationResult {
  messages: any[];  // Conversation history
  recommendations: any[];
  shouldStop: boolean;
  stopReason?: 'max_recommendations' | 'no_tool_calls' | 'max_iterations';
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
