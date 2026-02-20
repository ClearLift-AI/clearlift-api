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
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'current_budget_cents', 'recommended_budget_cents', 'budget_type', 'reason', 'confidence']
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
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'current_status', 'recommended_status', 'reason', 'confidence']
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
  },
  {
    name: 'set_audience',
    description: 'Recommend audience targeting changes for an ad set or ad group. Use when demographic or interest targeting could improve performance based on conversion data patterns.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'The ad platform',
          enum: ['facebook', 'tiktok']
        },
        entity_type: {
          type: 'string',
          description: 'Type of entity to adjust (ad_set for Facebook, ad_group for TikTok)',
          enum: ['ad_set', 'ad_group']
        },
        entity_id: {
          type: 'string',
          description: 'ID of the ad set or ad group'
        },
        entity_name: {
          type: 'string',
          description: 'Name of the entity for display'
        },
        targeting_changes: {
          type: 'object',
          description: 'Object containing targeting parameters to change'
        },
        age_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Age groups to target. TikTok: AGE_13_17, AGE_18_24, AGE_25_34, AGE_35_44, AGE_45_54, AGE_55_100. Facebook: 18-24, 25-34, 35-44, 45-54, 55-64, 65+'
        },
        gender: {
          type: 'string',
          description: 'Gender targeting',
          enum: ['MALE', 'FEMALE', 'ALL']
        },
        locations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Location IDs or names to target'
        },
        interests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Interest category IDs to target'
        },
        exclude_interests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Interest category IDs to exclude'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change (e.g., 20 for 20% conversion rate improvement)'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'reason', 'confidence']
    }
  },
  {
    name: 'set_bid',
    description: 'Recommend a bid or bidding strategy change for a campaign or ad set. Use when auction performance suggests bid adjustments could improve efficiency or scale.',
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
        current_bid_cents: {
          type: 'number',
          description: 'Current bid cap in cents (if applicable)'
        },
        recommended_bid_cents: {
          type: 'number',
          description: 'Recommended new bid cap in cents'
        },
        current_strategy: {
          type: 'string',
          description: 'Current bidding strategy',
          enum: ['manual_cpc', 'maximize_clicks', 'maximize_conversions', 'target_cpa', 'target_roas']
        },
        recommended_strategy: {
          type: 'string',
          description: 'Recommended bidding strategy',
          enum: ['manual_cpc', 'maximize_clicks', 'maximize_conversions', 'target_cpa', 'target_roas']
        },
        target_cpa_cents: {
          type: 'number',
          description: 'Target CPA in cents (if recommending target_cpa strategy)'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change (e.g., -10 for 10% CAC reduction)'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'reason', 'confidence']
    }
  },
  {
    name: 'set_schedule',
    description: 'Recommend ad schedule (dayparting) changes for a campaign or ad set. Use when hourly or daily performance patterns suggest certain hours/days should be added or removed.',
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
        hours_to_add: {
          type: 'array',
          items: { type: 'number' },
          description: 'Hours (0-23) to add to the schedule'
        },
        hours_to_remove: {
          type: 'array',
          items: { type: 'number' },
          description: 'Hours (0-23) to remove from the schedule'
        },
        days_to_add: {
          type: 'array',
          items: { type: 'number' },
          description: 'Days to add (0=Sunday, 6=Saturday)'
        },
        days_to_remove: {
          type: 'array',
          items: { type: 'number' },
          description: 'Days to remove (0=Sunday, 6=Saturday)'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change (e.g., -8 for 8% CAC reduction)'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'reason', 'confidence']
    }
  },
  {
    name: 'general_insight',
    description: 'Surface strategic observations that CANNOT be addressed with set_budget, set_status, or set_audience. Examples: cross-platform attribution gaps, data quality issues, seasonal patterns. Do NOT use this for underperforming campaigns/ads - use set_status to recommend pausing those instead. NOTE: All general_insight calls ACCUMULATE into a single document and count as ONE recommendation toward your limit.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category of insight',
          enum: ['data_quality', 'strategic', 'opportunity', 'warning', 'observation']
        },
        title: {
          type: 'string',
          description: 'Short title for the insight (max 100 chars)'
        },
        insight: {
          type: 'string',
          description: 'The detailed finding or observation'
        },
        affected_entities: {
          type: 'string',
          description: 'Comma-separated list of entity names this affects'
        },
        suggested_action: {
          type: 'string',
          description: 'Optional suggested action the user could take'
        },
        confidence: {
          type: 'string',
          description: 'Confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['category', 'title', 'insight', 'confidence']
    }
  },
  {
    name: 'terminate_analysis',
    description: 'End the analysis loop early when sufficient recommendations have been made or no further actionable insights exist. Call this instead of continuing to iterate when: (1) you have made high-quality actionable recommendations, (2) data quality prevents meaningful further analysis, (3) all major opportunities have been addressed, or (4) continuing would produce low-confidence or repetitive suggestions.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why analysis is being terminated early'
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished in this analysis'
        }
      },
      required: ['reason']
    }
  }
];

// Check if a tool name is a recommendation tool
export function isRecommendationTool(toolName: string): boolean {
  return RECOMMENDATION_TOOLS.some(t => t.name === toolName);
}

// Check if tool is the terminate_analysis control tool
export function isTerminateAnalysisTool(toolName: string): boolean {
  return toolName === 'terminate_analysis';
}

// Check if tool is a general_insight (for accumulation handling)
export function isGeneralInsightTool(toolName: string): boolean {
  return toolName === 'general_insight';
}

// Format tools for Anthropic API
export function getAnthropicTools(): any[] {
  return RECOMMENDATION_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }));
}

// Generic tool definitions (provider-agnostic canonical format)
export function getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
  return RECOMMENDATION_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }));
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
  // Handle general_insight specially - it doesn't have platform/entity fields
  if (toolName === 'general_insight') {
    return {
      tool: toolName,
      platform: 'general',  // Not platform-specific
      entity_type: 'insight',
      entity_id: toolInput.category || 'general',  // Use category as identifier
      entity_name: toolInput.title,  // Title becomes entity_name for display
      parameters: toolInput,
      reason: toolInput.insight,  // Insight becomes the reason
      predicted_impact: null,  // Insights don't have predicted impact
      confidence: toolInput.confidence || 'medium'
    };
  }

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
