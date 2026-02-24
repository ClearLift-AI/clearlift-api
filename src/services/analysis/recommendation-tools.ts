/**
 * Recommendation Tools for Agentic Analysis
 *
 * Tools the LLM can call to make actionable recommendations
 * These map to the ai_tool_registry and ai_decisions tables
 */

import { AnalysisLevel } from './llm-provider';

// Tool definitions for Claude/Gemini function calling
export interface ToolPropertyDef {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface RecommendationTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolPropertyDef>;
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
    description: 'Recommend moving budget from one entity to another. Optionally pause the source entity in the same action — use pause_source=true when you want to fully shut down a losing campaign and redirect ALL its budget to a winner. This counts as ONE action slot (not two), so prefer this over separate set_status + set_budget calls.',
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
          description: 'Amount to reallocate in cents (daily budget)'
        },
        pause_source: {
          type: 'boolean',
          description: 'If true, also pause the source entity after reallocating its budget. Use when the source campaign should be fully shut down (e.g., zero conversions, unprofitable ROAS). This creates a single combined recommendation: "Pause X and move its budget to Y." Defaults to false.'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this recommendation. Include dollar impact estimates.'
        },
        predicted_impact: {
          type: 'number',
          description: 'Expected impact as percentage change on portfolio revenue or CAC'
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
    description: 'Recommend a bid or bidding strategy change for a campaign or ad set. Use when auction performance suggests bid adjustments could improve efficiency or scale. Strategy names are platform-specific — use the correct enum for the target platform.',
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
          description: 'Recommended new bid cap in cents. Required for Meta COST_CAP and LOWEST_COST_WITH_BID_CAP strategies, and for TikTok BID_TYPE_CUSTOM.'
        },
        current_strategy: {
          type: 'string',
          description: 'Current bidding strategy. Facebook: LOWEST_COST_WITHOUT_CAP, COST_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITH_MIN_ROAS. Google: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, MANUAL_CPC, TARGET_IMPRESSION_SHARE. TikTok: BID_TYPE_NO_BID, BID_TYPE_CUSTOM.'
        },
        recommended_strategy: {
          type: 'string',
          description: 'Recommended bidding strategy. Facebook: LOWEST_COST_WITHOUT_CAP (auto, no cap), COST_CAP (target CPA with cap), LOWEST_COST_WITH_BID_CAP (max bid per auction), LOWEST_COST_WITH_MIN_ROAS (min ROAS floor). Google: MAXIMIZE_CONVERSIONS (with optional target_cpa_cents), MAXIMIZE_CONVERSION_VALUE (with optional target_roas_floor), MANUAL_CPC, TARGET_IMPRESSION_SHARE. TikTok: BID_TYPE_NO_BID (auto), BID_TYPE_CUSTOM (manual bid).'
        },
        target_cpa_cents: {
          type: 'number',
          description: 'Target CPA in cents. Used with Meta COST_CAP (sets bid_amount) and Google MAXIMIZE_CONVERSIONS (sets target_cpa_micros).'
        },
        target_roas_floor: {
          type: 'number',
          description: 'Minimum ROAS floor, scaled 10000x. Example: 15000 = 1.5x ROAS (150%). Used with Meta LOWEST_COST_WITH_MIN_ROAS (sets roas_average_floor) and Google MAXIMIZE_CONVERSION_VALUE (sets target_roas, will be divided by 10000). Valid range: 100-10000000.'
        },
        optimization_goal: {
          type: 'string',
          description: 'TikTok only: optimization goal for the ad group (CLICK, CONVERT, INSTALL, REACH, VIDEO_VIEW, LEAD_GENERATION)'
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
      required: ['platform', 'entity_type', 'entity_id', 'entity_name', 'recommended_strategy', 'reason', 'confidence']
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
    description: 'FALLBACK ONLY — use this for observations that genuinely cannot be expressed as set_budget, set_status, set_audience, or reallocate_budget. Examples: data quality gaps, missing tracking setup, cross-platform attribution issues. Do NOT use this for underperforming campaigns/ads — use set_status to recommend pausing those instead. Do NOT use this as a substitute for action tools. Multiple calls accumulate into a single document and do NOT count toward your action limit.',
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
    name: 'update_recommendation',
    description: 'Update a recommendation you already made during THIS analysis run. Use when new data changes your assessment — for example, after exploring deeper you realize a different budget amount or a different entity would be better. This replaces the previous recommendation in-place.',
    input_schema: {
      type: 'object',
      properties: {
        original_entity_id: {
          type: 'string',
          description: 'The entity_id of the recommendation you want to update (from a previous set_budget, set_status, etc. call)'
        },
        original_tool: {
          type: 'string',
          description: 'The tool name of the original recommendation',
          enum: ['set_budget', 'set_status', 'set_audience', 'reallocate_budget', 'set_bid', 'set_schedule']
        },
        new_parameters: {
          type: 'object',
          description: 'The updated parameters. Include ALL fields, not just changed ones — this fully replaces the old recommendation parameters.'
        },
        new_reason: {
          type: 'string',
          description: 'Updated reason explaining why this change is better than the original recommendation'
        },
        new_confidence: {
          type: 'string',
          description: 'Updated confidence level',
          enum: ['low', 'medium', 'high']
        }
      },
      required: ['original_entity_id', 'original_tool', 'new_parameters', 'new_reason']
    }
  },
  {
    name: 'delete_recommendation',
    description: 'Delete a recommendation you already made during THIS analysis run. Use when further investigation reveals the recommendation was wrong or unnecessary. This frees up an action slot so you can make a different recommendation instead.',
    input_schema: {
      type: 'object',
      properties: {
        original_entity_id: {
          type: 'string',
          description: 'The entity_id of the recommendation to delete'
        },
        original_tool: {
          type: 'string',
          description: 'The tool name of the original recommendation',
          enum: ['set_budget', 'set_status', 'set_audience', 'reallocate_budget', 'set_bid', 'set_schedule']
        },
        reason: {
          type: 'string',
          description: 'Why this recommendation is being withdrawn'
        }
      },
      required: ['original_entity_id', 'original_tool', 'reason']
    }
  },
  {
    name: 'terminate_analysis',
    description: 'End the analysis loop ONLY after you have already made actionable recommendations (set_budget, set_status, set_audience, set_bid). Do NOT call this after only producing general_insight or exploration — you MUST attempt concrete recommendations first. The only exception is when data is genuinely insufficient for ANY recommendation (e.g. zero spend, no active entities). If you have insights but have not yet made recommendations, keep going — use simulate_change, explore further, and produce actionable recommendations before terminating.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why analysis is complete. Must reference the recommendations already made, or explain why no recommendations are possible.'
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished in this analysis'
        },
        recommendation_count: {
          type: 'number',
          description: 'Number of actionable recommendations (set_budget, set_status, etc.) made before terminating. Must be > 0 unless data is insufficient.'
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

// Check if tool is update_recommendation
export function isUpdateRecommendationTool(toolName: string): boolean {
  return toolName === 'update_recommendation';
}

// Check if tool is delete_recommendation
export function isDeleteRecommendationTool(toolName: string): boolean {
  return toolName === 'delete_recommendation';
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
