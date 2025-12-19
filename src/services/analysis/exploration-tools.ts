/**
 * Exploration Tools
 *
 * Read-only tools for the agentic loop to investigate data before making recommendations.
 * These tools have no caps (unlike recommendation tools) and allow the AI to:
 * - Query metrics for specific entities
 * - Compare multiple entities side-by-side
 * - Get creative details
 * - Get audience/targeting breakdowns
 */

import { SupabaseClient } from '../../services/supabase';

// Tool definitions for Anthropic API
export const EXPLORATION_TOOLS = {
  query_metrics: {
    name: 'query_metrics',
    description: 'Query performance metrics for a specific ad entity. Use this to investigate performance data before making recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign', 'account'],
          description: 'Type of entity to query'
        },
        entity_id: {
          type: 'string',
          description: 'The entity ID to query'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to retrieve: spend, impressions, clicks, conversions, ctr, cpc, cpm, roas, cpa'
        },
        days: {
          type: 'number',
          description: 'Number of days of historical data (1-90)',
          minimum: 1,
          maximum: 90
        },
        include_verified_revenue: {
          type: 'boolean',
          description: 'Include Stripe-verified revenue data for comparison with platform-reported conversions'
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'metrics', 'days']
    }
  },

  compare_entities: {
    name: 'compare_entities',
    description: 'Compare performance metrics across multiple entities of the same type. Useful for identifying winners and losers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign'],
          description: 'Type of entities to compare'
        },
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'Entity IDs to compare (max 5)'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to compare'
        },
        days: {
          type: 'number',
          description: 'Number of days of data',
          minimum: 1,
          maximum: 90
        }
      },
      required: ['platform', 'entity_type', 'entity_ids', 'metrics', 'days']
    }
  },

  get_creative_details: {
    name: 'get_creative_details',
    description: 'Get details about an ad creative including copy, media, and performance indicators.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        ad_id: {
          type: 'string',
          description: 'The ad ID to get creative details for'
        }
      },
      required: ['platform', 'ad_id']
    }
  },

  get_audience_breakdown: {
    name: 'get_audience_breakdown',
    description: 'Get targeting/audience breakdown for an ad set or campaign. Shows age, gender, placement, device, or geo performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['adset', 'campaign'],
          description: 'Entity type'
        },
        entity_id: {
          type: 'string',
          description: 'Entity ID'
        },
        dimension: {
          type: 'string',
          enum: ['age', 'gender', 'placement', 'device', 'geo'],
          description: 'Breakdown dimension'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'dimension', 'days']
    }
  },

  query_stripe_revenue: {
    name: 'query_stripe_revenue',
    description: 'Query actual revenue from Stripe charges and subscriptions. Supports filtering by metadata (UTM params, product IDs, custom fields). Returns time-series data and summary statistics. Use this to understand real revenue vs platform-reported conversions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days of historical data'
        },
        conversion_type: {
          type: 'string',
          enum: ['all', 'charges', 'subscriptions', 'subscription_initial', 'subscription_renewal'],
          description: 'Type of conversions to include'
        },
        group_by: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Time grouping for aggregation'
        },
        filters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['succeeded', 'active', 'trialing'] },
            min_amount_cents: { type: 'number' },
            max_amount_cents: { type: 'number' },
            currency: { type: 'string' },
            product_id: { type: 'string' }
          },
          description: 'Basic filters for Stripe data'
        },
        metadata_filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['charge', 'product', 'price', 'customer'] },
              key: { type: 'string' },
              operator: { type: 'string', enum: ['equals', 'contains', 'starts_with', 'not_equals'] },
              value: { type: 'string' }
            },
            required: ['source', 'key', 'operator', 'value']
          },
          description: 'Filter by Stripe metadata fields (charge, product, price, or customer metadata)'
        },
        breakdown_by_metadata_key: {
          type: 'string',
          description: 'Group results by a metadata key (e.g., "utm_campaign", "product_name")'
        }
      },
      required: ['days']
    }
  },

  compare_spend_to_revenue: {
    name: 'compare_spend_to_revenue',
    description: 'Compare ad platform spend against actual Stripe revenue for a date range. Calculates true ROAS and shows discrepancy between platform-reported and verified conversions. Essential for understanding real campaign profitability.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days to analyze'
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['facebook', 'google', 'tiktok', 'all'] },
          description: 'Ad platforms to include'
        },
        breakdown_by: {
          type: 'string',
          enum: ['platform', 'day', 'campaign'],
          description: 'How to break down the comparison'
        }
      },
      required: ['days']
    }
  },

  query_attribution_quality: {
    name: 'query_attribution_quality',
    description: 'Analyze attribution quality across multiple models. Shows what percentage of Stripe revenue can be traced to campaigns, with credit distribution by model. Compare first-touch vs last-touch vs linear to understand the full customer journey.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days to analyze'
        },
        attribution_models: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['first_touch', 'last_touch', 'linear', 'time_decay', 'position_based', 'markov', 'shapley']
          },
          description: 'Attribution models to analyze. Omit for all models.'
        },
        breakdown_by: {
          type: 'string',
          enum: ['platform', 'channel', 'campaign', 'source_medium'],
          description: 'How to break down attribution credit'
        }
      },
      required: ['days']
    }
  },

  query_subscription_cohorts: {
    name: 'query_subscription_cohorts',
    description: 'Analyze subscription metrics: MRR, LTV, churn, and retention by acquisition channel or cohort month. Use to understand which ad campaigns drive the highest-value long-term customers vs one-time purchasers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          minimum: 30,
          maximum: 365,
          description: 'Lookback period for cohort analysis'
        },
        metric: {
          type: 'string',
          enum: ['mrr', 'ltv', 'churn_rate', 'retention', 'avg_subscription_value'],
          description: 'Primary metric to analyze'
        },
        breakdown_by: {
          type: 'string',
          enum: ['acquisition_channel', 'utm_source', 'utm_campaign', 'cohort_month', 'plan_interval'],
          description: 'How to break down the metric'
        },
        filters: {
          type: 'object',
          properties: {
            status: {
              type: 'array',
              items: { type: 'string', enum: ['active', 'trialing', 'past_due', 'canceled'] }
            },
            plan_interval: { type: 'string', enum: ['month', 'year'] },
            min_ltv_cents: { type: 'number' }
          },
          description: 'Filters for subscription data'
        }
      },
      required: ['days', 'metric']
    }
  },

  // Math tools - for accurate budget calculations
  calculate_budget_change: {
    name: 'calculate_budget_change',
    description: 'Calculate the exact new budget after applying a percentage change. ALWAYS use this before recommending budget changes to ensure accurate math. Returns the new budget in cents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        current_budget_cents: {
          type: 'number',
          description: 'Current budget in cents (e.g., 10000 for $100.00)'
        },
        percentage_change: {
          type: 'number',
          description: 'Percentage change to apply (e.g., 25 for +25%, -15 for -15%)'
        }
      },
      required: ['current_budget_cents', 'percentage_change']
    }
  },

  calculate_percentage_change: {
    name: 'calculate_percentage_change',
    description: 'Calculate the percentage change between two values. Use to understand how much a metric has changed over time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        old_value: {
          type: 'number',
          description: 'The original value'
        },
        new_value: {
          type: 'number',
          description: 'The new value'
        }
      },
      required: ['old_value', 'new_value']
    }
  },

  get_entity_budget: {
    name: 'get_entity_budget',
    description: 'Get the current budget configuration for a campaign or ad set. Use this BEFORE making budget recommendations to know the actual configured budget (not spend!).',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['campaign', 'adset', 'ad_group'],
          description: 'Type of entity (campaign, adset for Facebook, ad_group for Google/TikTok)'
        },
        entity_id: {
          type: 'string',
          description: 'The entity ID'
        }
      },
      required: ['platform', 'entity_type', 'entity_id']
    }
  }
};

