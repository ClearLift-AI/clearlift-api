/**
 * Recommendation Tools for Agentic Analysis
 *
 * Tools the LLM can call to make actionable recommendations
 * These map to the ai_tool_registry and ai_decisions tables
 */

import { AnalysisLevel } from './llm-provider';

// Tool definitions for Claude/Gemini function calling
export interface RecommendationTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };
}

export const RECOMMENDATION_TOOLS: RecommendationTool[] = [
  {
    name: 'set_budget',
    description: 'Recommend a budget change for a campaign or ad set. Use when you see opportunity to scale profitable campaigns or cut spend on underperformers.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'The ad platform',
          enum: ['facebook', 'google', 'tiktok']
        },
        entity_type: {
          type: 'string',
          description: 'Type of entity to adjust',
          enum: ['campaign', 'ad_set', 'ad_group']
        },
        entity_id: {
          type: 'string',
          description: 'ID of the campaign or ad set'
        },
        entity_name: {
          type: 'string',
          description: 'Name of the entity for display'
        },
        current_budget_cents: {
          type: 'number',
          description: 'Current daily/lifetime budget in cents'
        },
        recommended_budget_cents: {
          type: 'number',
          description: 'Recommended new budget in cents'
        },
        budget_type: {
          type: 'string',
          description: 'Type of budget',
          enum: ['daily', 'lifetime']
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change (e.g., -15 for 15% CaC reduction)'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'recommended_budget_cents', 'budget_type', 'reason', 'confidence']
    }
  },
  {
    name: 'set_status',
    description: 'Recommend pausing or enabling a campaign, ad set, or ad. Use when an entity is clearly underperforming or when a paused entity shows potential.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'The ad platform',
          enum: ['facebook', 'google', 'tiktok']
        },
        entity_type: {
          type: 'string',
          description: 'Type of entity to adjust',
          enum: ['campaign', 'ad_set', 'ad_group', 'ad']
        },
        entity_id: {
          type: 'string',
          description: 'ID of the entity'
        },
        entity_name: {
          type: 'string',
          description: 'Name of the entity for display'
        },
        current_status: {
          type: 'string',
          description: 'Current status',
          enum: ['ENABLED', 'PAUSED']
        },
        recommended_status: {
          type: 'string',
          description: 'Recommended new status',
          enum: ['ENABLED', 'PAUSED']
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'recommended_status', 'reason', 'confidence']
    }
  },
  {
    name: 'reallocate_budget',
    description: 'Recommend moving budget from one entity to another. Use when you identify clear winners and losers that could benefit from reallocation.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'The ad platform',
          enum: ['facebook', 'google', 'tiktok']
        },
        from_entity_type: {
          type: 'string',
          description: 'Type of source entity',
          enum: ['campaign', 'ad_set', 'ad_group']
        },
        from_entity_id: {
          type: 'string',
          description: 'ID of source entity'
        },
        from_entity_name: {
          type: 'string',
          description: 'Name of source entity'
        },
        to_entity_type: {
          type: 'string',
          description: 'Type of target entity',
          enum: ['campaign', 'ad_set', 'ad_group']
        },
        to_entity_id: {
          type: 'string',
          description: 'ID of target entity'
        },
        to_entity_name: {
          type: 'string',
          description: 'Name of target entity'
        },
        amount_cents: {
          type: 'number',
          description: 'Amount to reallocate in cents'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'from_entity_id', 'from_entity_name', 'to_entity_id', 'to_entity_name', 'amount_cents', 'reason', 'confidence']
    }
  }
];

// Check if a tool name is a recommendation tool
export function isRecommendationTool(toolName: string): boolean {
  return RECOMMENDATION_TOOLS.some(t => t.name === toolName);
}

// Format tools for Anthropic API
export function getAnthropicTools(): any[] {
  return RECOMMENDATION_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }));
}

// Format tools for Gemini API
export function getGeminiTools(): any {
  return {
    function_declarations: RECOMMENDATION_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }))
  };
}

// Interface for a recommendation that will be logged
export interface Recommendation {
  tool: string;
  platform: string;
  entity_type: string;
  entity_id: string;
  entity_name: string;
  parameters: Record<string, any>;
  reason: string;
  predicted_impact: number | null;
  confidence: 'low' | 'medium' | 'high';
}

// Parse tool call into recommendation
export function parseToolCallToRecommendation(
  toolName: string,
  toolInput: Record<string, any>
): Recommendation {
  return {
    tool: toolName,
    platform: toolInput.platform,
    entity_type: toolInput.entity_type || toolInput.from_entity_type,
    entity_id: toolInput.entity_id || toolInput.from_entity_id,
    entity_name: toolInput.entity_name || toolInput.from_entity_name,
    parameters: toolInput,
    reason: toolInput.reason,
    predicted_impact: toolInput.predicted_impact || null,
    confidence: toolInput.confidence || 'medium'
  };
}