/**
 * Get exploration tools formatted for Anthropic API
 */
export function getExplorationTools(): Array<{
  name: string;
  description: string;
  input_schema: object;
}> {
  return Object.values(EXPLORATION_TOOLS);
}

/**
 * Check if a tool name is an exploration tool
 */
export function isExplorationTool(name: string): boolean {
  return name in EXPLORATION_TOOLS;
}

// Type definitions for tool inputs
interface QueryMetricsInput {
  platform: string;
  entity_type: string;
  entity_id: string;
  metrics: string[];
  days: number;
  include_verified_revenue?: boolean;
}

interface CompareEntitiesInput {
  platform: string;
  entity_type: string;
  entity_ids: string[];
  metrics: string[];
  days: number;
}

interface GetCreativeDetailsInput {
  platform: string;
  ad_id: string;
}

interface GetAudienceBreakdownInput {
  platform: string;
  entity_type: string;
  entity_id: string;
  dimension: string;
  days: number;
}

interface MetadataFilter {
  source: 'charge' | 'product' | 'price' | 'customer';
  key: string;
  operator: 'equals' | 'contains' | 'starts_with' | 'not_equals';
  value: string;
}

interface QueryStripeRevenueInput {
  days: number;
  conversion_type?: 'all' | 'charges' | 'subscriptions' | 'subscription_initial' | 'subscription_renewal';
  group_by?: 'day' | 'week' | 'month';
  filters?: {
    status?: 'succeeded' | 'active' | 'trialing';
    min_amount_cents?: number;
    max_amount_cents?: number;
    currency?: string;
    product_id?: string;
  };
  metadata_filters?: MetadataFilter[];
  breakdown_by_metadata_key?: string;
}

interface CompareSpendToRevenueInput {
  days: number;
  platforms?: Array<'facebook' | 'google' | 'tiktok' | 'all'>;
  breakdown_by?: 'platform' | 'day' | 'campaign';
}

interface QueryAttributionQualityInput {
  days: number;
  attribution_models?: Array<'first_touch' | 'last_touch' | 'linear' | 'time_decay' | 'position_based' | 'markov' | 'shapley'>;
  breakdown_by?: 'platform' | 'channel' | 'campaign' | 'source_medium';
}

interface QuerySubscriptionCohortsInput {
  days: number;
  metric: 'mrr' | 'ltv' | 'churn_rate' | 'retention' | 'avg_subscription_value';
  breakdown_by?: 'acquisition_channel' | 'utm_source' | 'utm_campaign' | 'cohort_month' | 'plan_interval';
  filters?: {
    status?: Array<'active' | 'trialing' | 'past_due' | 'canceled'>;
    plan_interval?: 'month' | 'year';
    min_ltv_cents?: number;
  };
}

// Math tool interfaces
interface CalculateBudgetChangeInput {
  current_budget_cents: number;
  percentage_change: number;
}

interface CalculatePercentageChangeInput {
  old_value: number;
  new_value: number;
}

interface GetEntityBudgetInput {
  platform: string;
  entity_type: string;
  entity_id: string;
}

/**
 * Exploration Tool Executor
 */
export class ExplorationToolExecutor {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Execute an exploration tool and return results
   */
  async execute(
    toolName: string,
    input: Record<string, any>,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      switch (toolName) {
        case 'query_metrics':
          return await this.queryMetrics(input as QueryMetricsInput, orgId);
        case 'compare_entities':
          return await this.compareEntities(input as CompareEntitiesInput, orgId);
        case 'get_creative_details':
          return await this.getCreativeDetails(input as GetCreativeDetailsInput, orgId);
        case 'get_audience_breakdown':
          return await this.getAudienceBreakdown(input as GetAudienceBreakdownInput, orgId);
        case 'query_stripe_revenue':
          return await this.queryStripeRevenue(input as QueryStripeRevenueInput, orgId);
        case 'compare_spend_to_revenue':
          return await this.compareSpendToRevenue(input as CompareSpendToRevenueInput, orgId);
        case 'query_attribution_quality':
          return await this.queryAttributionQuality(input as QueryAttributionQualityInput, orgId);
        case 'query_subscription_cohorts':
          return await this.querySubscriptionCohorts(input as QuerySubscriptionCohortsInput, orgId);
        // Math tools
        case 'calculate_budget_change':
          return this.calculateBudgetChange(input as CalculateBudgetChangeInput);
        case 'calculate_percentage_change':
          return this.calculatePercentageChange(input as CalculatePercentageChangeInput);
        case 'get_entity_budget':
          return await this.getEntityBudget(input as GetEntityBudgetInput, orgId);
        default:
          return { success: false, error: `Unknown exploration tool: ${toolName}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Tool execution failed' };
    }
  }

  /**
   * Query metrics for a specific entity
   */
  private async queryMetrics(
    input: QueryMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id, metrics, days, include_verified_revenue } = input;

    const tableInfo = this.getMetricsTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform/entity for metrics: ${platform}/${entity_type}` };
    }

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    // Build query string for Supabase REST API
    const columns = ['metric_date', 'spend_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents'].join(',');
    const filters = `${tableInfo.idColumn}=eq.${entity_id}&organization_id=eq.${orgId}&metric_date=gte.${startStr}&metric_date=lte.${endStr}`;
    const endpoint = `${tableInfo.table}?select=${columns}&${filters}&order=metric_date.asc`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      // Enrich with derived metrics
      const enrichedData = this.enrichMetrics(data || [], metrics);
      const summary = this.summarizeMetrics(enrichedData);

      const response: any = {
        entity_id,
        entity_type,
        platform,
        days,
        time_series: enrichedData,
        summary
      };

      // Add verified revenue data if requested
      if (include_verified_revenue) {
        const verifiedMetrics = await this.getVerifiedRevenueForDateRange(orgId, startStr, endStr);
        const platformSpend = summary.total_spend
          ? parseFloat(summary.total_spend.replace('$', ''))
          : 0;

        response.verified_metrics = {
          stripe_revenue_cents: verifiedMetrics.revenue_cents,
          stripe_revenue: '$' + (verifiedMetrics.revenue_cents / 100).toFixed(2),
          stripe_conversions: verifiedMetrics.conversions,
          true_roas: platformSpend > 0
            ? ((verifiedMetrics.revenue_cents / 100) / platformSpend).toFixed(2)
            : '0',
          platform_vs_verified_delta: summary.total_conversion_value
            ? this.calculateDelta(
                parseFloat(summary.total_conversion_value.replace('$', '')),
                verifiedMetrics.revenue_cents / 100
              )
            : 'N/A'
        };
      }

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Get verified Stripe revenue for a date range
   */
  private async getVerifiedRevenueForDateRange(
    orgId: string,
    startStr: string,
    endStr: string
  ): Promise<{ revenue_cents: number; conversions: number }> {
    try {
      const query = `all_conversions?organization_id=eq.${orgId}&stripe_created_at=gte.${startStr}&stripe_created_at=lte.${endStr}&deleted_at=is.null&payment_status=in.(succeeded,active,trialing)`;
      const data = await this.supabase.queryWithSchema<any[]>(query, 'stripe');

      if (!data || data.length === 0) {
        return { revenue_cents: 0, conversions: 0 };
      }

      return {
        revenue_cents: data.reduce((sum, row) => sum + (row.amount_cents || 0), 0),
        conversions: data.length
      };
    } catch {
      return { revenue_cents: 0, conversions: 0 };
    }
  }

  /**
   * Calculate percentage delta between two values
   */
  private calculateDelta(platformValue: number, verifiedValue: number): string {
    if (platformValue === 0) return verifiedValue > 0 ? '+100%' : '0%';
    const delta = ((verifiedValue - platformValue) / platformValue) * 100;
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`;
  }

  /**
   * Compare multiple entities
   */
  private async compareEntities(
    input: CompareEntitiesInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_ids, metrics, days } = input;

    if (entity_ids.length > 5) {
      return { success: false, error: 'Maximum 5 entities can be compared' };
    }

    const tableInfo = this.getMetricsTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform/entity for metrics: ${platform}/${entity_type}` };
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const comparisons = await Promise.all(
      entity_ids.map(async (entityId) => {
        const columns = ['metric_date', 'spend_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents'].join(',');
        const filters = `${tableInfo.idColumn}=eq.${entityId}&organization_id=eq.${orgId}&metric_date=gte.${startStr}&metric_date=lte.${endStr}`;
        const endpoint = `${tableInfo.table}?select=${columns}&${filters}`;

        try {
          const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);
          const enrichedData = this.enrichMetrics(data || [], metrics);
          const summary = this.summarizeMetrics(enrichedData);

          return { entity_id: entityId, name: entityId, summary };
        } catch {
          return { entity_id: entityId, name: entityId, summary: { error: 'Query failed' } };
        }
      })
    );

    const rankings = this.rankEntities(comparisons, metrics);

    return {
      success: true,
      data: { platform, entity_type, days, comparisons, rankings }
    };
  }

  /**
   * Get creative details for an ad
   */
  private async getCreativeDetails(
    input: GetCreativeDetailsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, ad_id } = input;

    const tableInfo = this.getEntityTableInfo(platform, 'ad');
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform` };
    }

    const filters = `${tableInfo.idColumn}=eq.${ad_id}&organization_id=eq.${orgId}`;
    const endpoint = `${tableInfo.table}?${filters}&limit=1`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      if (!data || data.length === 0) {
        return { success: false, error: `Ad not found: ${ad_id}` };
      }

      const ad = data[0];
      const creativeInfo = this.extractCreativeInfo(ad, platform);

      return {
        success: true,
        data: {
          ad_id,
          platform,
          name: ad.name,
          status: ad.status,
          ...creativeInfo
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Get audience breakdown
   */
  private async getAudienceBreakdown(
    input: GetAudienceBreakdownInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id, dimension } = input;

    const tableInfo = this.getEntityTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: 'Unsupported platform/entity' };
    }

    const filters = `${tableInfo.idColumn}=eq.${entity_id}&organization_id=eq.${orgId}`;
    const endpoint = `${tableInfo.table}?select=name,targeting&${filters}&limit=1`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      if (!data || data.length === 0) {
        return { success: false, error: `Entity not found: ${entity_id}` };
      }

      const entity = data[0];
      const targeting = this.parseTargeting(entity.targeting);

      return {
        success: true,
        data: {
          entity_id,
          entity_type,
          platform,
          name: entity.name,
          dimension,
          targeting,
          note: 'Full breakdown by dimension requires platform-specific data which may not be synced.'
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Query Stripe revenue with metadata filtering
   */
  private async queryStripeRevenue(
    input: QueryStripeRevenueInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, conversion_type = 'all', group_by = 'day', filters, metadata_filters, breakdown_by_metadata_key } = input;

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // Query stripe.all_conversions view
      let query = `all_conversions?organization_id=eq.${orgId}&stripe_created_at=gte.${startStr}&stripe_created_at=lte.${endStr}&deleted_at=is.null`;

      // Filter by conversion type
      if (conversion_type === 'charges') {
        query += `&stripe_type=eq.charge`;
      } else if (conversion_type === 'subscriptions') {
        query += `&stripe_type=eq.subscription`;
      }

      // Apply basic filters
      if (filters?.status) {
        query += `&payment_status=eq.${filters.status}`;
      }
      if (filters?.min_amount_cents) {
        query += `&amount_cents=gte.${filters.min_amount_cents}`;
      }
      if (filters?.max_amount_cents) {
        query += `&amount_cents=lte.${filters.max_amount_cents}`;
      }
      if (filters?.currency) {
        query += `&currency=eq.${filters.currency}`;
      }

      const data = await this.supabase.queryWithSchema<any[]>(query, 'stripe');

      if (!data) {
        return { success: true, data: { time_series: [], summary: { total_revenue: '$0.00', total_transactions: 0 } } };
      }

      // Apply metadata filters in memory (JSONB filtering)
      let filteredData = data;
      if (metadata_filters && metadata_filters.length > 0) {
        filteredData = data.filter(row => {
          return metadata_filters.every(filter => {
            const metadataObj = row.metadata || {};
            const sourceKey = `${filter.source}_metadata`;
            const sourceData = metadataObj[sourceKey] || metadataObj;
            const value = sourceData[filter.key];

            if (value === undefined || value === null) return filter.operator === 'not_equals';

            const strValue = String(value).toLowerCase();
            const filterValue = filter.value.toLowerCase();

            switch (filter.operator) {
              case 'equals': return strValue === filterValue;
              case 'contains': return strValue.includes(filterValue);
              case 'starts_with': return strValue.startsWith(filterValue);
              case 'not_equals': return strValue !== filterValue;
              default: return true;
            }
          });
        });
      }

      // Group by time period
      const grouped = this.groupByTimePeriod(filteredData, group_by);

      // Calculate summary
      const totalRevenue = filteredData.reduce((sum, row) => sum + (row.amount_cents || 0), 0);
      const uniqueCustomers = new Set(filteredData.map(row => row.customer_id).filter(Boolean)).size;

      // Build response
      const response: any = {
        time_series: grouped.map(g => ({
          date: g.date,
          revenue_cents: g.revenue_cents,
          revenue: '$' + (g.revenue_cents / 100).toFixed(2),
          transactions: g.count,
          unique_customers: g.unique_customers
        })),
        summary: {
          total_revenue: '$' + (totalRevenue / 100).toFixed(2),
          total_transactions: filteredData.length,
          unique_customers: uniqueCustomers,
          avg_order_value: filteredData.length > 0
            ? '$' + ((totalRevenue / 100) / filteredData.length).toFixed(2)
            : '$0.00'
        }
      };

      // Add metadata breakdown if requested
      if (breakdown_by_metadata_key) {
        response.by_metadata = this.breakdownByMetadata(filteredData, breakdown_by_metadata_key);
      }

      // Add available metadata keys
      response.metadata_keys_available = this.extractMetadataKeys(filteredData);

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Compare ad platform spend to actual Stripe revenue
   */
  private async compareSpendToRevenue(
    input: CompareSpendToRevenueInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platforms = ['all'], breakdown_by = 'platform' } = input;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // Determine which platforms to query
      const platformsToQuery = platforms.includes('all')
        ? ['facebook', 'google', 'tiktok']
        : platforms.filter(p => p !== 'all');

      // Fetch ad platform spend and conversions
      const platformData = await Promise.all(
        platformsToQuery.map(async (platform) => {
          const tableInfo = this.getMetricsTableInfo(platform, 'campaign');
          if (!tableInfo) return { platform, spend_cents: 0, platform_conversions: 0, platform_conversion_value_cents: 0 };

          const query = `${tableInfo.table}?select=spend_cents,conversions,conversion_value_cents&organization_id=eq.${orgId}&metric_date=gte.${startStr}&metric_date=lte.${endStr}`;
          const data = await this.supabase.queryWithSchema<any[]>(query, tableInfo.schema);

          const totals = (data || []).reduce((acc, row) => ({
            spend_cents: acc.spend_cents + (row.spend_cents || 0),
            platform_conversions: acc.platform_conversions + (row.conversions || 0),
            platform_conversion_value_cents: acc.platform_conversion_value_cents + (row.conversion_value_cents || 0)
          }), { spend_cents: 0, platform_conversions: 0, platform_conversion_value_cents: 0 });

          return { platform, ...totals };
        })
      );

      // Fetch verified Stripe revenue
      const stripeQuery = `all_conversions?organization_id=eq.${orgId}&stripe_created_at=gte.${startStr}&stripe_created_at=lte.${endStr}&deleted_at=is.null&payment_status=in.(succeeded,active,trialing)`;
      const stripeData = await this.supabase.queryWithSchema<any[]>(stripeQuery, 'stripe');

      const verifiedRevenue = (stripeData || []).reduce((sum, row) => sum + (row.amount_cents || 0), 0);
      const verifiedConversions = (stripeData || []).length;

      // Calculate totals
      const totalSpend = platformData.reduce((sum, p) => sum + p.spend_cents, 0);
      const totalPlatformConversions = platformData.reduce((sum, p) => sum + p.platform_conversions, 0);
      const totalPlatformRevenue = platformData.reduce((sum, p) => sum + p.platform_conversion_value_cents, 0);

      const platformRoas = totalSpend > 0 ? totalPlatformRevenue / totalSpend : 0;
      const trueRoas = totalSpend > 0 ? verifiedRevenue / totalSpend : 0;
      const discrepancyPct = totalPlatformRevenue > 0
        ? ((verifiedRevenue - totalPlatformRevenue) / totalPlatformRevenue * 100).toFixed(1)
        : '0';

      const response: any = {
        summary: {
          total_spend: '$' + (totalSpend / 100).toFixed(2),
          platform_reported_revenue: '$' + (totalPlatformRevenue / 100).toFixed(2),
          verified_stripe_revenue: '$' + (verifiedRevenue / 100).toFixed(2),
          platform_conversions: totalPlatformConversions,
          verified_conversions: verifiedConversions,
          platform_roas: platformRoas.toFixed(2),
          true_roas: trueRoas.toFixed(2),
          discrepancy_pct: discrepancyPct + '%'
        }
      };

      // Add platform breakdown
      if (breakdown_by === 'platform') {
        response.by_platform = platformData.map(p => ({
          platform: p.platform,
          spend: '$' + (p.spend_cents / 100).toFixed(2),
          platform_conversions: p.platform_conversions,
          platform_revenue: '$' + (p.platform_conversion_value_cents / 100).toFixed(2),
          platform_roas: p.spend_cents > 0 ? (p.platform_conversion_value_cents / p.spend_cents).toFixed(2) : '0'
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Query attribution quality across multiple models
   */
  private async queryAttributionQuality(
    input: QueryAttributionQualityInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, attribution_models, breakdown_by = 'platform' } = input;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // Query conversions with attribution data
      const conversionsQuery = `conversions?organization_id=eq.${orgId}&conversion_timestamp=gte.${startStr}&conversion_timestamp=lte.${endStr}&source_platform=eq.stripe`;
      const conversions = await this.supabase.queryWithSchema<any[]>(conversionsQuery, 'conversions');

      if (!conversions || conversions.length === 0) {
        return {
          success: true,
          data: {
            summary: { total_stripe_revenue: '$0.00', attributed_revenue: '$0.00', attribution_rate: '0%' },
            by_model: {},
            platform_match_rates: []
          }
        };
      }

      // Calculate totals
      const totalRevenue = conversions.reduce((sum, c) => sum + (c.revenue_cents || 0), 0);
      const attributed = conversions.filter(c => c.attributed_click_id || c.first_touch_anonymous_id);
      const attributedRevenue = attributed.reduce((sum, c) => sum + (c.revenue_cents || 0), 0);

      // Calculate attribution rate
      const attributionRate = totalRevenue > 0 ? (attributedRevenue / totalRevenue * 100).toFixed(1) : '0';

      // Analyze by attribution model
      const modelsToAnalyze = attribution_models || ['first_touch', 'last_touch', 'linear'];
      const byModel: Record<string, Record<string, { credit: string; pct: string }>> = {};

      for (const model of modelsToAnalyze) {
        byModel[model] = this.calculateAttributionByModel(conversions, model, breakdown_by);
      }

      // Calculate platform match rates
      const platformMatchRates = this.calculatePlatformMatchRates(conversions);

      // Build unattributed breakdown
      const unattributed = conversions.filter(c => !c.attributed_click_id && !c.first_touch_anonymous_id);
      const unattributedBreakdown = {
        no_click_id: unattributed.filter(c => !c.attributed_click_id).length,
        no_touchpoint: unattributed.filter(c => !c.first_touch_anonymous_id).length,
        total_unattributed: unattributed.length
      };

      return {
        success: true,
        data: {
          summary: {
            total_stripe_revenue: '$' + (totalRevenue / 100).toFixed(2),
            attributed_revenue: '$' + (attributedRevenue / 100).toFixed(2),
            unattributed_revenue: '$' + ((totalRevenue - attributedRevenue) / 100).toFixed(2),
            attribution_rate: attributionRate + '%',
            total_conversions: conversions.length,
            attributed_conversions: attributed.length
          },
          by_model: byModel,
          platform_match_rates: platformMatchRates,
          unattributed_breakdown: unattributedBreakdown
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Query subscription cohort metrics (MRR, LTV, churn, retention)
   */
  private async querySubscriptionCohorts(
    input: QuerySubscriptionCohortsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, metric, breakdown_by, filters } = input;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Query subscriptions
      let query = `subscriptions?organization_id=eq.${orgId}&deleted_at=is.null`;

      // Apply status filters
      if (filters?.status && filters.status.length > 0) {
        query += `&status=in.(${filters.status.join(',')})`;
      }

      // Apply interval filter
      if (filters?.plan_interval) {
        query += `&interval=eq.${filters.plan_interval}`;
      }

      const subscriptions = await this.supabase.queryWithSchema<any[]>(query, 'stripe');

      if (!subscriptions || subscriptions.length === 0) {
        return {
          success: true,
          data: {
            summary: { total_mrr: '$0.00', active_subscriptions: 0 },
            by_breakdown: []
          }
        };
      }

      // Calculate core subscription metrics
      const activeSubscriptions = subscriptions.filter(s =>
        ['active', 'trialing', 'past_due'].includes(s.status)
      );

      // Calculate MRR (normalize to monthly)
      const totalMrr = activeSubscriptions.reduce((sum, s) => {
        const amount = s.amount_cents || 0;
        const interval = s.interval || 'month';
        const intervalCount = s.interval_count || 1;

        // Normalize to monthly
        if (interval === 'year') {
          return sum + (amount / 12);
        } else if (interval === 'month') {
          return sum + (amount / intervalCount);
        }
        return sum + amount;
      }, 0);

      // Calculate average subscription age
      const now = new Date();
      const avgAgeDays = activeSubscriptions.reduce((sum, s) => {
        const created = new Date(s.stripe_created_at);
        const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
        return sum + ageDays;
      }, 0) / (activeSubscriptions.length || 1);

      // Calculate churn rate (canceled in last 30 days / active at start)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentlyCanceled = subscriptions.filter(s =>
        s.status === 'canceled' &&
        new Date(s.updated_at) > thirtyDaysAgo
      ).length;
      const churnRate = activeSubscriptions.length > 0
        ? (recentlyCanceled / (activeSubscriptions.length + recentlyCanceled) * 100)
        : 0;

      // Estimate LTV (MRR / churn rate, simplified)
      const avgLtv = churnRate > 0
        ? (totalMrr / activeSubscriptions.length) / (churnRate / 100)
        : (totalMrr / (activeSubscriptions.length || 1)) * 12; // Default to 12 months

      const summary = {
        total_mrr: '$' + (totalMrr / 100).toFixed(2),
        total_arr: '$' + (totalMrr * 12 / 100).toFixed(2),
        active_subscriptions: activeSubscriptions.length,
        avg_ltv: '$' + (avgLtv / 100).toFixed(2),
        monthly_churn_rate: churnRate.toFixed(1) + '%',
        avg_subscription_age_days: Math.round(avgAgeDays)
      };

      // Build breakdown based on requested dimension
      const breakdownData = this.buildSubscriptionBreakdown(subscriptions, breakdown_by, metric);

      // Build retention curve (simplified)
      const retentionCurve = this.calculateRetentionCurve(subscriptions);

      return {
        success: true,
        data: {
          summary,
          [`by_${breakdown_by || 'cohort_month'}`]: breakdownData,
          retention_curve: retentionCurve
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  // Math tools implementation

  /**
   * Calculate new budget after applying a percentage change
   */
  private calculateBudgetChange(
    input: CalculateBudgetChangeInput
  ): { success: boolean; data?: any; error?: string } {
    const { current_budget_cents, percentage_change } = input;

    if (current_budget_cents < 0) {
      return { success: false, error: 'current_budget_cents cannot be negative' };
    }

    if (current_budget_cents === 0 && percentage_change !== 0) {
      return {
        success: true,
        data: {
          current_budget_cents: 0,
          percentage_change,
          new_budget_cents: 0,
          current_budget: '$0.00',
          new_budget: '$0.00',
          change_amount: '$0.00',
          warning: 'Cannot apply percentage change to $0 budget. The result is still $0.',
          suggestion: 'If you want to set a budget, use a specific amount rather than a percentage change.'
        }
      };
    }

    const multiplier = 1 + (percentage_change / 100);
    const new_budget_cents = Math.round(current_budget_cents * multiplier);
    const change_amount_cents = new_budget_cents - current_budget_cents;

    return {
      success: true,
      data: {
        current_budget_cents,
        percentage_change,
        new_budget_cents,
        change_amount_cents,
        current_budget: '$' + (current_budget_cents / 100).toFixed(2),
        new_budget: '$' + (new_budget_cents / 100).toFixed(2),
        change_amount: (change_amount_cents >= 0 ? '+$' : '-$') + Math.abs(change_amount_cents / 100).toFixed(2),
        summary: `${percentage_change >= 0 ? '+' : ''}${percentage_change}% change: $${(current_budget_cents / 100).toFixed(2)} → $${(new_budget_cents / 100).toFixed(2)}`
      }
    };
  }

  /**
   * Calculate percentage change between two values
   */
  private calculatePercentageChange(
    input: CalculatePercentageChangeInput
  ): { success: boolean; data?: any; error?: string } {
    const { old_value, new_value } = input;

    if (old_value === 0) {
      if (new_value === 0) {
        return {
          success: true,
          data: {
            old_value: 0,
            new_value: 0,
            percentage_change: 0,
            summary: 'No change (0 → 0)'
          }
        };
      }
      return {
        success: true,
        data: {
          old_value: 0,
          new_value,
          percentage_change: null,
          summary: 'Cannot calculate percentage change from zero',
          note: 'Division by zero - old_value is 0'
        }
      };
    }

    const percentage_change = ((new_value - old_value) / old_value) * 100;
    const rounded = Math.round(percentage_change * 100) / 100; // Round to 2 decimals

    return {
      success: true,
      data: {
        old_value,
        new_value,
        absolute_change: new_value - old_value,
        percentage_change: rounded,
        summary: `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}% change: ${old_value} → ${new_value}`
      }
    };
  }

  /**
   * Get current budget for an entity from platform tables
   */
  private async getEntityBudget(
    input: GetEntityBudgetInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id } = input;

    // Normalize entity_type - accept both 'adset' and 'ad_set' for Facebook
    const normalizedEntityType = entity_type === 'ad_set' ? 'adset' : entity_type;

    const tableInfo = this.getEntityTableInfo(platform, normalizedEntityType);
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform/entity for budget: ${platform}/${entity_type}` };
    }

    // Build columns based on platform
    let budgetColumns: string;
    if (platform === 'google') {
      budgetColumns = 'campaign_id,name,status,budget_amount_cents,budget_type';
    } else if (platform === 'facebook') {
      if (normalizedEntityType === 'campaign') {
        budgetColumns = 'campaign_id,name,status,daily_budget_cents,lifetime_budget_cents';
      } else {
        budgetColumns = 'ad_set_id,name,status,daily_budget_cents,lifetime_budget_cents,budget_remaining_cents';
      }
    } else if (platform === 'tiktok') {
      if (normalizedEntityType === 'campaign') {
        budgetColumns = 'campaign_id,campaign_name,status,budget_cents,budget_mode';
      } else {
        budgetColumns = 'ad_group_id,ad_group_name,status,budget_cents';
      }
    } else {
      return { success: false, error: `Unknown platform: ${platform}` };
    }

    const filters = `${tableInfo.idColumn}=eq.${entity_id}&organization_id=eq.${orgId}`;
    const endpoint = `${tableInfo.table}?select=${budgetColumns}&${filters}&limit=1`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      if (!data || data.length === 0) {
        return { success: false, error: `Entity not found: ${entity_id}` };
      }

      const entity = data[0];

      // Normalize budget response
      let budget_cents: number | null = null;
      let budget_type: 'daily' | 'lifetime' | null = null;

      if (platform === 'google') {
        budget_cents = entity.budget_amount_cents;
        budget_type = entity.budget_type === 'DAILY' ? 'daily' : 'lifetime';
      } else if (platform === 'facebook') {
        // Facebook: prefer daily, fallback to lifetime
        if (entity.daily_budget_cents && entity.daily_budget_cents > 0) {
          budget_cents = entity.daily_budget_cents;
          budget_type = 'daily';
        } else if (entity.lifetime_budget_cents && entity.lifetime_budget_cents > 0) {
          budget_cents = entity.lifetime_budget_cents;
          budget_type = 'lifetime';
        }
      } else if (platform === 'tiktok') {
        budget_cents = entity.budget_cents;
        budget_type = entity.budget_mode === 'BUDGET_MODE_DAY' ? 'daily' : 'lifetime';
      }

      const name = entity.name || entity.campaign_name || entity.ad_group_name;

      return {
        success: true,
        data: {
          entity_id,
          entity_type: normalizedEntityType,
          platform,
          name,
          status: entity.status,
          budget_cents,
          budget: budget_cents ? '$' + (budget_cents / 100).toFixed(2) : null,
          budget_type,
          // Platform-specific raw data
          raw_budget_data: platform === 'facebook' ? {
            daily_budget_cents: entity.daily_budget_cents,
            lifetime_budget_cents: entity.lifetime_budget_cents,
            budget_remaining_cents: entity.budget_remaining_cents
          } : undefined,
          // Helper for recommendations
          recommendation_hint: budget_cents === null || budget_cents === 0
            ? 'WARNING: No budget set or budget is $0. Cannot calculate percentage-based changes on zero budget.'
            : `Current ${budget_type} budget is $${(budget_cents / 100).toFixed(2)}. Use calculate_budget_change to compute new budget.`
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  // Helper methods

  /**
   * Get METRICS table info (for queryMetrics, compareEntities)
   * These tables have daily performance data with metric_date column
   */
  private getMetricsTableInfo(platform: string, entityType: string): { table: string; idColumn: string; schema: string } | null {
    const tables: Record<string, Record<string, { table: string; idColumn: string; schema: string }>> = {
      facebook: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'facebook_ads' },
        adset: { table: 'ad_set_daily_metrics', idColumn: 'ad_set_ref', schema: 'facebook_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'facebook_ads' }
      },
      google: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'google_ads' },
        adset: { table: 'ad_group_daily_metrics', idColumn: 'ad_group_ref', schema: 'google_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'google_ads' }
      },
      tiktok: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'tiktok_ads' },
        adset: { table: 'ad_group_daily_metrics', idColumn: 'ad_group_ref', schema: 'tiktok_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'tiktok_ads' }
      }
    };

    return tables[platform]?.[entityType] || null;
  }

  /**
   * Get ENTITY table info (for getCreativeDetails, getAudienceBreakdown)
   * These tables have entity metadata like name, status, targeting
   */
  private getEntityTableInfo(platform: string, entityType: string): { table: string; idColumn: string; schema: string } | null {
    const tables: Record<string, Record<string, { table: string; idColumn: string; schema: string }>> = {
      facebook: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'facebook_ads' },
        adset: { table: 'ad_sets', idColumn: 'ad_set_id', schema: 'facebook_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'facebook_ads' },
        account: { table: 'accounts', idColumn: 'account_id', schema: 'facebook_ads' }
      },
      google: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'google_ads' },
        adset: { table: 'ad_groups', idColumn: 'ad_group_id', schema: 'google_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'google_ads' },
        account: { table: 'accounts', idColumn: 'customer_id', schema: 'google_ads' }
      },
      tiktok: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'tiktok_ads' },
        adset: { table: 'ad_groups', idColumn: 'ad_group_id', schema: 'tiktok_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'tiktok_ads' },
        account: { table: 'advertisers', idColumn: 'advertiser_id', schema: 'tiktok_ads' }
      }
    };

    return tables[platform]?.[entityType] || null;
  }

  private enrichMetrics(data: any[], requestedMetrics: string[]): any[] {
    return data.map(row => {
      const enriched = { ...row };
      const spend = row.spend_cents || 0;
      const impressions = row.impressions || 0;
      const clicks = row.clicks || 0;
      const conversions = row.conversions || 0;
      const conversionValue = row.conversion_value_cents || 0;

      if (requestedMetrics.includes('ctr') && impressions > 0) {
        enriched.ctr = ((clicks / impressions) * 100).toFixed(2) + '%';
      }
      if (requestedMetrics.includes('cpc') && clicks > 0) {
        enriched.cpc = '$' + ((spend / 100) / clicks).toFixed(2);
      }
      if (requestedMetrics.includes('cpm') && impressions > 0) {
        enriched.cpm = '$' + (((spend / 100) / impressions) * 1000).toFixed(2);
      }
      if (requestedMetrics.includes('roas') && spend > 0) {
        enriched.roas = (conversionValue / spend).toFixed(2);
      }
      if (requestedMetrics.includes('cpa') && conversions > 0) {
        enriched.cpa = '$' + ((spend / 100) / conversions).toFixed(2);
      }

      if ('spend_cents' in enriched) {
        enriched.spend = '$' + (enriched.spend_cents / 100).toFixed(2);
        delete enriched.spend_cents;
      }
      if ('conversion_value_cents' in enriched) {
        enriched.conversion_value = '$' + (enriched.conversion_value_cents / 100).toFixed(2);
        delete enriched.conversion_value_cents;
      }

      return enriched;
    });
  }

  private summarizeMetrics(data: any[]): Record<string, any> {
    if (data.length === 0) return { days_with_data: 0 };

    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    let totalConversionValue = 0;

    for (const row of data) {
      totalSpend += parseFloat(row.spend?.replace('$', '') || '0');
      totalImpressions += row.impressions || 0;
      totalClicks += row.clicks || 0;
      totalConversions += row.conversions || 0;
      totalConversionValue += parseFloat(row.conversion_value?.replace('$', '') || '0');
    }

    const summary: Record<string, any> = {
      days_with_data: data.length,
      total_spend: '$' + totalSpend.toFixed(2),
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      total_conversions: totalConversions,
      total_conversion_value: '$' + totalConversionValue.toFixed(2)
    };

    if (totalImpressions > 0) {
      summary.avg_ctr = ((totalClicks / totalImpressions) * 100).toFixed(2) + '%';
    }
    if (totalClicks > 0) {
      summary.avg_cpc = '$' + (totalSpend / totalClicks).toFixed(2);
    }
    if (totalConversions > 0) {
      summary.avg_cpa = '$' + (totalSpend / totalConversions).toFixed(2);
    }
    if (totalSpend > 0) {
      summary.roas = (totalConversionValue / totalSpend).toFixed(2);
    }

    return summary;
  }

  private rankEntities(
    comparisons: Array<{ entity_id: string; name: string; summary: Record<string, any> }>,
    metrics: string[]
  ): Record<string, Array<{ entity_id: string; name: string; value: string }>> {
    const rankings: Record<string, Array<{ entity_id: string; name: string; value: string }>> = {};

    if (metrics.includes('roas')) {
      rankings.by_roas = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.roas || '0' }))
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    }

    if (metrics.includes('cpa')) {
      rankings.by_cpa = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.avg_cpa || '$0' }))
        .sort((a, b) => parseFloat(a.value.replace('$', '')) - parseFloat(b.value.replace('$', '')));
    }

    if (metrics.includes('ctr')) {
      rankings.by_ctr = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.avg_ctr || '0%' }))
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    }

    return rankings;
  }

  private extractCreativeInfo(ad: any, platform: string): Record<string, any> {
    const info: Record<string, any> = {};

    if (platform === 'facebook') {
      info.creative_type = ad.creative_type || 'unknown';
      info.headline = ad.headline;
      info.body = ad.body;
      info.call_to_action = ad.call_to_action;
      info.image_url = ad.image_url;
      info.video_url = ad.video_url;
    } else if (platform === 'google') {
      info.ad_type = ad.type || 'unknown';
      info.headlines = ad.headlines;
      info.descriptions = ad.descriptions;
      info.final_urls = ad.final_urls;
    } else if (platform === 'tiktok') {
      info.ad_format = ad.ad_format || 'unknown';
      info.ad_text = ad.ad_text;
      info.video_id = ad.video_id;
      info.call_to_action = ad.call_to_action;
    }

    return info;
  }

  private parseTargeting(targeting: any): Record<string, any> {
    if (!targeting) return { raw: null };

    try {
      return typeof targeting === 'string' ? JSON.parse(targeting) : targeting;
    } catch {
      return { raw: targeting };
    }
  }

  // New helper methods for Stripe/attribution tools

  private groupByTimePeriod(
    data: any[],
    groupBy: string
  ): Array<{ date: string; revenue_cents: number; count: number; unique_customers: number }> {
    const grouped = new Map<string, { revenue_cents: number; count: number; customers: Set<string> }>();

    for (const row of data) {
      const timestamp = row.stripe_created_at || row.created_at;
      if (!timestamp) continue;

      const date = new Date(timestamp);
      let key: string;

      if (groupBy === 'week') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else if (groupBy === 'month') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      } else {
        key = date.toISOString().split('T')[0];
      }

      if (!grouped.has(key)) {
        grouped.set(key, { revenue_cents: 0, count: 0, customers: new Set() });
      }

      const entry = grouped.get(key)!;
      entry.revenue_cents += row.amount_cents || 0;
      entry.count += 1;
      if (row.customer_id) entry.customers.add(row.customer_id);
    }

    return Array.from(grouped.entries())
      .map(([date, { revenue_cents, count, customers }]) => ({
        date,
        revenue_cents,
        count,
        unique_customers: customers.size
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private breakdownByMetadata(
    data: any[],
    metadataKey: string
  ): Record<string, { revenue: string; transactions: number }> {
    const breakdown: Record<string, { revenue_cents: number; count: number }> = {};

    for (const row of data) {
      const metadata = row.metadata || {};
      // Check multiple possible locations for the metadata key
      const value = metadata[metadataKey]
        || metadata.charge_metadata?.[metadataKey]
        || metadata.customer_metadata?.[metadataKey]
        || 'unknown';

      const key = String(value);
      if (!breakdown[key]) {
        breakdown[key] = { revenue_cents: 0, count: 0 };
      }
      breakdown[key].revenue_cents += row.amount_cents || 0;
      breakdown[key].count += 1;
    }

    const result: Record<string, { revenue: string; transactions: number }> = {};
    for (const [key, { revenue_cents, count }] of Object.entries(breakdown)) {
      result[key] = {
        revenue: '$' + (revenue_cents / 100).toFixed(2),
        transactions: count
      };
    }
    return result;
  }

  private extractMetadataKeys(data: any[]): string[] {
    const keys = new Set<string>();

    for (const row of data) {
      const metadata = row.metadata || {};
      // Extract top-level keys
      Object.keys(metadata).forEach(k => keys.add(k));
      // Extract nested keys from common metadata sources
      if (metadata.charge_metadata) Object.keys(metadata.charge_metadata).forEach(k => keys.add(k));
      if (metadata.customer_metadata) Object.keys(metadata.customer_metadata).forEach(k => keys.add(k));
    }

    return Array.from(keys).slice(0, 20); // Limit to 20 keys
  }

  private calculateAttributionByModel(
    conversions: any[],
    model: string,
    breakdownBy: string
  ): Record<string, { credit: string; pct: string }> {
    const result: Record<string, number> = {};
    let totalCredit = 0;

    for (const conversion of conversions) {
      const revenue = conversion.revenue_cents || 0;

      // Determine the attribution source based on model
      let source: string;
      if (model === 'first_touch') {
        source = this.getSourceFromConversion(conversion, 'first', breakdownBy);
      } else if (model === 'last_touch') {
        source = this.getSourceFromConversion(conversion, 'last', breakdownBy);
      } else {
        // For linear and other models, use last touch as fallback
        source = this.getSourceFromConversion(conversion, 'last', breakdownBy);
      }

      if (!result[source]) result[source] = 0;
      result[source] += revenue;
      totalCredit += revenue;
    }

    const formatted: Record<string, { credit: string; pct: string }> = {};
    for (const [source, credit] of Object.entries(result)) {
      formatted[source] = {
        credit: '$' + (credit / 100).toFixed(2),
        pct: totalCredit > 0 ? ((credit / totalCredit) * 100).toFixed(1) + '%' : '0%'
      };
    }
    return formatted;
  }

  private getSourceFromConversion(conversion: any, touchType: 'first' | 'last', breakdownBy: string): string {
    const prefix = touchType === 'first' ? 'first_touch' : 'last_touch';

    switch (breakdownBy) {
      case 'platform':
        // Infer platform from click ID type
        const clickId = conversion.attributed_click_id || '';
        if (clickId.startsWith('gclid') || conversion.attributed_click_id_type === 'gclid') return 'google_paid';
        if (clickId.startsWith('fbclid') || conversion.attributed_click_id_type === 'fbclid') return 'facebook_paid';
        if (clickId.startsWith('ttclid') || conversion.attributed_click_id_type === 'ttclid') return 'tiktok_paid';
        return conversion.platform_claimed_source || 'unknown';

      case 'channel':
        return conversion.utm_medium || 'direct';

      case 'campaign':
        return conversion.utm_campaign || conversion.platform_claimed_campaign || 'unknown';

      case 'source_medium':
        const source = conversion.utm_source || 'direct';
        const medium = conversion.utm_medium || 'none';
        return `${source} / ${medium}`;

      default:
        return conversion.utm_source || 'unknown';
    }
  }

  private calculatePlatformMatchRates(conversions: any[]): Array<{
    platform: string;
    click_id: string;
    matched: number;
    total: number;
    match_rate: string;
  }> {
    const platforms = [
      { platform: 'google', click_id: 'gclid' },
      { platform: 'facebook', click_id: 'fbclid' },
      { platform: 'tiktok', click_id: 'ttclid' }
    ];

    return platforms.map(({ platform, click_id }) => {
      const withClickId = conversions.filter(c =>
        c.attributed_click_id_type === click_id || c.attributed_click_id?.includes(click_id)
      );
      const total = conversions.length;
      const matched = withClickId.length;

      return {
        platform,
        click_id,
        matched,
        total,
        match_rate: total > 0 ? ((matched / total) * 100).toFixed(1) + '%' : '0%'
      };
    });
  }

  private buildSubscriptionBreakdown(
    subscriptions: any[],
    breakdownBy: string | undefined,
    metric: string
  ): any[] {
    if (!breakdownBy) return [];

    const groups = new Map<string, any[]>();

    for (const sub of subscriptions) {
      let key: string;

      switch (breakdownBy) {
        case 'cohort_month':
          const created = new Date(sub.stripe_created_at);
          key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
          break;
        case 'plan_interval':
          key = sub.interval || 'unknown';
          break;
        case 'utm_source':
        case 'utm_campaign':
        case 'acquisition_channel':
          // These would require joining with customer_identities
          key = sub.metadata?.[breakdownBy] || 'unknown';
          break;
        default:
          key = 'unknown';
      }

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(sub);
    }

    return Array.from(groups.entries()).map(([key, subs]) => {
      const active = subs.filter(s => ['active', 'trialing', 'past_due'].includes(s.status));
      const mrr = active.reduce((sum, s) => {
        const amount = s.amount_cents || 0;
        const interval = s.interval || 'month';
        return sum + (interval === 'year' ? amount / 12 : amount);
      }, 0);

      return {
        [breakdownBy]: key,
        subscriptions: subs.length,
        active_subscriptions: active.length,
        mrr: '$' + (mrr / 100).toFixed(2)
      };
    });
  }

  private calculateRetentionCurve(subscriptions: any[]): Record<string, string> {
    const now = new Date();
    const activeCount = subscriptions.filter(s =>
      ['active', 'trialing', 'past_due'].includes(s.status)
    ).length;
    const totalEver = subscriptions.length;

    if (totalEver === 0) return {};

    // Calculate retention at different time periods
    const retentionAtMonths = [1, 3, 6, 12];
    const curve: Record<string, string> = {};

    for (const months of retentionAtMonths) {
      const cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - months);

      const startedBeforeCutoff = subscriptions.filter(s =>
        new Date(s.stripe_created_at) < cutoff
      );

      if (startedBeforeCutoff.length === 0) continue;

      const stillActive = startedBeforeCutoff.filter(s =>
        ['active', 'trialing', 'past_due'].includes(s.status)
      ).length;

      curve[`month_${months}`] = ((stillActive / startedBeforeCutoff.length) * 100).toFixed(0) + '%';
    }

    return curve;
  }
}
