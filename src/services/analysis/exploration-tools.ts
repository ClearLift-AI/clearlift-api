/**
 * Exploration Tools
 *
 * Read-only tools for the agentic loop to investigate data before making recommendations.
 * These tools have no caps (unlike recommendation tools) and allow the AI to:
 * - Query metrics for specific entities
 * - Compare multiple entities side-by-side
 * - Get creative details
 * - Get audience/targeting breakdowns
 *
 * Uses D1 ANALYTICS_DB for metrics queries
 */

// D1Database type from Cloudflare Workers (matches worker-configuration.d.ts)
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta?: {
    changed_db: boolean;
    changes: number;
    last_row_id: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

interface D1ExecResult {
  count: number;
  duration: number;
}

// Tool definitions for Anthropic API
export const EXPLORATION_TOOLS = {
  query_ad_metrics: {
    name: 'query_ad_metrics',
    description: 'Query ad platform data from D1. REQUIRED: platform (google/facebook/tiktok) and entity_type (campaign/adset/ad/ad_group) for all scopes except account-level. entity_id is REQUIRED for non-account queries — use the UUID from earlier query results, NOT campaign names. Scopes: "performance" — metrics for a specific entity; "creatives" — ad creative details; "audiences" — targeting breakdown by dimension; "budgets" — current budget config. Do NOT use entity_type "account" with budgets scope.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['performance', 'creatives', 'audiences', 'budgets'],
          description: 'Which ad metrics operation to perform'
        },
        platform: {
          type: 'string',
          description: 'The ad platform (google, facebook, tiktok, linkedin, microsoft, pinterest, snapchat, twitter, etc.)'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign', 'account', 'ad_group'],
          description: 'Type of entity to query. For "performance": ad/adset/campaign/account. For "audiences": adset/campaign. For "budgets": campaign/adset/ad_group.'
        },
        entity_id: {
          type: 'string',
          description: 'REQUIRED for non-account queries. The entity UUID from D1 (e.g. "3f857a38-..."). Use IDs returned by previous queries — do NOT pass campaign names here.'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "performance" scope: metrics to retrieve (spend, impressions, clicks, conversions, ctr, cpc, cpm, roas, cpa)'
        },
        days: {
          type: 'number',
          description: 'Number of days of historical data (1-90)',
          minimum: 1,
          maximum: 90
        },
        include_verified_revenue: {
          type: 'boolean',
          description: 'For "performance" scope: include Stripe-verified revenue data'
        },
        ad_id: {
          type: 'string',
          description: 'For "creatives" scope: the ad ID to get creative details for'
        },
        dimension: {
          type: 'string',
          enum: ['age', 'gender', 'placement', 'device', 'geo'],
          description: 'For "audiences" scope: breakdown dimension'
        }
      },
      required: ['scope', 'platform']
    }
  },

  query_revenue: {
    name: 'query_revenue',
    description: 'Query revenue data from connected platforms (all via connector_events in ANALYTICS_DB). Scopes: "stripe" — Stripe payments with metadata filtering; "jobber" — Jobber completed jobs for field service; "shopify" — Shopify orders with UTM attribution and product breakdown; "ecommerce" — unified e-commerce data across platforms; "subscriptions" — MRR, LTV, churn, retention cohort analysis; "accounting" — invoices, expenses, P&L from QuickBooks/Xero. Common params: days, group_by. For "stripe": conversion_type, filters, metadata_filters, breakdown_by_metadata_key. For "shopify": filters (financial_status, fulfillment_status, etc.), include_products, include_attribution. For "ecommerce": platform, include_products, include_customers. For "subscriptions": metric (required), breakdown_by, filters. For "accounting": platform, data_type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['stripe', 'jobber', 'shopify', 'ecommerce', 'subscriptions', 'accounting'],
          description: 'Which revenue source to query'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          description: 'Number of days of historical data'
        },
        group_by: {
          type: 'string',
          description: 'Time/dimension grouping. For stripe/jobber: day/week/month. For shopify: day/week/month/utm_source/utm_campaign/source_name/shipping_country. For ecommerce: day/platform/status/utm_source/utm_campaign. For accounting: day/month/status/category.'
        },
        platform: {
          type: 'string',
          description: 'For "ecommerce"/"accounting" scopes: filter to specific platform'
        },
        conversion_type: {
          type: 'string',
          enum: ['all', 'charges', 'subscriptions', 'subscription_initial', 'subscription_renewal'],
          description: 'For "stripe" scope: type of conversions to include'
        },
        filters: {
          type: 'object',
          description: 'For "stripe": status, min/max_amount_cents, currency, product_id. For "jobber": min/max_amount_cents. For "shopify": financial_status, fulfillment_status, min/max_total_cents, utm_source, utm_campaign, shipping_country. For "subscriptions": status array, plan_interval, min_ltv_cents.'
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
          description: 'For "stripe" scope: filter by Stripe metadata fields'
        },
        breakdown_by_metadata_key: {
          type: 'string',
          description: 'For "stripe" scope: group results by a metadata key (e.g., "utm_campaign")'
        },
        breakdown_by: {
          type: 'string',
          description: 'For "subscriptions" scope: acquisition_channel/utm_source/utm_campaign/cohort_month/plan_interval'
        },
        metric: {
          type: 'string',
          enum: ['mrr', 'ltv', 'churn_rate', 'retention', 'avg_subscription_value'],
          description: 'For "subscriptions" scope: primary metric to analyze'
        },
        include_products: {
          type: 'boolean',
          description: 'For "shopify"/"ecommerce" scopes: include product-level breakdown'
        },
        include_customers: {
          type: 'boolean',
          description: 'For "ecommerce" scope: include customer cohort metrics'
        },
        include_attribution: {
          type: 'boolean',
          description: 'For "shopify" scope: include UTM and click ID attribution breakdown (default: true)'
        },
        data_type: {
          type: 'string',
          enum: ['invoices', 'expenses', 'both'],
          description: 'For "accounting" scope: type of accounting data (default: both)'
        }
      },
      required: ['scope', 'days']
    }
  },

  query_conversions: {
    name: 'query_conversions',
    description: 'Query conversion and attribution data. Scopes: "by_goal" — verified conversions grouped by conversion goal with confidence scores; "quality" — attribution quality across models (first-touch, last-touch, linear, etc.); "platform_vs_verified" — compare platform-reported vs verified Stripe/Shopify conversions; "journeys" — journey/funnel analytics with channel distribution and conversion paths; "flow_insights" — per-stage funnel metrics with dropoff rates and bottleneck identification. Common params: days. For "by_goal": min_confidence, group_by, goal_id. For "quality": attribution_models, breakdown_by. For "platform_vs_verified": min_confidence, platforms, include_link_breakdown. For "journeys": include_paths, include_transitions, top_n. For "flow_insights": goal_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['by_goal', 'quality', 'platform_vs_verified', 'journeys', 'flow_insights'],
          description: 'Which conversion/attribution operation to perform'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days of historical data'
        },
        min_confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'For "by_goal"/"platform_vs_verified" scopes: minimum link confidence threshold (0.0-1.0, default: 0.7)'
        },
        group_by: {
          type: 'string',
          enum: ['day', 'goal', 'link_method'],
          description: 'For "by_goal" scope: how to group results (default: goal)'
        },
        goal_id: {
          type: 'string',
          description: 'For "by_goal"/"flow_insights" scopes: filter to specific goal ID'
        },
        attribution_models: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['first_touch', 'last_touch', 'linear', 'time_decay', 'position_based', 'markov', 'shapley']
          },
          description: 'For "quality" scope: attribution models to analyze. Omit for all models.'
        },
        breakdown_by: {
          type: 'string',
          enum: ['platform', 'channel', 'campaign', 'source_medium'],
          description: 'For "quality" scope: how to break down attribution credit'
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['facebook', 'google', 'tiktok', 'all'] },
          description: 'For "platform_vs_verified" scope: ad platforms to include'
        },
        include_link_breakdown: {
          type: 'boolean',
          description: 'For "platform_vs_verified" scope: include breakdown by link method'
        },
        include_paths: {
          type: 'boolean',
          description: 'For "journeys" scope: include common conversion paths (default: true)'
        },
        include_transitions: {
          type: 'boolean',
          description: 'For "journeys" scope: include channel transition matrix (default: false)'
        },
        top_n: {
          type: 'number',
          minimum: 3,
          maximum: 20,
          description: 'For "journeys" scope: number of top channels/paths to return (default: 10)'
        }
      },
      required: ['scope']
    }
  },

  query_traffic: {
    name: 'query_traffic',
    description: 'Query site traffic and event data. Scopes: "realtime" — recent site traffic with sessions, users, page views, conversions, revenue, and breakdowns by channel/device/geo/utm_source; "events" — clickstream events from ClearLift tag (page views, goal completions, form submissions, etc.). For "realtime": hours, breakdown. For "events": days, event_types, page_paths, goal_ids, group_by, include_sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['realtime', 'events'],
          description: 'Which traffic operation to perform'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'For "events" scope: number of days of historical data'
        },
        hours: {
          type: 'number',
          minimum: 1,
          maximum: 168,
          description: 'For "realtime" scope: number of hours of recent traffic (default: 24)'
        },
        breakdown: {
          type: 'string',
          enum: ['channel', 'device', 'geo', 'utm_source'],
          description: 'For "realtime" scope: break down traffic by dimension'
        },
        event_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "events" scope: event types to query (page_view, goal_completed, form_submit, click, session_start, etc.)'
        },
        page_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "events" scope: filter to specific page paths (supports wildcards like /blog/*)'
        },
        goal_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "events" scope: filter to specific conversion goal IDs'
        },
        group_by: {
          type: 'string',
          enum: ['day', 'event_type', 'page_path', 'source', 'utm_campaign'],
          description: 'For "events" scope: group results by dimension'
        },
        include_sessions: {
          type: 'boolean',
          description: 'For "events" scope: include session-level aggregations'
        }
      },
      required: ['scope']
    }
  },

  query_contacts: {
    name: 'query_contacts',
    description: 'Query contact, identity, and communication data. Scopes: "crm_pipeline" — CRM deal/opportunity pipeline by stage, value, and progression; "identities" — unified customer identity graph with cross-connector resolution; "comms" — email/SMS campaign engagement metrics. For "crm_pipeline": days, stages, status, min_value_cents, include_attribution, group_by. For "identities": days, breakdown_by, min_confidence, include_match_rates. For "comms": days, platform, channel, include_campaigns, include_subscriber_health.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['crm_pipeline', 'identities', 'comms'],
          description: 'Which contacts operation to perform'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 180,
          description: 'Number of days of historical data'
        },
        stages: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "crm_pipeline" scope: filter to specific pipeline stages'
        },
        status: {
          type: 'string',
          enum: ['all', 'open', 'won', 'lost'],
          description: 'For "crm_pipeline" scope: filter by deal status'
        },
        min_value_cents: {
          type: 'number',
          description: 'For "crm_pipeline" scope: minimum deal value in cents'
        },
        include_attribution: {
          type: 'boolean',
          description: 'For "crm_pipeline" scope: include marketing attribution data'
        },
        group_by: {
          type: 'string',
          description: 'For "crm_pipeline": day/stage/source/owner'
        },
        breakdown_by: {
          type: 'string',
          enum: ['identity_method', 'first_touch_source', 'first_touch_medium'],
          description: 'For "identities" scope: how to break down identity data'
        },
        min_confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'For "identities" scope: minimum identity confidence threshold (0.0-1.0)'
        },
        include_match_rates: {
          type: 'boolean',
          description: 'For "identities" scope: include cross-connector match rate statistics (default: true)'
        },
        platform: {
          type: 'string',
          description: 'For "comms" scope: filter to specific platform (sendgrid, attentive, mailchimp, etc.)'
        },
        channel: {
          type: 'string',
          enum: ['email', 'sms', 'push', 'all'],
          description: 'For "comms" scope: filter by communication channel (default: all)'
        },
        include_campaigns: {
          type: 'boolean',
          description: 'For "comms" scope: include per-campaign breakdown (default: true)'
        },
        include_subscriber_health: {
          type: 'boolean',
          description: 'For "comms" scope: include subscriber list health metrics (default: false)'
        }
      },
      required: ['scope']
    }
  },

  query_operations: {
    name: 'query_operations',
    description: 'Query operational data from support, scheduling, and form platforms. Scopes: "support" — ticket volume, resolution times, satisfaction scores from Zendesk/Intercom; "scheduling" — appointment volume, booking rates, no-show rates from Calendly/Acuity; "forms" — form submission volume, completion rates, UTM attribution from Typeform/JotForm. Common params: days, platform, group_by. For "support": include_satisfaction, include_conversations. For "scheduling": include_services. For "forms": form_id, include_utm_breakdown.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['support', 'scheduling', 'forms'],
          description: 'Which operations data to query'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days of historical data'
        },
        platform: {
          type: 'string',
          description: 'Filter to specific platform'
        },
        group_by: {
          type: 'string',
          description: 'For "support": day/status/priority/channel/assignee. For "scheduling": day/status/service/assignee/utm_source. For "forms": day/form/utm_source/utm_campaign/device_type.'
        },
        include_satisfaction: {
          type: 'boolean',
          description: 'For "support" scope: include CSAT/satisfaction breakdown (default: true)'
        },
        include_conversations: {
          type: 'boolean',
          description: 'For "support" scope: include conversation metrics alongside tickets (default: false)'
        },
        include_services: {
          type: 'boolean',
          description: 'For "scheduling" scope: include per-service breakdown (default: true)'
        },
        form_id: {
          type: 'string',
          description: 'For "forms" scope: filter to specific form'
        },
        include_utm_breakdown: {
          type: 'boolean',
          description: 'For "forms" scope: include UTM attribution breakdown (default: true)'
        }
      },
      required: ['scope', 'days']
    }
  },

  query_growth: {
    name: 'query_growth',
    description: 'Query growth and brand metrics. Scopes: "cac" — historical CAC trend with optional AI predictions and baselines; "affiliates" — affiliate/partner program data with referral volume and commission costs; "social" — organic social media performance with post engagement and follower growth; "reviews" — review/reputation data with ratings and sentiment. Common params: days, platform. For "cac": include_predictions, include_baselines. For "affiliates": include_partners, group_by. For "social": include_posts, include_follower_trends. For "reviews": min_rating, include_sentiment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['cac', 'affiliates', 'social', 'reviews'],
          description: 'Which growth metric to query'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 180,
          description: 'Number of days of historical data'
        },
        platform: {
          type: 'string',
          description: 'Filter to specific platform'
        },
        include_predictions: {
          type: 'boolean',
          description: 'For "cac" scope: include AI-generated CAC predictions (default: false)'
        },
        include_baselines: {
          type: 'boolean',
          description: 'For "cac" scope: include CAC baseline targets (default: false)'
        },
        include_partners: {
          type: 'boolean',
          description: 'For "affiliates" scope: include per-partner breakdown (default: true)'
        },
        include_posts: {
          type: 'boolean',
          description: 'For "social" scope: include per-post breakdown (default: false)'
        },
        include_follower_trends: {
          type: 'boolean',
          description: 'For "social" scope: include follower growth timeline (default: true)'
        },
        min_rating: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'For "reviews" scope: minimum rating filter'
        },
        include_sentiment: {
          type: 'boolean',
          description: 'For "reviews" scope: include sentiment analysis breakdown (default: true)'
        },
        group_by: {
          type: 'string',
          description: 'For "affiliates" scope: day/partner/status/conversion_type'
        }
      },
      required: ['scope']
    }
  },

  calculate: {
    name: 'calculate',
    description: 'Perform calculations for analysis. Scopes: "budget_change" — calculate new budget after percentage change (use before recommending budget changes); "pct_change" — calculate percentage change between two values; "spend_vs_revenue" — compare ad spend against actual revenue with true ROAS; "compare_entities" — compare performance metrics across multiple entities. For "budget_change": current_budget_cents, percentage_change. For "pct_change": old_value, new_value. For "spend_vs_revenue": days, platforms, breakdown_by. For "compare_entities": platform, entity_type, entity_ids, metrics, days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['budget_change', 'pct_change', 'spend_vs_revenue', 'compare_entities'],
          description: 'Which calculation to perform'
        },
        current_budget_cents: {
          type: 'number',
          description: 'For "budget_change" scope: current budget in cents (e.g., 10000 for $100.00)'
        },
        percentage_change: {
          type: 'number',
          description: 'For "budget_change" scope: percentage change to apply (e.g., 25 for +25%, -15 for -15%)'
        },
        old_value: {
          type: 'number',
          description: 'For "pct_change" scope: the original value'
        },
        new_value: {
          type: 'number',
          description: 'For "pct_change" scope: the new value'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'For "spend_vs_revenue"/"compare_entities" scopes: number of days to analyze'
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['facebook', 'google', 'tiktok', 'all'] },
          description: 'For "spend_vs_revenue" scope: ad platforms to include'
        },
        breakdown_by: {
          type: 'string',
          enum: ['platform', 'day', 'campaign'],
          description: 'For "spend_vs_revenue" scope: how to break down the comparison'
        },
        platform: {
          type: 'string',
          description: 'For "compare_entities" scope: the ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign'],
          description: 'For "compare_entities" scope: type of entities to compare'
        },
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'For "compare_entities" scope: entity IDs to compare (max 5)'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "compare_entities" scope: metrics to compare'
        }
      },
      required: ['scope']
    }
  },

  list_active_connectors: {
    name: 'list_active_connectors',
    description: 'List all active connectors for this organization. Shows which data sources are connected and have data available. Use this before querying specific platforms to know what data is available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_type: {
          type: 'string',
          enum: ['ad_platform', 'payments', 'ecommerce', 'crm', 'communication', 'field_service', 'all'],
          description: 'Optional: Filter by connector type (default: all)'
        },
        include_data_stats: {
          type: 'boolean',
          description: 'Include basic data statistics (last sync, record counts)'
        }
      },
      required: []
    }
  },

  query_unified_data: {
    name: 'query_unified_data',
    description: 'Query data from any connector type using unified tables. Supports ad platforms, revenue sources (Stripe/Shopify), CRM, and communication platforms. Use this for cross-connector analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        connector_type: {
          type: 'string',
          enum: ['ad_platform', 'payments', 'ecommerce', 'crm', 'communication', 'field_service'],
          description: 'Type of connector data to query'
        },
        platform: {
          type: 'string',
          description: 'Optional: Specific platform to filter (e.g., google, stripe, hubspot)'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'Number of days of historical data'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to retrieve (depends on connector_type)'
        },
        group_by: {
          type: 'string',
          enum: ['day', 'platform', 'campaign', 'product', 'channel'],
          description: 'Optional: Group results by dimension'
        }
      },
      required: ['connector_type', 'days']
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

// Generic exploration tool definitions (provider-agnostic canonical format)
export function getExplorationToolDefinitions(): Array<{
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

/**
 * Get exploration tools filtered by org's active connectors.
 * Narrows scope enums to only relevant scopes based on connected data sources.
 */
export async function getExplorationToolsForOrg(
  db: D1Database, orgId: string
): Promise<Array<{ name: string; description: string; input_schema: object }>> {
  // Use ExplorationToolExecutor to detect active connectors
  const executor = new ExplorationToolExecutor(db);
  const result = await executor.execute('list_active_connectors', { connector_type: 'all', include_data_stats: false }, orgId);

  if (!result.success || !result.data?.connectors) {
    // Fallback: return all tools unfiltered
    return getExplorationTools();
  }

  const connectors: Array<{ type: string; platform: string }> = result.data.connectors;
  const activeTypes = new Set(connectors.map(c => c.type));
  const activePlatforms = new Set(connectors.map(c => c.platform));

  // Map connector types to tool scopes
  const toolScopeMap: Record<string, Record<string, (types: Set<string>, platforms: Set<string>) => boolean>> = {
    query_ad_metrics: {
      performance: (types) => types.has('ad_platform'),
      creatives: (types) => types.has('ad_platform'),
      audiences: (types) => types.has('ad_platform'),
      budgets: (types) => types.has('ad_platform'),
    },
    query_revenue: {
      stripe: (_types, platforms) => platforms.has('stripe'),
      jobber: (types, platforms) => platforms.has('jobber') || types.has('field_service'),
      shopify: (_types, platforms) => platforms.has('shopify'),
      ecommerce: (types) => types.has('ecommerce'),
      subscriptions: (_types, platforms) => platforms.has('stripe'),
      accounting: (types) => types.has('accounting'),
    },
    query_conversions: {
      by_goal: () => true, // always available if tag is installed
      quality: (types) => types.has('ad_platform'),
      platform_vs_verified: (types) => types.has('ad_platform'),
      journeys: () => true,
      flow_insights: () => true,
    },
    query_traffic: {
      realtime: (types) => types.has('events'),
      events: (types) => types.has('events'),
    },
    query_contacts: {
      crm_pipeline: (types) => types.has('crm'),
      identities: (types) => types.has('identity') || types.has('events'),
      comms: (types) => types.has('communication'),
    },
    query_operations: {
      support: (types) => types.has('support'),
      scheduling: (types) => types.has('scheduling'),
      forms: (types) => types.has('forms'),
    },
    query_growth: {
      cac: (types) => types.has('ad_platform') || types.has('events'),
      affiliates: (types) => types.has('affiliate'),
      social: (types) => types.has('social'),
      reviews: (types) => types.has('reviews'),
    },
    // calculate always included, list_active_connectors always included, query_unified_data always included
  };

  const allTools = getExplorationTools();
  const filtered: Array<{ name: string; description: string; input_schema: any }> = [];

  for (const tool of allTools) {
    const scopeFilter = toolScopeMap[tool.name];

    // Tools without scope filtering (calculate, list_active_connectors, query_unified_data) — always include
    if (!scopeFilter) {
      filtered.push(tool);
      continue;
    }

    // Filter scope enum to only active scopes
    const activeScopes = Object.entries(scopeFilter)
      .filter(([_, check]) => check(activeTypes, activePlatforms))
      .map(([scope]) => scope);

    if (activeScopes.length === 0) continue; // Omit tool entirely

    // Clone tool and narrow scope enum
    const narrowed = JSON.parse(JSON.stringify(tool));
    if (narrowed.input_schema?.properties?.scope?.enum) {
      narrowed.input_schema.properties.scope.enum = activeScopes;
    }
    filtered.push(narrowed);
  }

  return filtered;
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

interface QueryJobberRevenueInput {
  days: number;
  group_by?: 'day' | 'week' | 'month';
  filters?: {
    min_amount_cents?: number;
    max_amount_cents?: number;
  };
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

interface QueryConversionsByGoalInput {
  days: number;
  min_confidence?: number;
  group_by?: 'day' | 'goal' | 'link_method';
  goal_id?: string;
}

interface ComparePlatformVsVerifiedInput {
  days: number;
  min_confidence?: number;
  platforms?: Array<'facebook' | 'google' | 'tiktok' | 'all'>;
  include_link_breakdown?: boolean;
}

// ========================================================================
// NEW INTERFACES FOR UNIFIED DATA ACCESS TOOLS
// ========================================================================

interface QueryEventsInput {
  event_types?: string[];
  days: number;
  page_paths?: string[];
  goal_ids?: string[];
  group_by?: 'day' | 'event_type' | 'page_path' | 'source' | 'utm_campaign';
  include_sessions?: boolean;
}

interface QueryCrmPipelineInput {
  days: number;
  stages?: string[];
  status?: 'all' | 'open' | 'won' | 'lost';
  min_value_cents?: number;
  include_attribution?: boolean;
  group_by?: 'day' | 'stage' | 'source' | 'owner';
}

interface QueryUnifiedDataInput {
  connector_type: 'ad_platform' | 'payments' | 'ecommerce' | 'crm' | 'communication' | 'field_service';
  platform?: string;
  days: number;
  metrics?: string[];
  group_by?: 'day' | 'platform' | 'campaign' | 'product' | 'channel';
}

interface QueryJourneyAnalyticsInput {
  include_paths?: boolean;
  include_transitions?: boolean;
  top_n?: number;
}

interface QueryFlowInsightsInput {
  goal_id?: string;
}

interface QueryCacTimelineInput {
  days?: number;
  include_predictions?: boolean;
  include_baselines?: boolean;
}

interface QueryRealtimeTrafficInput {
  hours?: number;
  breakdown?: 'channel' | 'device' | 'geo' | 'utm_source';
}

interface QueryShopifyRevenueInput {
  days: number;
  group_by?: 'day' | 'week' | 'month' | 'utm_source' | 'utm_campaign' | 'source_name' | 'shipping_country';
  filters?: {
    financial_status?: string;
    fulfillment_status?: string;
    min_total_cents?: number;
    max_total_cents?: number;
    utm_source?: string;
    utm_campaign?: string;
    shipping_country?: string;
  };
  include_products?: boolean;
  include_attribution?: boolean;
}

interface QueryCustomerIdentitiesInput {
  days?: number;
  breakdown_by?: 'identity_method' | 'first_touch_source' | 'first_touch_medium';
  min_confidence?: number;
  include_match_rates?: boolean;
}

interface QueryCommEngagementInput {
  days: number;
  platform?: string;
  channel?: 'email' | 'sms' | 'push' | 'all';
  include_campaigns?: boolean;
  include_subscriber_health?: boolean;
}

interface QueryEcommerceAnalyticsInput {
  days: number;
  platform?: string;
  group_by?: 'day' | 'platform' | 'status' | 'utm_source' | 'utm_campaign';
  include_products?: boolean;
  include_customers?: boolean;
}

interface QuerySupportMetricsInput {
  days: number;
  platform?: string;
  include_satisfaction?: boolean;
  include_conversations?: boolean;
  group_by?: 'day' | 'status' | 'priority' | 'channel' | 'assignee';
}

interface QuerySchedulingMetricsInput {
  days: number;
  platform?: string;
  include_services?: boolean;
  group_by?: 'day' | 'status' | 'service' | 'assignee' | 'utm_source';
}

interface QueryFormSubmissionsInput {
  days: number;
  platform?: string;
  form_id?: string;
  group_by?: 'day' | 'form' | 'utm_source' | 'utm_campaign' | 'device_type';
  include_utm_breakdown?: boolean;
}

interface QueryAccountingMetricsInput {
  days: number;
  platform?: string;
  data_type?: 'invoices' | 'expenses' | 'both';
  group_by?: 'day' | 'month' | 'status' | 'category';
}

interface QueryReviewsInput {
  days: number;
  platform?: string;
  min_rating?: number;
  include_sentiment?: boolean;
}

interface QueryAffiliateMetricsInput {
  days: number;
  platform?: string;
  include_partners?: boolean;
  group_by?: 'day' | 'partner' | 'status' | 'conversion_type';
}

interface QuerySocialMetricsInput {
  days: number;
  platform?: string;
  include_posts?: boolean;
  include_follower_trends?: boolean;
}

interface ListActiveConnectorsInput {
  connector_type?: 'ad_platform' | 'payments' | 'ecommerce' | 'crm' | 'communication' | 'field_service' | 'all';
  include_data_stats?: boolean;
}

/**
 * Exploration Tool Executor
 * Uses D1 ANALYTICS_DB for all queries
 * UPDATED: Now supports unified tables and dynamic platform discovery
 */
export class ExplorationToolExecutor {
  constructor(private db: D1Database, private coreDb?: D1Database) {}

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
        case 'query_ad_metrics': {
          // Validate platform is provided and valid
          const validPlatforms = ['google', 'facebook', 'tiktok', 'linkedin', 'microsoft', 'pinterest', 'snapchat', 'twitter'];
          if (!input.platform || typeof input.platform !== 'string') {
            return { success: false, error: `Missing required parameter "platform". Must be one of: ${validPlatforms.join(', ')}` };
          }
          // Validate entity_type is provided for scopes that need it
          const validEntityTypes = ['ad', 'adset', 'campaign', 'account', 'ad_group'];
          if (['performance', 'audiences', 'budgets'].includes(input.scope) && (!input.entity_type || !validEntityTypes.includes(input.entity_type))) {
            return { success: false, error: `Missing or invalid "entity_type" for scope "${input.scope}". Must be one of: ${validEntityTypes.join(', ')}` };
          }
          // Validate entity_id for scopes that require it (account-level queries are OK without entity_id)
          if (['performance', 'creatives', 'audiences', 'budgets'].includes(input.scope) && input.entity_type !== 'account' && !input.entity_id) {
            return { success: false, error: `Missing required parameter "entity_id" for scope "${input.scope}" with entity_type "${input.entity_type}". Provide the specific entity ID to query.` };
          }
          switch (input.scope) {
            case 'performance': return await this.queryMetrics(input as QueryMetricsInput, orgId);
            case 'creatives': return await this.getCreativeDetails(input as GetCreativeDetailsInput, orgId);
            case 'audiences': return await this.getAudienceBreakdown(input as GetAudienceBreakdownInput, orgId);
            case 'budgets': return await this.getEntityBudget(input as GetEntityBudgetInput, orgId);
            default: return { success: false, error: `Unknown scope for query_ad_metrics: ${input.scope}` };
          }
        }
        case 'query_revenue':
          switch (input.scope) {
            case 'stripe': return await this.queryStripeRevenue(input as QueryStripeRevenueInput, orgId);
            case 'jobber': return await this.queryJobberRevenue(input as QueryJobberRevenueInput, orgId);
            case 'shopify': return await this.queryShopifyRevenue(input as QueryShopifyRevenueInput, orgId);
            case 'ecommerce': return await this.queryEcommerceAnalytics(input as QueryEcommerceAnalyticsInput, orgId);
            case 'subscriptions': return await this.querySubscriptionCohorts(input as QuerySubscriptionCohortsInput, orgId);
            case 'accounting': return await this.queryAccountingMetrics(input as QueryAccountingMetricsInput, orgId);
            default: return { success: false, error: `Unknown scope for query_revenue: ${input.scope}` };
          }
        case 'query_conversions':
          switch (input.scope) {
            case 'by_goal': return await this.queryConversionsByGoal(input as QueryConversionsByGoalInput, orgId);
            case 'quality': return await this.queryAttributionQuality(input as QueryAttributionQualityInput, orgId);
            case 'platform_vs_verified': return await this.comparePlatformVsVerified(input as ComparePlatformVsVerifiedInput, orgId);
            case 'journeys': return await this.queryJourneyAnalytics(input as QueryJourneyAnalyticsInput, orgId);
            case 'flow_insights': return await this.queryFlowInsights(input as QueryFlowInsightsInput, orgId);
            default: return { success: false, error: `Unknown scope for query_conversions: ${input.scope}` };
          }
        case 'query_traffic':
          switch (input.scope) {
            case 'realtime': return await this.queryRealtimeTraffic(input as QueryRealtimeTrafficInput, orgId);
            case 'events': return await this.queryEvents(input as QueryEventsInput, orgId);
            default: return { success: false, error: `Unknown scope for query_traffic: ${input.scope}` };
          }
        case 'query_contacts':
          switch (input.scope) {
            case 'crm_pipeline': return await this.queryCrmPipeline(input as QueryCrmPipelineInput, orgId);
            case 'identities': return await this.queryCustomerIdentities(input as QueryCustomerIdentitiesInput, orgId);
            case 'comms': return await this.queryCommEngagement(input as QueryCommEngagementInput, orgId);
            default: return { success: false, error: `Unknown scope for query_contacts: ${input.scope}` };
          }
        case 'query_operations':
          switch (input.scope) {
            case 'support': return await this.querySupportMetrics(input as QuerySupportMetricsInput, orgId);
            case 'scheduling': return await this.querySchedulingMetrics(input as QuerySchedulingMetricsInput, orgId);
            case 'forms': return await this.queryFormSubmissions(input as QueryFormSubmissionsInput, orgId);
            default: return { success: false, error: `Unknown scope for query_operations: ${input.scope}` };
          }
        case 'query_growth':
          switch (input.scope) {
            case 'cac': return await this.queryCacTimeline(input as QueryCacTimelineInput, orgId);
            case 'affiliates': return await this.queryAffiliateMetrics(input as QueryAffiliateMetricsInput, orgId);
            case 'social': return await this.querySocialMetrics(input as QuerySocialMetricsInput, orgId);
            case 'reviews': return await this.queryReviews(input as QueryReviewsInput, orgId);
            default: return { success: false, error: `Unknown scope for query_growth: ${input.scope}` };
          }
        case 'calculate':
          switch (input.scope) {
            case 'budget_change': return this.calculateBudgetChange(input as CalculateBudgetChangeInput);
            case 'pct_change': return this.calculatePercentageChange(input as CalculatePercentageChangeInput);
            case 'spend_vs_revenue': return await this.compareSpendToRevenue(input as CompareSpendToRevenueInput, orgId);
            case 'compare_entities': return await this.compareEntities(input as CompareEntitiesInput, orgId);
            default: return { success: false, error: `Unknown scope for calculate: ${input.scope}` };
          }
        case 'query_unified_data':
          return await this.queryUnifiedData(input as QueryUnifiedDataInput, orgId);
        case 'list_active_connectors':
          return await this.listActiveConnectors(input as ListActiveConnectorsInput, orgId);
        default:
          return { success: false, error: `Unknown exploration tool: ${toolName}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Tool execution failed' };
    }
  }

  /**
   * Query metrics for a specific entity (D1 version)
   */
  private async queryMetrics(
    input: QueryMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id, metrics, days, include_verified_revenue } = input;

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // Try unified tables first (ad_metrics)
      const hasUnified = await this.hasUnifiedData(orgId, platform);
      let data: Array<{
        metric_date: string;
        spend_cents: number;
        impressions: number;
        clicks: number;
        conversions: number;
        conversion_value_cents: number;
      }> = [];

      if (hasUnified) {
        // Use unified ad_metrics table
        const { query, params } = this.buildUnifiedMetricsQuery(platform, entity_type, entity_id, days, orgId);
        const result = await this.db.prepare(query).bind(...params).all<{
          metric_date: string;
          impressions: number;
          clicks: number;
          spend_cents: number;
          conversions: number;
          conversion_value_cents: number;
          ctr: number;
          cpc_cents: number;
          cpm_cents: number;
          extra_metrics: string | null;
        }>();
        data = result.results || [];
      } else {
        // Fall back to legacy platform-specific tables
        const tableInfo = this.getMetricsTableInfo(platform, entity_type);
        if (!tableInfo) {
          return { success: false, error: `Unsupported platform/entity for metrics: ${platform}/${entity_type}` };
        }

        // D1 SQL query for legacy tables
        const sql = `
          SELECT metric_date, spend_cents, impressions, clicks, conversions, conversion_value_cents
          FROM ${tableInfo.table}
          WHERE ${tableInfo.idColumn} = ? AND organization_id = ?
            AND metric_date >= ? AND metric_date <= ?
          ORDER BY metric_date ASC
        `;

        const result = await this.db.prepare(sql).bind(entity_id, orgId, startStr, endStr).all<{
          metric_date: string;
          spend_cents: number;
          impressions: number;
          clicks: number;
          conversions: number;
          conversion_value_cents: number;
        }>();
        data = result.results || [];
      }

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
   * Get verified Stripe revenue for a date range (D1 version)
   */
  private async getVerifiedRevenueForDateRange(
    orgId: string,
    startStr: string,
    endStr: string
  ): Promise<{ revenue_cents: number; conversions: number }> {
    try {
      const sql = `
        SELECT COALESCE(SUM(value_cents), 0) as total_cents, COUNT(*) as count
        FROM connector_events
        WHERE organization_id = ?
          AND transacted_at >= ? AND transacted_at <= ?
          AND status IN ('succeeded', 'paid', 'completed', 'active')
      `;
      const result = await this.db.prepare(sql).bind(orgId, startStr, endStr + 'T23:59:59Z').first<{
        total_cents: number | null;
        count: number;
      }>();

      return {
        revenue_cents: result?.total_cents || 0,
        conversions: result?.count || 0
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
   * Compare multiple entities (D1 version)
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
        const sql = `
          SELECT metric_date, spend_cents, impressions, clicks, conversions, conversion_value_cents
          FROM ${tableInfo.table}
          WHERE ${tableInfo.idColumn} = ? AND organization_id = ?
            AND metric_date >= ? AND metric_date <= ?
        `;

        try {
          const result = await this.db.prepare(sql).bind(entityId, orgId, startStr, endStr).all<any>();
          const data = result.results || [];
          const enrichedData = this.enrichMetrics(data, metrics);
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
   * Get creative details for an ad (D1 version)
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

    const sql = `SELECT * FROM ${tableInfo.table} WHERE ${tableInfo.idColumn} = ? AND organization_id = ? LIMIT 1`;

    try {
      const ad = await this.db.prepare(sql).bind(ad_id, orgId).first<any>();

      if (!ad) {
        return { success: false, error: `Ad not found: ${ad_id}` };
      }

      const creativeInfo = this.extractCreativeInfo(ad, platform);

      return {
        success: true,
        data: {
          ad_id,
          platform,
          name: ad.ad_name || ad.name,
          status: ad.ad_status || ad.status,
          ...creativeInfo
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Get audience breakdown (D1 version)
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

    // Get name column based on platform and entity type
    const nameCol = this.getNameColumn(platform, entity_type);
    const sql = `SELECT ${nameCol} as name, targeting FROM ${tableInfo.table} WHERE ${tableInfo.idColumn} = ? AND organization_id = ? LIMIT 1`;

    try {
      const entity = await this.db.prepare(sql).bind(entity_id, orgId).first<{ name: string; targeting: string }>();

      if (!entity) {
        return { success: false, error: `Entity not found: ${entity_id}` };
      }

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
   * Get the name column for an entity based on platform and type
   */
  private getNameColumn(platform: string, entityType: string): string {
    const columns: Record<string, Record<string, string>> = {
      google: { ad: 'ad_name', adset: 'ad_group_name', campaign: 'campaign_name' },
      facebook: { ad: 'ad_name', adset: 'ad_set_name', campaign: 'campaign_name' },
      tiktok: { ad: 'ad_name', adset: 'ad_group_name', campaign: 'campaign_name' }
    };
    return columns[platform]?.[entityType] || 'name';
  }

  /**
   * Query Stripe revenue with metadata filtering (D1 version)
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
      // Build D1 SQL query for connector_events table (Stripe)
      let sql = `
        SELECT external_id as charge_id, value_cents as amount_cents, currency,
               status, customer_external_id as customer_id,
               transacted_at as created_at, metadata
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform = 'stripe'
          AND transacted_at >= ? AND transacted_at <= ?
      `;
      const params: any[] = [orgId, startStr, endStr + 'T23:59:59Z'];

      // Apply status filter
      if (filters?.status) {
        sql += ` AND status = ?`;
        params.push(filters.status);
      }
      if (filters?.min_amount_cents) {
        sql += ` AND value_cents >= ?`;
        params.push(filters.min_amount_cents);
      }
      if (filters?.max_amount_cents) {
        sql += ` AND value_cents <= ?`;
        params.push(filters.max_amount_cents);
      }
      if (filters?.currency) {
        sql += ` AND currency = ?`;
        params.push(filters.currency);
      }

      sql += ` ORDER BY created_at ASC`;

      const result = await this.db.prepare(sql).bind(...params).all<{
        charge_id: string;
        amount_cents: number;
        currency: string;
        status: string;
        customer_id: string;
        created_at: string;
        metadata: string;
      }>();

      let data = (result.results || []).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        stripe_created_at: row.created_at
      }));

      if (data.length === 0) {
        return { success: true, data: { time_series: [], summary: { total_revenue: '$0.00', total_transactions: 0 } } };
      }

      // Apply metadata filters in memory (JSON filtering)
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
   * Query Jobber completed jobs as revenue from connector_events.
   */
  private async queryJobberRevenue(
    input: QueryJobberRevenueInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, group_by = 'day', filters } = input;

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // D1 SQL query for Jobber connector_events
      let sql = `
        SELECT external_id as job_id, value_cents as total_amount_cents,
               customer_external_id as client_id, transacted_at as completed_at
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform = 'jobber'
          AND status IN ('completed', 'paid', 'succeeded')
          AND transacted_at >= ? AND transacted_at <= ?
        ORDER BY transacted_at ASC
      `;
      const params: any[] = [orgId, startStr, endStr + 'T23:59:59Z'];

      const result = await this.db.prepare(sql).bind(...params).all<{
        job_id: string;
        total_amount_cents: number;
        client_id: string;
        completed_at: string;
      }>();

      const data = result.results || [];

      if (data.length === 0) {
        return { success: true, data: { time_series: [], summary: { total_revenue: '$0.00', total_jobs: 0 } } };
      }

      // Apply filters
      let filteredData = data;
      if (filters?.min_amount_cents) {
        filteredData = filteredData.filter(r => (r.total_amount_cents || 0) >= filters.min_amount_cents!);
      }
      if (filters?.max_amount_cents) {
        filteredData = filteredData.filter(r => (r.total_amount_cents || 0) <= filters.max_amount_cents!);
      }

      // Group by time period
      const grouped: Record<string, { revenue_cents: number; count: number; unique_clients: Set<string> }> = {};

      for (const job of filteredData) {
        if (!job.completed_at) continue;
        const dateKey = this.getGroupedDateKey(job.completed_at.split('T')[0], group_by);

        if (!grouped[dateKey]) {
          grouped[dateKey] = { revenue_cents: 0, count: 0, unique_clients: new Set() };
        }

        grouped[dateKey].revenue_cents += job.total_amount_cents || 0;
        grouped[dateKey].count += 1;
        if (job.client_id) {
          grouped[dateKey].unique_clients.add(job.client_id);
        }
      }

      // Calculate summary
      const totalRevenue = filteredData.reduce((sum, r) => sum + (r.total_amount_cents || 0), 0);
      const uniqueClients = new Set(filteredData.map(r => r.client_id).filter(Boolean)).size;

      // Build response
      const timeSeries = Object.entries(grouped)
        .map(([date, groupData]) => ({
          date,
          revenue_cents: groupData.revenue_cents,
          revenue: '$' + (groupData.revenue_cents / 100).toFixed(2),
          jobs: groupData.count,
          unique_clients: groupData.unique_clients.size
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        success: true,
        data: {
          time_series: timeSeries,
          summary: {
            total_revenue: '$' + (totalRevenue / 100).toFixed(2),
            total_jobs: filteredData.length,
            unique_clients: uniqueClients,
            avg_job_value: filteredData.length > 0
              ? '$' + ((totalRevenue / 100) / filteredData.length).toFixed(2)
              : '$0.00'
          }
        }
      };
    } catch (err) {
      // If connector_events table doesn't exist yet, return empty result
      const errorMessage = err instanceof Error ? err.message : 'Query failed';
      if (errorMessage.includes('no such table')) {
        return { success: true, data: { time_series: [], summary: { total_revenue: '$0.00', total_jobs: 0 }, note: 'Jobber data not yet synced to D1' } };
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get grouped date key for time series
   */
  private getGroupedDateKey(date: string, groupBy: 'day' | 'week' | 'month'): string {
    const d = new Date(date);

    switch (groupBy) {
      case 'week':
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split('T')[0];

      case 'month':
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

      default:
        return date;
    }
  }

  /**
   * Compare ad platform spend to actual Stripe revenue (D1 version)
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

      // Fetch ad platform spend and conversions using D1
      const platformData = await Promise.all(
        platformsToQuery.map(async (platform) => {
          const tableInfo = this.getMetricsTableInfo(platform, 'campaign');
          if (!tableInfo) return { platform, spend_cents: 0, platform_conversions: 0, platform_conversion_value_cents: 0 };

          const sql = `
            SELECT SUM(spend_cents) as spend_cents, SUM(conversions) as conversions, SUM(conversion_value_cents) as conversion_value_cents
            FROM ${tableInfo.table}
            WHERE organization_id = ? AND metric_date >= ? AND metric_date <= ?
          `;
          const result = await this.db.prepare(sql).bind(orgId, startStr, endStr).first<{
            spend_cents: number | null;
            conversions: number | null;
            conversion_value_cents: number | null;
          }>();

          return {
            platform,
            spend_cents: result?.spend_cents || 0,
            platform_conversions: result?.conversions || 0,
            platform_conversion_value_cents: result?.conversion_value_cents || 0
          };
        })
      );

      // Fetch verified connector revenue using D1
      const stripeSql = `
        SELECT COALESCE(SUM(value_cents), 0) as total_cents, COUNT(*) as count
        FROM connector_events
        WHERE organization_id = ?
          AND transacted_at >= ? AND transacted_at <= ?
          AND status IN ('succeeded', 'paid', 'completed', 'active')
      `;
      const stripeResult = await this.db.prepare(stripeSql).bind(orgId, startStr, endStr + 'T23:59:59Z').first<{
        total_cents: number | null;
        count: number;
      }>();

      const verifiedRevenue = stripeResult?.total_cents || 0;
      const verifiedConversions = stripeResult?.count || 0;

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
   * Query attribution quality across multiple models (D1 version)
   * Note: Requires attribution_results table in ANALYTICS_DB
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
      // Query conversions from D1 (not attribution_results which has aggregated data)
      const sql = `
        SELECT *
        FROM conversions
        WHERE organization_id = ?
          AND conversion_timestamp >= ? AND conversion_timestamp <= ?
          AND conversion_source = 'stripe'
      `;
      const result = await this.db.prepare(sql).bind(orgId, startStr, endStr + 'T23:59:59Z').all<any>();
      const conversions = result.results || [];

      if (conversions.length === 0) {
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
      const errorMessage = err instanceof Error ? err.message : 'Query failed';
      if (errorMessage.includes('no such table')) {
        return { success: true, data: { summary: { note: 'Attribution data not yet synced to D1' }, by_model: {}, platform_match_rates: [] } };
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Query subscription cohort metrics (MRR, LTV, churn, retention) (D1 version)
   * Note: Queries connector_events WHERE source_platform='stripe' AND event_type LIKE '%subscription%' in ANALYTICS_DB
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
      // Build D1 SQL query for Stripe subscription events from connector_events
      let sql = `SELECT id, external_id, customer_external_id, value_cents,
                        status, event_type, transacted_at,
                        metadata, currency
                 FROM connector_events
                 WHERE organization_id = ? AND source_platform = 'stripe' AND event_type LIKE '%subscription%'`;
      const params: any[] = [orgId];

      // Apply status filters
      if (filters?.status && filters.status.length > 0) {
        const placeholders = filters.status.map(() => '?').join(',');
        sql += ` AND status IN (${placeholders})`;
        params.push(...filters.status);
      }

      // Apply interval filter
      if (filters?.plan_interval) {
        sql += ` AND interval = ?`;
        params.push(filters.plan_interval);
      }

      const result = await this.db.prepare(sql).bind(...params).all<any>();
      const subscriptions = result.results || [];

      if (subscriptions.length === 0) {
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
        const created = new Date(s.created_at || s.stripe_created_at);
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
      const errorMessage = err instanceof Error ? err.message : 'Query failed';
      if (errorMessage.includes('no such table')) {
        return { success: true, data: { summary: { total_mrr: '$0.00', active_subscriptions: 0, note: 'Subscription data not yet synced to D1' }, by_breakdown: [] } };
      }
      return { success: false, error: errorMessage };
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
   * Get current budget for an entity from platform tables (D1 version)
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

    // Build D1 SQL query
    const sql = `SELECT * FROM ${tableInfo.table} WHERE ${tableInfo.idColumn} = ? AND organization_id = ? LIMIT 1`;

    try {
      const entity = await this.db.prepare(sql).bind(entity_id, orgId).first<any>();

      if (!entity) {
        return { success: false, error: `Entity not found: ${entity_id}` };
      }

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

  /**
   * Query verified conversions grouped by source platform / connector.
   * Uses the conversions table populated by ConversionAggregationWorkflow.
   */
  private async queryConversionsByGoal(
    input: QueryConversionsByGoalInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, min_confidence = 0.7, group_by = 'goal', goal_id } = input;

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    try {
      // Query conversions from unified conversions table
      let sql = `
        SELECT
          id,
          conversion_source,
          link_method,
          link_confidence,
          value_cents,
          currency,
          conversion_timestamp,
          source_platform
        FROM conversions
        WHERE organization_id = ?
          AND link_confidence >= ?
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
      `;
      const params: any[] = [orgId, min_confidence, startStr, endStr + 'T23:59:59Z'];

      if (goal_id) {
        sql += ` AND conversion_source = ?`;
        params.push(goal_id);
      }

      sql += ` ORDER BY conversion_timestamp DESC`;

      const result = await this.db.prepare(sql).bind(...params).all<{
        id: string;
        conversion_source: string;
        link_method: string;
        link_confidence: number;
        value_cents: number;
        currency: string;
        conversion_timestamp: string;
        source_platform: string;
      }>();

      const conversions = result.results || [];

      if (conversions.length === 0) {
        return {
          success: true,
          data: {
            summary: {
              verified_conversions: 0,
              total_value: '$0.00',
              avg_confidence: 0,
              note: 'No linked conversions found. Run ConversionLinkingWorkflow to populate data.'
            },
            by_goal: [],
            by_link_method: {}
          }
        };
      }

      // Group by the requested dimension
      let groupedData: any;

      if (group_by === 'goal') {
        groupedData = this.groupConversionsByGoal(conversions);
      } else if (group_by === 'day') {
        groupedData = this.groupConversionsByDay(conversions);
      } else if (group_by === 'link_method') {
        groupedData = this.groupConversionsByLinkMethod(conversions);
      }

      // Calculate summary metrics
      const totalValue = conversions.reduce((sum, c) => sum + (c.value_cents || 0), 0);
      const avgConfidence = conversions.reduce((sum, c) => sum + (c.link_confidence || 0), 0) / conversions.length;

      // Calculate link method breakdown
      const linkMethodBreakdown = this.groupConversionsByLinkMethod(conversions);

      return {
        success: true,
        data: {
          summary: {
            verified_conversions: conversions.length,
            total_value_cents: totalValue,
            total_value: '$' + (totalValue / 100).toFixed(2),
            avg_confidence: avgConfidence.toFixed(2),
            date_range: { start: startStr, end: endStr }
          },
          [`by_${group_by}`]: groupedData,
          link_method_breakdown: linkMethodBreakdown
        }
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Query failed';
      if (errorMessage.includes('no such table')) {
        return {
          success: true,
          data: {
            summary: { verified_conversions: 0, note: 'Conversions table not found in ANALYTICS_DB' },
            by_goal: []
          }
        };
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Compare platform-reported vs verified conversions
   * Shows inflation factor and true ROAS
   */
  private async comparePlatformVsVerified(
    input: ComparePlatformVsVerifiedInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, min_confidence = 0.7, platforms = ['all'], include_link_breakdown = false } = input;

    // Build date range
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

      // Fetch platform-reported metrics (spend, conversions, conversion value)
      const platformData = await Promise.all(
        platformsToQuery.map(async (platform) => {
          const tableInfo = this.getMetricsTableInfo(platform, 'campaign');
          if (!tableInfo) return {
            platform,
            spend_cents: 0,
            platform_conversions: 0,
            platform_conversion_value_cents: 0
          };

          const sql = `
            SELECT
              SUM(spend_cents) as spend_cents,
              SUM(conversions) as conversions,
              SUM(conversion_value_cents) as conversion_value_cents
            FROM ${tableInfo.table}
            WHERE organization_id = ?
              AND metric_date >= ?
              AND metric_date <= ?
          `;
          const result = await this.db.prepare(sql).bind(orgId, startStr, endStr).first<{
            spend_cents: number | null;
            conversions: number | null;
            conversion_value_cents: number | null;
          }>();

          return {
            platform,
            spend_cents: result?.spend_cents || 0,
            platform_conversions: result?.conversions || 0,
            platform_conversion_value_cents: result?.conversion_value_cents || 0
          };
        })
      );

      // Fetch verified conversions (attributed with sufficient confidence)
      const verifiedSql = `
        SELECT
          COUNT(*) as verified_count,
          SUM(value_cents) as verified_value_cents,
          AVG(link_confidence) as avg_confidence,
          link_method
        FROM conversions
        WHERE organization_id = ?
          AND link_confidence >= ?
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
        GROUP BY link_method
      `;
      const verifiedResult = await this.db.prepare(verifiedSql)
        .bind(orgId, min_confidence, startStr, endStr + 'T23:59:59Z')
        .all<{
          verified_count: number;
          verified_value_cents: number;
          avg_confidence: number;
          link_method: string;
        }>();

      const verifiedData = verifiedResult.results || [];

      // Also get total connector conversions (not just linked)
      const connectorSql = `
        SELECT COUNT(*) as total_count, SUM(value_cents) as total_value_cents
        FROM conversions
        WHERE organization_id = ?
          AND source_platform IN ('stripe', 'shopify')
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
      `;
      const connectorResult = await this.db.prepare(connectorSql)
        .bind(orgId, startStr, endStr + 'T23:59:59Z')
        .first<{ total_count: number; total_value_cents: number }>();

      // Calculate totals
      const totalSpend = platformData.reduce((sum, p) => sum + p.spend_cents, 0);
      const totalPlatformConversions = platformData.reduce((sum, p) => sum + p.platform_conversions, 0);
      const totalPlatformRevenue = platformData.reduce((sum, p) => sum + p.platform_conversion_value_cents, 0);

      const totalVerifiedCount = verifiedData.reduce((sum, v) => sum + v.verified_count, 0);
      const totalVerifiedValue = verifiedData.reduce((sum, v) => sum + v.verified_value_cents, 0);
      const avgConfidence = verifiedData.length > 0
        ? verifiedData.reduce((sum, v) => sum + (v.avg_confidence * v.verified_count), 0) / totalVerifiedCount
        : 0;

      const totalConnectorConversions = connectorResult?.total_count || 0;
      const totalConnectorValue = connectorResult?.total_value_cents || 0;

      // Calculate key metrics
      const platformRoas = totalSpend > 0 ? totalPlatformRevenue / totalSpend : 0;
      const trueRoas = totalSpend > 0 ? totalVerifiedValue / totalSpend : 0;
      const inflationFactor = totalVerifiedValue > 0 && totalPlatformRevenue > 0
        ? totalPlatformRevenue / totalVerifiedValue
        : 1;
      const verificationRate = totalConnectorConversions > 0
        ? (totalVerifiedCount / totalConnectorConversions) * 100
        : 0;

      const response: any = {
        summary: {
          date_range: { start: startStr, end: endStr },
          total_spend: '$' + (totalSpend / 100).toFixed(2),
          // Platform-reported metrics
          platform_reported: {
            conversions: totalPlatformConversions,
            revenue: '$' + (totalPlatformRevenue / 100).toFixed(2),
            roas: platformRoas.toFixed(2)
          },
          // Verified metrics (linked to goals)
          verified: {
            conversions: totalVerifiedCount,
            revenue: '$' + (totalVerifiedValue / 100).toFixed(2),
            roas: trueRoas.toFixed(2),
            avg_confidence: avgConfidence.toFixed(2)
          },
          // Analysis
          analysis: {
            inflation_factor: inflationFactor.toFixed(2) + 'x',
            platform_overstates_by: totalPlatformRevenue > 0 && totalVerifiedValue > 0
              ? (((totalPlatformRevenue - totalVerifiedValue) / totalVerifiedValue) * 100).toFixed(1) + '%'
              : 'N/A',
            true_roas_vs_reported: platformRoas > 0
              ? ((trueRoas / platformRoas) * 100).toFixed(1) + '%'
              : 'N/A'
          },
          // Verification metrics
          verification: {
            total_connector_conversions: totalConnectorConversions,
            linked_conversions: totalVerifiedCount,
            unlinked_conversions: totalConnectorConversions - totalVerifiedCount,
            verification_rate: verificationRate.toFixed(1) + '%'
          }
        },
        by_platform: platformData.map(p => ({
          platform: p.platform,
          spend: '$' + (p.spend_cents / 100).toFixed(2),
          platform_conversions: p.platform_conversions,
          platform_revenue: '$' + (p.platform_conversion_value_cents / 100).toFixed(2),
          platform_roas: p.spend_cents > 0
            ? (p.platform_conversion_value_cents / p.spend_cents).toFixed(2)
            : '0'
        }))
      };

      // Add link method breakdown if requested
      if (include_link_breakdown) {
        response.by_link_method = verifiedData.map(v => ({
          link_method: v.link_method,
          conversions: v.verified_count,
          revenue: '$' + (v.verified_value_cents / 100).toFixed(2),
          avg_confidence: v.avg_confidence.toFixed(2),
          pct_of_verified: totalVerifiedCount > 0
            ? ((v.verified_count / totalVerifiedCount) * 100).toFixed(1) + '%'
            : '0%'
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Query failed';
      if (errorMessage.includes('no such table')) {
        return {
          success: true,
          data: {
            summary: {
              note: 'Conversions table not found. Run ConversionLinkingWorkflow to populate data.'
            },
            by_platform: []
          }
        };
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Group conversions by source platform / connector
   */
  private groupConversionsByGoal(conversions: any[]): any[] {
    const bySource = new Map<string, { conversions: number; value_cents: number; confidences: number[] }>();

    for (const c of conversions) {
      const source = c.conversion_source || c.source_platform || 'unknown';
      if (!bySource.has(source)) {
        bySource.set(source, { conversions: 0, value_cents: 0, confidences: [] });
      }
      const g = bySource.get(source)!;
      g.conversions += 1;
      g.value_cents += c.value_cents || 0;
      g.confidences.push(c.link_confidence || 0);
    }

    return Array.from(bySource.entries()).map(([source, data]) => ({
      goal_id: source,
      goal_name: source,
      conversions: data.conversions,
      value: '$' + (data.value_cents / 100).toFixed(2),
      avg_confidence: (data.confidences.reduce((a, b) => a + b, 0) / data.confidences.length).toFixed(2)
    })).sort((a, b) => b.conversions - a.conversions);
  }

  /**
   * Group conversions by day
   */
  private groupConversionsByDay(conversions: any[]): any[] {
    const byDay = new Map<string, { conversions: number; value_cents: number }>();

    for (const c of conversions) {
      const date = c.conversion_timestamp?.split('T')[0] || 'unknown';
      if (!byDay.has(date)) {
        byDay.set(date, { conversions: 0, value_cents: 0 });
      }
      const d = byDay.get(date)!;
      d.conversions += 1;
      d.value_cents += c.value_cents || 0;
    }

    return Array.from(byDay.entries())
      .map(([date, data]) => ({
        date,
        conversions: data.conversions,
        value: '$' + (data.value_cents / 100).toFixed(2)
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Group conversions by link method
   */
  private groupConversionsByLinkMethod(conversions: any[]): Record<string, { conversions: number; value: string; avg_confidence: string }> {
    const byMethod = new Map<string, { conversions: number; value_cents: number; confidences: number[] }>();

    for (const c of conversions) {
      const method = c.link_method || 'unknown';
      if (!byMethod.has(method)) {
        byMethod.set(method, { conversions: 0, value_cents: 0, confidences: [] });
      }
      const m = byMethod.get(method)!;
      m.conversions += 1;
      m.value_cents += c.value_cents || 0;
      m.confidences.push(c.link_confidence || 0);
    }

    const result: Record<string, { conversions: number; value: string; avg_confidence: string }> = {};
    for (const [method, data] of byMethod.entries()) {
      result[method] = {
        conversions: data.conversions,
        value: '$' + (data.value_cents / 100).toFixed(2),
        avg_confidence: (data.confidences.reduce((a, b) => a + b, 0) / data.confidences.length).toFixed(2)
      };
    }
    return result;
  }

  // Helper methods

  /**
   * Check if unified tables have data for this platform/org combination
   * Used to determine whether to use unified or legacy tables
   */
  private async hasUnifiedData(orgId: string, platform?: string): Promise<boolean> {
    try {
      let query = 'SELECT 1 FROM ad_metrics WHERE organization_id = ? AND entity_type = \'campaign\'';
      const params: any[] = [orgId];

      if (platform) {
        query += ' AND platform = ?';
        params.push(platform);
      }

      query += ' LIMIT 1';

      const result = await this.db.prepare(query).bind(...params).first();
      return !!result;
    } catch {
      return false;
    }
  }

  /**
   * Get METRICS table info (for queryMetrics, compareEntities)
   * All platforms now use unified ad_metrics table (Jan 2026 migration complete)
   */
  private getMetricsTableInfo(platform: string, entityType: string): { table: string; idColumn: string; unified: boolean } | null {
    // Map entity type to unified entity_type value
    const validEntityTypes: Record<string, string> = {
      ad: 'ad',
      adset: 'ad_group',
      campaign: 'campaign'
    };

    // All platforms use unified ad_metrics table
    if (validEntityTypes[entityType]) {
      return {
        table: 'ad_metrics',
        idColumn: 'entity_ref',
        unified: true
      };
    }

    return null; // Invalid entity type
  }

  /**
   * Build unified metrics query
   * Queries ad_metrics table with platform and entity_type filters
   */
  private buildUnifiedMetricsQuery(
    platform: string,
    entityType: string,
    entityId: string | undefined,
    days: number,
    orgId: string
  ): { query: string; params: any[] } {
    // Map our entity type to unified entity_type value
    const unifiedEntityType: Record<string, string> = {
      ad: 'ad',
      adset: 'ad_group',
      campaign: 'campaign'
    };

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);
    const dateFromStr = dateFrom.toISOString().split('T')[0];

    // Account-level queries: aggregate across all campaign-level entities for this platform
    if (entityType === 'account' || !entityId) {
      const query = `
        SELECT
          metric_date,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(spend_cents) as spend_cents,
          SUM(conversions) as conversions,
          SUM(conversion_value_cents) as conversion_value_cents,
          CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) * 100 ELSE 0 END as ctr,
          CASE WHEN SUM(clicks) > 0 THEN SUM(spend_cents) / SUM(clicks) ELSE 0 END as cpc_cents,
          CASE WHEN SUM(impressions) > 0 THEN SUM(spend_cents) * 1000.0 / SUM(impressions) ELSE 0 END as cpm_cents,
          NULL as extra_metrics
        FROM ad_metrics
        WHERE organization_id = ?
          AND platform = ?
          AND entity_type = 'campaign'
          AND metric_date >= ?
        GROUP BY metric_date
        ORDER BY metric_date DESC
      `;
      return { query, params: [orgId, platform, dateFromStr] };
    }

    const query = `
      SELECT
        metric_date,
        impressions,
        clicks,
        spend_cents,
        conversions,
        conversion_value_cents,
        ctr,
        cpc_cents,
        cpm_cents,
        extra_metrics
      FROM ad_metrics
      WHERE organization_id = ?
        AND platform = ?
        AND entity_type = ?
        AND entity_ref = ?
        AND metric_date >= ?
      ORDER BY metric_date DESC
    `;

    return {
      query,
      params: [orgId, platform, unifiedEntityType[entityType] || entityType, entityId, dateFromStr]
    };
  }

  /**
   * Get ENTITY table info (for getCreativeDetails, getAudienceBreakdown)
   * UPDATED: Now uses unified tables (ad_campaigns, ad_groups, ads) for all platforms
   * Falls back to legacy platform-specific tables for backward compatibility
   */
  private getEntityTableInfo(platform: string, entityType: string): { table: string; idColumn: string; unified: boolean } | null {
    // All platforms use unified tables — no legacy fallback
    const unifiedTables: Record<string, { table: string; idColumn: string }> = {
      ad: { table: 'ads', idColumn: 'ad_id' },
      adset: { table: 'ad_groups', idColumn: 'ad_group_id' },
      ad_group: { table: 'ad_groups', idColumn: 'ad_group_id' },
      campaign: { table: 'ad_campaigns', idColumn: 'campaign_id' }
    };

    if (unifiedTables[entityType]) {
      return { ...unifiedTables[entityType], unified: true };
    }

    return null;
  }

  /**
   * Build unified entity query (for getCreativeDetails, etc.)
   */
  private buildUnifiedEntityQuery(
    platform: string,
    entityType: string,
    entityId: string,
    orgId: string
  ): { query: string; params: any[] } | null {
    const tableMap: Record<string, { table: string; idColumn: string }> = {
      ad: { table: 'ads', idColumn: 'ad_id' },
      adset: { table: 'ad_groups', idColumn: 'ad_group_id' },
      campaign: { table: 'ad_campaigns', idColumn: 'campaign_id' }
    };

    const tableInfo = tableMap[entityType];
    if (!tableInfo) return null;

    const query = `
      SELECT *
      FROM ${tableInfo.table}
      WHERE organization_id = ?
        AND platform = ?
        AND ${tableInfo.idColumn} = ?
    `;

    return {
      query,
      params: [orgId, platform, entityId]
    };
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

  // ========================================================================
  // NEW UNIFIED DATA ACCESS TOOLS
  // Added as part of AI-to-unified-data wiring (Jan 2026)
  // ========================================================================

  /**
   * Query clickstream events from D1
   * Supports daily_metrics, conversions, and hourly_metrics tables
   */
  private async queryEvents(
    input: QueryEventsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { event_types, days, page_paths, goal_ids, group_by, include_sessions } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      const response: any = {
        days,
        filters: { event_types, page_paths, goal_ids }
      };

      // Query daily metrics for overall event counts
      const dailyResult = await this.db.prepare(`
        SELECT
          date,
          SUM(total_visits) as page_views,
          SUM(unique_visitors) as unique_visitors,
          SUM(total_conversions) as conversions,
          SUM(total_conversion_value) as conversion_value_cents
        FROM daily_metrics
        WHERE organization_id = ?
          AND date >= ?
        GROUP BY date
        ORDER BY date DESC
      `).bind(orgId, startStr).all<{
        date: string;
        page_views: number;
        unique_visitors: number;
        conversions: number;
        conversion_value_cents: number;
      }>();

      response.daily_summary = dailyResult.results || [];

      // Query conversions from unified conversions table
      if (goal_ids?.length || event_types?.includes('goal_completed')) {
        let goalQuery = `
          SELECT
            conversion_source as goal_id,
            conversion_source as goal_name,
            COUNT(*) as conversion_count,
            COALESCE(SUM(value_cents), 0) as total_value_cents
          FROM conversions
          WHERE organization_id = ?
            AND conversion_timestamp >= ?
        `;
        const params: any[] = [orgId, startStr + 'T00:00:00Z'];

        if (goal_ids?.length) {
          goalQuery += ` AND conversion_source IN (${goal_ids.map(() => '?').join(',')})`;
          params.push(...goal_ids);
        }

        goalQuery += ' GROUP BY conversion_source';

        const goalResult = await this.db.prepare(goalQuery).bind(...params).all<{
          goal_id: string;
          goal_name: string | null;
          conversion_count: number;
          total_value_cents: number | null;
        }>();

        response.goal_conversions = (goalResult.results || []).map(r => ({
          goal_id: r.goal_id,
          goal_name: r.goal_name,
          conversions: r.conversion_count,
          value: r.total_value_cents ? '$' + (r.total_value_cents / 100).toFixed(2) : '$0.00'
        }));
      }

      // Include session data if requested
      if (include_sessions) {
        const sessionResult = await this.db.prepare(`
          SELECT
            COUNT(DISTINCT session_id) as total_sessions,
            SUM(total_visits) as total_page_views,
            ROUND(AVG(total_visits * 1.0 / NULLIF(unique_visitors, 0)), 2) as avg_pages_per_visitor
          FROM daily_metrics
          WHERE organization_id = ?
            AND date >= ?
        `).bind(orgId, startStr).first<{
          total_sessions: number;
          total_page_views: number;
          avg_pages_per_visitor: number | null;
        }>();

        response.session_stats = sessionResult || { total_sessions: 0, total_page_views: 0, avg_pages_per_visitor: null };
      }

      // Calculate summary
      const daily = response.daily_summary || [];
      response.summary = {
        total_page_views: daily.reduce((sum: number, d: any) => sum + (d.page_views || 0), 0),
        total_unique_visitors: daily.reduce((sum: number, d: any) => sum + (d.unique_visitors || 0), 0),
        total_conversions: daily.reduce((sum: number, d: any) => sum + (d.conversions || 0), 0),
        total_conversion_value: '$' + (daily.reduce((sum: number, d: any) => sum + (d.conversion_value_cents || 0), 0) / 100).toFixed(2),
        days_with_data: daily.length
      };

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Query CRM pipeline data from connector_events
   * All CRM data flows through connector_events with source_platform = 'hubspot' etc.
   */
  private async queryCrmPipeline(
    input: QueryCrmPipelineInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, stages, status, min_value_cents, include_attribution, group_by } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Query connector_events for CRM deals
      let query = `
        SELECT
          id, source_platform, external_id, event_type,
          status, value_cents, metadata, transacted_at
        FROM connector_events
        WHERE organization_id = ?
          AND event_type = 'deal'
          AND transacted_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (status && status !== 'all') {
        // Map deal status to status values
        const statusMap: Record<string, string[]> = {
          won: ['closedwon', 'won'],
          lost: ['closedlost', 'lost'],
          open: ['open', 'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent']
        };
        const statuses = statusMap[status] || [status];
        query += ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }

      if (min_value_cents) {
        query += ' AND value_cents >= ?';
        params.push(min_value_cents);
      }

      query += ' ORDER BY transacted_at DESC LIMIT 500';

      const result = await this.db.prepare(query).bind(...params).all<{
        id: string;
        source_platform: string;
        external_id: string;
        event_type: string;
        status: string;
        value_cents: number | null;
        metadata: string | null;
        transacted_at: string;
      }>();

      const deals = result.results || [];

      // Parse metadata for deal details
      const parseDealMeta = (meta: string | null) => {
        if (!meta) return {};
        try { return JSON.parse(meta); } catch { return {}; }
      };

      // Map status to simplified status
      const normalizeStatus = (ps: string): string => {
        if (['closedwon', 'won'].includes(ps)) return 'won';
        if (['closedlost', 'lost'].includes(ps)) return 'lost';
        return 'open';
      };

      const enriched = deals.map(d => {
        const meta = parseDealMeta(d.metadata);
        return {
          ...d,
          deal_name: meta.deal_name || meta.dealname || d.external_id,
          stage: meta.dealstage || meta.stage || d.status,
          normalized_status: normalizeStatus(d.status),
          owner_name: meta.hubspot_owner_id || meta.owner_name || null,
          source: meta.source || null,
          utm_source: meta.utm_source || null,
          utm_campaign: meta.utm_campaign || null,
        };
      });

      // Apply stage filter in-memory (stage is in metadata)
      const filtered = stages?.length
        ? enriched.filter(d => stages.some(s => d.stage.toLowerCase().includes(s.toLowerCase())))
        : enriched;

      const summary = {
        total_deals: filtered.length,
        total_value: '$' + (filtered.reduce((sum, d) => sum + (d.value_cents || 0), 0) / 100).toFixed(2),
        won_deals: filtered.filter(d => d.normalized_status === 'won').length,
        won_value: '$' + (filtered.filter(d => d.normalized_status === 'won').reduce((sum, d) => sum + (d.value_cents || 0), 0) / 100).toFixed(2),
        lost_deals: filtered.filter(d => d.normalized_status === 'lost').length,
        open_deals: filtered.filter(d => d.normalized_status === 'open').length
      };

      // Group by dimension if requested
      let grouped: any = null;
      if (group_by) {
        const groups = new Map<string, { count: number; value_cents: number }>();

        for (const deal of filtered) {
          let key: string;
          switch (group_by) {
            case 'day': key = deal.transacted_at.split('T')[0]; break;
            case 'stage': key = deal.stage || 'unknown'; break;
            case 'source': key = deal.source || deal.utm_source || 'unknown'; break;
            case 'owner': key = deal.owner_name || 'unassigned'; break;
            default: key = 'all';
          }

          if (!groups.has(key)) groups.set(key, { count: 0, value_cents: 0 });
          const entry = groups.get(key)!;
          entry.count += 1;
          entry.value_cents += deal.value_cents || 0;
        }

        grouped = Array.from(groups.entries()).map(([key, data]) => ({
          [group_by]: key,
          deals: data.count,
          value: '$' + (data.value_cents / 100).toFixed(2)
        }));
      }

      const response: any = {
        days,
        filters: { stages, status, min_value_cents },
        summary,
        deals: filtered.slice(0, 50).map(d => ({
          deal_id: d.external_id,
          name: d.deal_name,
          stage: d.stage,
          status: d.normalized_status,
          platform_status: d.status,
          value: d.value_cents ? '$' + (d.value_cents / 100).toFixed(2) : null,
          owner: d.owner_name,
          created_at: d.transacted_at,
          ...(include_attribution ? {
            source: d.source,
            utm_source: d.utm_source,
            utm_campaign: d.utm_campaign
          } : {})
        }))
      };

      if (grouped) response.grouped = grouped;

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'connector_events table not yet created', summary: { total_deals: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query unified data from any connector type
   * Supports ad_platform, payments, ecommerce, crm, etc.
   */
  private async queryUnifiedData(
    input: QueryUnifiedDataInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    // LLM sometimes sends "connector" instead of "connector_type" — normalize
    const connector_type = input.connector_type || (input as any).connector;
    const { platform, days, metrics, group_by } = input;

    if (!connector_type) {
      return { success: false, error: 'Missing required parameter "connector_type". Valid types: ad_platform, payments, ecommerce, crm, communication, field_service' };
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      let response: any = {
        connector_type,
        platform: platform || 'all',
        days
      };

      switch (connector_type) {
        case 'ad_platform': {
          // Query unified ad_metrics table
          let query = `
            SELECT
              platform,
              SUM(impressions) as impressions,
              SUM(clicks) as clicks,
              SUM(spend_cents) as spend_cents,
              SUM(conversions) as conversions,
              SUM(conversion_value_cents) as conversion_value_cents
            FROM ad_metrics
            WHERE organization_id = ?
              AND entity_type = 'campaign'
              AND metric_date >= ?
          `;
          const params: any[] = [orgId, startStr];

          if (platform) {
            query += ' AND platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY platform';

          const result = await this.db.prepare(query).bind(...params).all<{
            platform: string;
            impressions: number;
            clicks: number;
            spend_cents: number;
            conversions: number;
            conversion_value_cents: number;
          }>();

          response.platforms = (result.results || []).map(r => ({
            platform: r.platform,
            impressions: r.impressions,
            clicks: r.clicks,
            spend: '$' + (r.spend_cents / 100).toFixed(2),
            conversions: r.conversions,
            conversion_value: '$' + (r.conversion_value_cents / 100).toFixed(2),
            ctr: r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(2) + '%' : '0%',
            cpc: r.clicks > 0 ? '$' + ((r.spend_cents / 100) / r.clicks).toFixed(2) : '$0'
          }));
          break;
        }

        case 'payments':
        case 'ecommerce': {
          // Query conversions table for revenue data
          let query = `
            SELECT
              source_platform,
              COUNT(*) as count,
              SUM(value_cents) as total_cents
            FROM conversions
            WHERE organization_id = ?
              AND created_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND source_platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY source_platform';

          const result = await this.db.prepare(query).bind(...params).all<{
            source_platform: string;
            count: number;
            total_cents: number | null;
          }>();

          response.sources = (result.results || []).map(r => ({
            source: r.source_platform,
            conversions: r.count,
            revenue: '$' + ((r.total_cents || 0) / 100).toFixed(2)
          }));
          break;
        }

        case 'crm': {
          // Query connector_events for CRM deals
          let query = `
            SELECT
              source_platform,
              COUNT(*) as deals,
              SUM(CASE WHEN status IN ('closedwon', 'won') THEN 1 ELSE 0 END) as won,
              SUM(value_cents) as total_value_cents
            FROM connector_events
            WHERE organization_id = ?
              AND event_type = 'deal'
              AND transacted_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND source_platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY source_platform';

          const result = await this.db.prepare(query).bind(...params).all<{
            source_platform: string;
            deals: number;
            won: number;
            total_value_cents: number | null;
          }>();

          response.platforms = (result.results || []).map(r => ({
            platform: r.source_platform,
            total_deals: r.deals,
            won_deals: r.won,
            total_value: '$' + ((r.total_value_cents || 0) / 100).toFixed(2),
            win_rate: r.deals > 0 ? ((r.won / r.deals) * 100).toFixed(0) + '%' : '0%'
          }));
          break;
        }

        case 'communication': {
          // Query connector_events for email/SMS engagement data
          let query = `
            SELECT
              source_platform,
              COUNT(*) as events,
              SUM(CASE WHEN event_type IN ('email_sent', 'sms_sent', 'campaign_sent') THEN 1 ELSE 0 END) as sent,
              SUM(CASE WHEN event_type IN ('email_open', 'sms_open') THEN 1 ELSE 0 END) as opens,
              SUM(CASE WHEN event_type IN ('email_click', 'sms_click', 'link_click') THEN 1 ELSE 0 END) as clicks
            FROM connector_events
            WHERE organization_id = ?
              AND source_platform IN ('sendgrid', 'attentive', 'mailchimp', 'tracking_link')
              AND transacted_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND source_platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY source_platform';

          try {
            const result = await this.db.prepare(query).bind(...params).all<{
              source_platform: string;
              events: number;
              sent: number;
              opens: number;
              clicks: number;
            }>();

            response.platforms = (result.results || []).map(r => ({
              platform: r.source_platform,
              events: r.events,
              sent: r.sent,
              opens: r.opens,
              clicks: r.clicks,
              open_rate: r.sent ? ((r.opens / r.sent) * 100).toFixed(1) + '%' : '0%'
            }));
          } catch {
            response.platforms = [];
            response.note = 'No communication data available';
          }
          break;
        }

        case 'field_service': {
          // Query connector_events for field service data (Jobber jobs/invoices)
          let query = `
            SELECT
              COUNT(*) as events,
              SUM(value_cents) as revenue_cents,
              COUNT(DISTINCT customer_external_id) as customers
            FROM connector_events
            WHERE organization_id = ?
              AND source_platform = 'jobber'
              AND transacted_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          try {
            const result = await this.db.prepare(query).bind(...params).first<{
              events: number;
              revenue_cents: number | null;
              customers: number;
            }>();

            response.summary = {
              events: result?.events || 0,
              revenue: '$' + ((result?.revenue_cents || 0) / 100).toFixed(2),
              unique_customers: result?.customers || 0
            };
          } catch {
            response.summary = { events: 0, revenue: '$0.00', unique_customers: 0 };
            response.note = 'No field service data available';
          }
          break;
        }

        default:
          return { success: false, error: `Unsupported connector type: ${connector_type}` };
      }

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * List active connectors for an organization
   * Returns which data sources have data available
   */
  private async listActiveConnectors(
    input: ListActiveConnectorsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { connector_type, include_data_stats } = input;

    try {
      const connectors: Array<{
        type: string;
        platform: string;
        has_data: boolean;
        record_count?: number;
        last_sync?: string;
      }> = [];

      // Type mapping from source_platform to connector type
      const platformTypeMap: Record<string, string> = {
        stripe: 'payments', shopify: 'ecommerce', jobber: 'field_service',
        hubspot: 'crm', salesforce: 'crm',
        sendgrid: 'communication', attentive: 'communication', mailchimp: 'communication',
        zendesk: 'support', intercom: 'support',
        calendly: 'scheduling', acuity: 'scheduling',
        typeform: 'forms', jotform: 'forms',
        quickbooks: 'accounting', xero: 'accounting',
        trustpilot: 'reviews', g2: 'reviews',
        tracking_link: 'tracking',
      };

      // 1. Check ad platforms (unified ad_campaigns table)
      if (!connector_type || connector_type === 'all' || connector_type === 'ad_platform') {
        const adResult = await this.db.prepare(`
          SELECT platform, COUNT(*) as count, MAX(last_synced_at) as last_sync
          FROM ad_campaigns
          WHERE organization_id = ?
          GROUP BY platform
        `).bind(orgId).all<{ platform: string; count: number; last_sync: string | null }>();

        for (const r of adResult.results || []) {
          connectors.push({
            type: 'ad_platform',
            platform: r.platform,
            has_data: r.count > 0,
            ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
          });
        }
      }

      // 2. Check all connector types via connector_events (single query)
      {
        const ceResult = await this.db.prepare(`
          SELECT source_platform, COUNT(*) as count, MAX(transacted_at) as last_sync
          FROM connector_events
          WHERE organization_id = ?
          GROUP BY source_platform
        `).bind(orgId).all<{ source_platform: string; count: number; last_sync: string | null }>();

        for (const r of ceResult.results || []) {
          const type = platformTypeMap[r.source_platform] || 'other';
          if (connector_type && connector_type !== 'all' && connector_type !== type) continue;
          if (r.count > 0 && !connectors.some(c => c.platform === r.source_platform)) {
            connectors.push({
              type,
              platform: r.source_platform,
              has_data: true,
              ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
            });
          }
        }
      }

      // 3. Check revenue sources via conversions table
      if (!connector_type || connector_type === 'all' || connector_type === 'payments' || connector_type === 'ecommerce') {
        const revenueResult = await this.db.prepare(`
          SELECT conversion_source as source, COUNT(*) as count, MAX(conversion_timestamp) as last_sync
          FROM conversions
          WHERE organization_id = ?
          GROUP BY conversion_source
        `).bind(orgId).all<{ source: string; count: number; last_sync: string | null }>();

        for (const r of revenueResult.results || []) {
          if (!connectors.some(c => c.platform === r.source)) {
            connectors.push({
              type: ['shopify'].includes(r.source) ? 'ecommerce' : 'payments',
              platform: r.source,
              has_data: r.count > 0,
              ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
            });
          }
        }
      }

      // 4. Check events/tag (daily_metrics uses org_tag, not organization_id)
      if (!connector_type || connector_type === 'all') {
        try {
          const orgTag = await this.resolveOrgTag(orgId);
          if (orgTag) {
            const eventsResult = await this.db.prepare(`
              SELECT COUNT(*) as count, MAX(date) as last_date
              FROM daily_metrics
              WHERE org_tag = ?
            `).bind(orgTag).first<{ count: number; last_date: string | null }>();

            if (eventsResult && eventsResult.count > 0) {
              connectors.push({
                type: 'events',
                platform: 'clearlift_tag',
                has_data: true,
                ...(include_data_stats ? { record_count: eventsResult.count, last_sync: eventsResult.last_date || undefined } : {})
              });
            }
          }
        } catch { /* table doesn't exist */ }
      }

      // 5. Check customer identities
      if (!connector_type || connector_type === 'all') {
        try {
          const idResult = await this.db.prepare(`
            SELECT COUNT(*) as count, MAX(updated_at) as last_sync
            FROM customer_identities
            WHERE organization_id = ?
          `).bind(orgId).first<{ count: number; last_sync: string | null }>();

          if (idResult && idResult.count > 0) {
            connectors.push({
              type: 'identity',
              platform: 'clearlift_identity',
              has_data: true,
              ...(include_data_stats ? { record_count: idResult.count, last_sync: idResult.last_sync || undefined } : {})
            });
          }
        } catch { /* table doesn't exist */ }
      }

      return {
        success: true,
        data: {
          organization_id: orgId,
          total_connectors: connectors.length,
          connectors: connectors.sort((a, b) => a.type.localeCompare(b.type))
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  // ========================================================================
  // ADVANCED ANALYTICS TOOL EXECUTORS
  // ========================================================================

  /**
   * Resolve org_tag from org_tag_mappings for a given organization
   */
  private async resolveOrgTag(orgId: string): Promise<string | null> {
    try {
      const db = this.coreDb || this.db;
      const row = await db.prepare(
        'SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1'
      ).bind(orgId).first<{ short_tag: string }>();
      return row?.short_tag || null;
    } catch {
      return null;
    }
  }

  /**
   * Query journey/funnel analytics: channel distribution, paths, transitions
   */
  private async queryJourneyAnalytics(
    input: QueryJourneyAnalyticsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { include_paths = true, include_transitions = false, top_n = 10 } = input;

    try {
      const orgTag = await this.resolveOrgTag(orgId);
      if (!orgTag) {
        return { success: true, data: { note: 'No org_tag configured — journey analytics unavailable', sessions: 0 } };
      }

      const row = await this.db.prepare(`
        SELECT total_sessions, converting_sessions, conversion_rate,
               avg_path_length, channel_distribution, common_paths, transition_matrix,
               computed_at
        FROM journey_analytics
        WHERE org_tag = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `).bind(orgTag).first<{
        total_sessions: number;
        converting_sessions: number;
        conversion_rate: number;
        avg_path_length: number;
        channel_distribution: string | null;
        common_paths: string | null;
        transition_matrix: string | null;
        computed_at: string;
      }>();

      if (!row) {
        return { success: true, data: { note: 'No journey analytics data computed yet', sessions: 0 } };
      }

      const channels = row.channel_distribution ? JSON.parse(row.channel_distribution) : {};
      const sortedChannels = Object.entries(channels)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, top_n)
        .map(([channel, count]) => ({ channel, sessions: count }));

      const result: any = {
        total_sessions: row.total_sessions,
        converting_sessions: row.converting_sessions,
        conversion_rate: row.conversion_rate,
        avg_path_length: row.avg_path_length,
        top_channels: sortedChannels,
        computed_at: row.computed_at
      };

      if (include_paths && row.common_paths) {
        const paths = JSON.parse(row.common_paths);
        result.top_paths = Array.isArray(paths) ? paths.slice(0, top_n) : paths;
      }

      if (include_transitions && row.transition_matrix) {
        result.transition_matrix = JSON.parse(row.transition_matrix);
      }

      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'journey_analytics table not yet created', sessions: 0 } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query flow insights: per-stage visitors, dropoff, bottleneck
   */
  private async queryFlowInsights(
    input: QueryFlowInsightsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { goal_id } = input;

    try {
      const orgTag = await this.resolveOrgTag(orgId);
      if (!orgTag) {
        return { success: true, data: { note: 'No org_tag configured — flow insights unavailable', stages: [] } };
      }

      // Get latest journey analytics
      const journey = await this.db.prepare(`
        SELECT total_sessions, converting_sessions, channel_distribution, computed_at
        FROM journey_analytics
        WHERE org_tag = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `).bind(orgTag).first<{
        total_sessions: number;
        converting_sessions: number;
        channel_distribution: string | null;
        computed_at: string;
      }>();

      if (!journey) {
        return { success: true, data: { note: 'No journey data available', stages: [] } };
      }

      // Get conversion config from platform_connections (in coreDb / DB)
      const pcDb = this.coreDb || this.db;
      let goalSql = `
        SELECT id, provider, platform, display_name, settings
        FROM platform_connections
        WHERE organization_id = ? AND status = 'active'
          AND json_array_length(json_extract(settings, '$.conversion_events')) > 0
      `;
      const goalParams: any[] = [orgId];
      if (goal_id) {
        goalSql += ' AND id = ?';
        goalParams.push(goal_id);
      }

      const goalsResult = await pcDb.prepare(goalSql).bind(...goalParams).all<{
        id: string;
        provider: string;
        platform: string;
        display_name: string | null;
        settings: string | null;
      }>();

      // Map platform_connections to goal-like objects for the AI
      const goals = (goalsResult.results || []).map(r => ({
        id: r.id,
        goal_name: r.display_name || r.platform,
        goal_type: 'conversion',
        event_type: r.platform,
        configuration: r.settings,
      }));
      const totalSessions = journey.total_sessions || 1;

      // Query real page flow data from funnel_transitions (daily aggregates)
      const days = 30;
      const pageFlowResult = await this.db.prepare(`
        SELECT to_id as page,
               SUM(visitors_transitioned) as visitors,
               SUM(conversions) as conversions,
               SUM(revenue_cents) as revenue_cents
        FROM funnel_transitions
        WHERE org_tag = ?
          AND from_type = 'page_url' AND to_type = 'page_url'
          AND period_start >= date('now', '-' || ? || ' days')
        GROUP BY to_id
        ORDER BY visitors DESC
        LIMIT 20
      `).bind(orgTag, days).all<{
        page: string;
        visitors: number;
        conversions: number;
        revenue_cents: number;
      }>();

      const topSourcesResult = await this.db.prepare(`
        SELECT from_id as source, from_type,
               SUM(visitors_transitioned) as visitors,
               SUM(conversions) as conversions
        FROM funnel_transitions
        WHERE org_tag = ? AND from_type IN ('source','referrer') AND to_type = 'page_url'
          AND period_start >= date('now', '-' || ? || ' days')
        GROUP BY from_id, from_type
        ORDER BY visitors DESC
        LIMIT 10
      `).bind(orgTag, days).all<{
        source: string;
        from_type: string;
        visitors: number;
        conversions: number;
      }>();

      const pageFlowPages = pageFlowResult.results || [];
      const topSources = topSourcesResult.results || [];

      let stages: Array<{
        page: string;
        visitors: number;
        conversions: number;
        revenue_cents: number;
        dropoff_rate: number;
        conversion_rate: number;
      }>;
      let bottleneck: { page: string; dropoff_rate: number } | null = null;

      if (pageFlowPages.length > 0) {
        // Build stages from real page data
        stages = pageFlowPages.map((p, idx) => {
          const nextVisitors = idx + 1 < pageFlowPages.length ? pageFlowPages[idx + 1].visitors : 0;
          const dropoffRate = p.visitors > 0
            ? ((p.visitors - nextVisitors) / p.visitors * 100)
            : 0;
          const conversionRate = p.visitors > 0
            ? Math.round((p.conversions / p.visitors) * 1000) / 10
            : 0;
          return {
            page: p.page,
            visitors: p.visitors,
            conversions: p.conversions,
            revenue_cents: p.revenue_cents,
            dropoff_rate: Math.round(dropoffRate * 10) / 10,
            conversion_rate: conversionRate,
          };
        });

        // Bottleneck: page with highest traffic-to-next-page dropoff (excluding last page)
        const stagesForBottleneck = stages.slice(0, -1);
        if (stagesForBottleneck.length > 0) {
          bottleneck = stagesForBottleneck.reduce(
            (max, s) => s.dropoff_rate > max.dropoff_rate ? { page: s.page, dropoff_rate: s.dropoff_rate } : max,
            { page: stagesForBottleneck[0].page, dropoff_rate: stagesForBottleneck[0].dropoff_rate }
          );
        }
      } else {
        // Fallback: decay model when no funnel_transitions data exists
        stages = goals.map((goal, idx) => {
          const decayFactor = Math.pow(0.6, idx);
          const estimatedVisitors = Math.round(totalSessions * decayFactor);
          const nextVisitors = idx < goals.length - 1
            ? Math.round(totalSessions * Math.pow(0.6, idx + 1))
            : journey.converting_sessions;
          const dropoffRate = estimatedVisitors > 0
            ? ((estimatedVisitors - nextVisitors) / estimatedVisitors * 100)
            : 0;
          return {
            page: goal.goal_name,
            visitors: estimatedVisitors,
            conversions: 0,
            revenue_cents: 0,
            dropoff_rate: Math.round(dropoffRate * 10) / 10,
            conversion_rate: totalSessions > 0
              ? Math.round((nextVisitors / totalSessions) * 1000) / 10
              : 0,
          };
        });
      }

      return {
        success: true,
        data: {
          total_sessions: journey.total_sessions,
          converting_sessions: journey.converting_sessions,
          overall_conversion_rate: journey.total_sessions > 0
            ? Math.round((journey.converting_sessions / journey.total_sessions) * 1000) / 10
            : 0,
          stages,
          top_sources: topSources.map(s => ({
            source: s.source,
            type: s.from_type,
            visitors: s.visitors,
            conversions: s.conversions,
          })),
          bottleneck_page: bottleneck,
          goals: goals.map(g => ({ id: g.id, name: g.goal_name, type: g.event_type })),
          computed_at: journey.computed_at,
          data_source: pageFlowPages.length > 0 ? 'funnel_transitions' : 'estimated',
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Required tables not yet created', stages: [] } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query CAC timeline with optional predictions and baselines
   */
  private async queryCacTimeline(
    input: QueryCacTimelineInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days = 14, include_predictions = false, include_baselines = false } = input;

    const db = this.db;
    if (!db) {
      return { success: false, error: 'Analytics database not available for CAC queries' };
    }

    try {
      // Query CAC history
      const historyResult = await db.prepare(`
        SELECT date, cac_cents, spend_cents, conversions
        FROM cac_history
        WHERE organization_id = ?
        ORDER BY date DESC
        LIMIT ?
      `).bind(orgId, days).all<{
        date: string;
        cac_cents: number;
        spend_cents: number;
        conversions: number;
      }>();

      const history = (historyResult.results || []).reverse();

      if (history.length === 0) {
        return { success: true, data: { note: 'No CAC history available', timeline: [] } };
      }

      // Calculate trend
      const currentCac = history[history.length - 1].cac_cents;
      const oldestCac = history[0].cac_cents;
      const trendPct = oldestCac > 0
        ? Math.round(((currentCac - oldestCac) / oldestCac) * 1000) / 10
        : 0;

      const cacValues = history.map(h => h.cac_cents);
      const minCac = Math.min(...cacValues);
      const maxCac = Math.max(...cacValues);

      // Week-over-week
      let wowChange = 0;
      if (history.length >= 8) {
        const recentWeek = history.slice(-7);
        const prevWeek = history.slice(-14, -7);
        const recentAvg = recentWeek.reduce((s, h) => s + h.cac_cents, 0) / recentWeek.length;
        const prevAvg = prevWeek.reduce((s, h) => s + h.cac_cents, 0) / prevWeek.length;
        wowChange = prevAvg > 0 ? Math.round(((recentAvg - prevAvg) / prevAvg) * 1000) / 10 : 0;
      }

      const result: any = {
        timeline: history.map(h => ({
          date: h.date,
          cac: '$' + (h.cac_cents / 100).toFixed(2),
          cac_cents: h.cac_cents,
          spend: '$' + (h.spend_cents / 100).toFixed(2),
          conversions: h.conversions
        })),
        summary: {
          current_cac: '$' + (currentCac / 100).toFixed(2),
          current_cac_cents: currentCac,
          trend_pct: trendPct,
          trend_direction: trendPct > 2 ? 'increasing' : trendPct < -2 ? 'decreasing' : 'stable',
          min_cac: '$' + (minCac / 100).toFixed(2),
          max_cac: '$' + (maxCac / 100).toFixed(2),
          week_over_week_pct: wowChange,
          data_points: history.length
        }
      };

      if (include_predictions) {
        try {
          // cac_predictions is in DB (coreDb), not ANALYTICS_DB
          const predDb = this.coreDb || this.db;
          const predsResult = await predDb.prepare(`
            SELECT prediction_date, predicted_cac_cents, assumptions
            FROM cac_predictions
            WHERE organization_id = ?
              AND prediction_date >= date('now')
            ORDER BY prediction_date ASC
            LIMIT 7
          `).bind(orgId).all<{
            prediction_date: string;
            predicted_cac_cents: number;
            assumptions: string | null;
          }>();
          result.predictions = (predsResult.results || []).map(p => ({
            date: p.prediction_date,
            predicted_cac: '$' + (p.predicted_cac_cents / 100).toFixed(2),
            predicted_cac_cents: p.predicted_cac_cents,
            assumptions: p.assumptions ? JSON.parse(p.assumptions) : null
          }));
        } catch {
          result.predictions = [];
        }
      }

      if (include_baselines) {
        try {
          // cac_baselines is in DB (coreDb), not ANALYTICS_DB
          const basDb = this.coreDb || this.db;
          const basResult = await basDb.prepare(`
            SELECT baseline_cac_cents, calculation_method
            FROM cac_baselines
            WHERE organization_id = ?
            ORDER BY created_at DESC
            LIMIT 5
          `).bind(orgId).all<{
            baseline_cac_cents: number;
            calculation_method: string;
          }>();
          result.baselines = (basResult.results || []).map(b => ({
            target_cac: '$' + (b.baseline_cac_cents / 100).toFixed(2),
            target_cac_cents: b.baseline_cac_cents,
            type: b.calculation_method
          }));
        } catch {
          result.baselines = [];
        }
      }

      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'CAC tables not yet created', timeline: [] } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query recent site traffic from hourly/daily metrics
   */
  private async queryRealtimeTraffic(
    input: QueryRealtimeTrafficInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { hours = 24, breakdown } = input;

    try {
      const orgTag = await this.resolveOrgTag(orgId);
      if (!orgTag) {
        return { success: true, data: { note: 'No org_tag configured — traffic data unavailable', sessions: 0 } };
      }

      // Try hourly_metrics first for recent data
      let rows: Array<{
        hour?: string;
        date?: string;
        sessions: number;
        users: number;
        page_views: number;
        conversions: number;
        revenue_cents: number;
        by_channel?: string | null;
        by_device?: string | null;
        by_geo?: string | null;
        by_utm_source?: string | null;
      }> = [];

      try {
        const hourlyResult = await this.db.prepare(`
          SELECT hour, sessions, users, page_views, conversions, revenue_cents,
                 by_channel, by_device, by_geo, by_utm_source
          FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-${Math.min(hours, 168)} hours')
          ORDER BY hour DESC
        `).bind(orgTag).all<any>();
        rows = hourlyResult.results || [];
      } catch {
        // hourly_metrics may not exist, fall back to daily_metrics
      }

      // Fall back to daily_metrics if no hourly data
      if (rows.length === 0) {
        const dailyDays = Math.ceil(hours / 24);
        try {
          const dailyResult = await this.db.prepare(`
            SELECT date, sessions, users, page_views, conversions, revenue_cents,
                   by_channel, by_device, by_geo, by_utm_source
            FROM daily_metrics
            WHERE org_tag = ?
              AND date >= date('now', '-${dailyDays} days')
            ORDER BY date DESC
          `).bind(orgTag).all<any>();
          rows = dailyResult.results || [];
        } catch {
          return { success: true, data: { note: 'Traffic metrics tables not yet created', sessions: 0 } };
        }
      }

      if (rows.length === 0) {
        return { success: true, data: { note: 'No recent traffic data', sessions: 0 } };
      }

      // Aggregate totals
      const totals = {
        sessions: 0,
        users: 0,
        page_views: 0,
        conversions: 0,
        revenue_cents: 0
      };
      for (const row of rows) {
        totals.sessions += row.sessions || 0;
        totals.users += row.users || 0;
        totals.page_views += row.page_views || 0;
        totals.conversions += row.conversions || 0;
        totals.revenue_cents += row.revenue_cents || 0;
      }

      const result: any = {
        period_hours: hours,
        data_points: rows.length,
        summary: {
          sessions: totals.sessions,
          users: totals.users,
          page_views: totals.page_views,
          conversions: totals.conversions,
          revenue: '$' + (totals.revenue_cents / 100).toFixed(2),
          conversion_rate: totals.sessions > 0
            ? Math.round((totals.conversions / totals.sessions) * 1000) / 10
            : 0
        }
      };

      // Add breakdown if requested
      if (breakdown) {
        const columnMap: Record<string, string> = {
          channel: 'by_channel',
          device: 'by_device',
          geo: 'by_geo',
          utm_source: 'by_utm_source'
        };
        const col = columnMap[breakdown];
        if (col) {
          const aggregated: Record<string, number> = {};
          for (const row of rows) {
            const jsonCol = (row as any)[col];
            if (jsonCol) {
              try {
                const parsed = JSON.parse(jsonCol);
                for (const [key, val] of Object.entries(parsed)) {
                  aggregated[key] = (aggregated[key] || 0) + (val as number);
                }
              } catch { /* skip malformed JSON */ }
            }
          }

          result.breakdown = {
            dimension: breakdown,
            values: Object.entries(aggregated)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 15)
              .map(([key, count]) => ({ [breakdown]: key, sessions: count }))
          };
        }
      }

      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Traffic metrics tables not yet created', sessions: 0 } };
      }
      return { success: false, error: msg };
    }
  }

  // ========================================================================
  // CONNECTOR-SPECIFIC TOOL EXECUTORS
  // ========================================================================

  /**
   * Query Shopify order revenue with full attribution
   */
  private async queryShopifyRevenue(
    input: QueryShopifyRevenueInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, group_by = 'day', filters, include_products = false, include_attribution = true } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      let sql = `
        SELECT external_id as shopify_order_id,
               value_cents as total_price_cents, currency,
               status as financial_status,
               customer_external_id,
               transacted_at as shopify_created_at,
               metadata
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform = 'shopify'
          AND transacted_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (filters?.financial_status) {
        sql += ' AND status = ?';
        params.push(filters.financial_status);
      }
      if (filters?.fulfillment_status) {
        // fulfillment_status may be in metadata JSON
        sql += " AND json_extract(metadata, '$.fulfillment_status') = ?";
        params.push(filters.fulfillment_status);
      }
      if (filters?.min_total_cents) {
        sql += ' AND value_cents >= ?';
        params.push(filters.min_total_cents);
      }
      if (filters?.max_total_cents) {
        sql += ' AND total_price_cents <= ?';
        params.push(filters.max_total_cents);
      }
      if (filters?.utm_source) {
        sql += ' AND utm_source = ?';
        params.push(filters.utm_source);
      }
      if (filters?.utm_campaign) {
        sql += ' AND utm_campaign = ?';
        params.push(filters.utm_campaign);
      }
      if (filters?.shipping_country) {
        sql += ' AND shipping_country = ?';
        params.push(filters.shipping_country);
      }

      sql += ' ORDER BY shopify_created_at DESC LIMIT 1000';

      const result = await this.db.prepare(sql).bind(...params).all<any>();
      const orders = result.results || [];

      if (orders.length === 0) {
        return { success: true, data: { time_series: [], summary: { total_revenue: '$0.00', total_orders: 0 }, note: 'No Shopify orders in period' } };
      }

      // Summary
      const totalRevenue = orders.reduce((s: number, o: any) => s + (o.total_price_cents || 0), 0);
      const totalDiscount = orders.reduce((s: number, o: any) => s + (o.total_discounts_cents || 0), 0);
      const totalShipping = orders.reduce((s: number, o: any) => s + (o.total_shipping_cents || 0), 0);
      const totalTax = orders.reduce((s: number, o: any) => s + (o.total_tax_cents || 0), 0);
      const uniqueCountries = new Set(orders.map((o: any) => o.shipping_country).filter(Boolean));
      const newCustomers = orders.filter((o: any) => (o.customer_orders_count || 0) <= 1).length;
      const returningCustomers = orders.length - newCustomers;

      const summary = {
        total_revenue: '$' + (totalRevenue / 100).toFixed(2),
        total_revenue_cents: totalRevenue,
        total_orders: orders.length,
        avg_order_value: '$' + (totalRevenue / 100 / orders.length).toFixed(2),
        avg_order_value_cents: Math.round(totalRevenue / orders.length),
        total_discounts: '$' + (totalDiscount / 100).toFixed(2),
        total_shipping: '$' + (totalShipping / 100).toFixed(2),
        total_tax: '$' + (totalTax / 100).toFixed(2),
        new_customers: newCustomers,
        returning_customers: returningCustomers,
        returning_customer_pct: orders.length > 0 ? Math.round(returningCustomers / orders.length * 100) : 0,
        unique_countries: uniqueCountries.size,
        total_items: orders.reduce((s: number, o: any) => s + (o.total_items_quantity || 0), 0)
      };

      // Group by dimension
      const grouped = new Map<string, { revenue_cents: number; count: number; items: number }>();
      for (const order of orders) {
        let key: string;
        const orderDate = (order.shopify_created_at || '').split('T')[0];
        switch (group_by) {
          case 'week': {
            const d = new Date(orderDate);
            const day = d.getDay();
            d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
            key = d.toISOString().split('T')[0];
            break;
          }
          case 'month':
            key = orderDate.substring(0, 7) + '-01';
            break;
          case 'utm_source':
            key = order.utm_source || '(direct)';
            break;
          case 'utm_campaign':
            key = order.utm_campaign || '(none)';
            break;
          case 'source_name':
            key = order.source_name || 'unknown';
            break;
          case 'shipping_country':
            key = order.shipping_country || 'unknown';
            break;
          default:
            key = orderDate;
        }
        if (!grouped.has(key)) grouped.set(key, { revenue_cents: 0, count: 0, items: 0 });
        const g = grouped.get(key)!;
        g.revenue_cents += order.total_price_cents || 0;
        g.count += 1;
        g.items += order.total_items_quantity || 0;
      }

      const timeSeries = Array.from(grouped.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, data]) => ({
          [group_by]: key,
          revenue: '$' + (data.revenue_cents / 100).toFixed(2),
          revenue_cents: data.revenue_cents,
          orders: data.count,
          items: data.items,
          aov: '$' + (data.count > 0 ? (data.revenue_cents / 100 / data.count).toFixed(2) : '0.00')
        }));

      const response: any = { summary, time_series: timeSeries };

      // Attribution breakdown
      if (include_attribution) {
        const bySource = new Map<string, { revenue_cents: number; orders: number }>();
        for (const order of orders) {
          let source = 'direct';
          if (order.gclid) source = 'google_ads';
          else if (order.fbclid) source = 'meta_ads';
          else if (order.ttclid) source = 'tiktok_ads';
          else if (order.utm_source) source = order.utm_source;
          else if (order.referring_site) source = 'referral';

          if (!bySource.has(source)) bySource.set(source, { revenue_cents: 0, orders: 0 });
          const s = bySource.get(source)!;
          s.revenue_cents += order.total_price_cents || 0;
          s.orders += 1;
        }

        response.attribution = Array.from(bySource.entries())
          .sort((a, b) => b[1].revenue_cents - a[1].revenue_cents)
          .map(([source, data]) => ({
            source,
            revenue: '$' + (data.revenue_cents / 100).toFixed(2),
            revenue_cents: data.revenue_cents,
            orders: data.orders,
            pct_of_revenue: totalRevenue > 0 ? Math.round(data.revenue_cents / totalRevenue * 100) : 0
          }));
      }

      // Product breakdown from connector_events metadata if requested
      if (include_products) {
        try {
          const prodResult = await this.db.prepare(`
            SELECT json_extract(metadata, '$.product_name') as name,
                   COUNT(*) as order_count,
                   SUM(value_cents) as total_revenue_cents
            FROM connector_events
            WHERE organization_id = ? AND source_platform = 'shopify' AND event_type = 'order'
              AND json_extract(metadata, '$.product_name') IS NOT NULL
            GROUP BY json_extract(metadata, '$.product_name')
            ORDER BY total_revenue_cents DESC
            LIMIT 20
          `).bind(orgId).all<{ name: string; order_count: number; total_revenue_cents: number }>();
          response.top_products = (prodResult.results || []).map(p => ({
            name: p.name,
            orders: p.order_count,
            revenue: '$' + ((p.total_revenue_cents || 0) / 100).toFixed(2)
          }));
        } catch {
          response.top_products = [];
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Shopify data not yet synced', time_series: [], summary: { total_revenue: '$0.00', total_orders: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query unified customer identity graph
   */
  private async queryCustomerIdentities(
    input: QueryCustomerIdentitiesInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days = 30, breakdown_by, min_confidence, include_match_rates = true } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Total identities
      let sql = `
        SELECT COUNT(*) as total,
               COUNT(CASE WHEN email_hash IS NOT NULL THEN 1 END) as with_email,
               COUNT(CASE WHEN stripe_customer_id IS NOT NULL THEN 1 END) as with_stripe,
               COUNT(CASE WHEN shopify_customer_id IS NOT NULL THEN 1 END) as with_shopify,
               COUNT(CASE WHEN user_id_hash IS NOT NULL THEN 1 END) as with_user_id,
               COUNT(CASE WHEN device_fingerprint_id IS NOT NULL THEN 1 END) as with_fingerprint,
               AVG(identity_confidence) as avg_confidence,
               AVG(total_sessions) as avg_sessions,
               AVG(total_touchpoints) as avg_touchpoints,
               SUM(total_conversions) as total_conversions,
               SUM(total_revenue_cents) as total_revenue_cents
        FROM customer_identities
        WHERE organization_id = ?
          AND last_seen_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (min_confidence) {
        sql += ' AND identity_confidence >= ?';
        params.push(min_confidence);
      }

      const totals = await this.db.prepare(sql).bind(...params).first<{
        total: number;
        with_email: number;
        with_stripe: number;
        with_shopify: number;
        with_user_id: number;
        with_fingerprint: number;
        avg_confidence: number | null;
        avg_sessions: number | null;
        avg_touchpoints: number | null;
        total_conversions: number | null;
        total_revenue_cents: number | null;
      }>();

      if (!totals || totals.total === 0) {
        return { success: true, data: { note: 'No customer identities found in period', total_identities: 0 } };
      }

      const response: any = {
        total_identities: totals.total,
        avg_confidence: totals.avg_confidence ? Math.round(totals.avg_confidence * 100) / 100 : 0,
        avg_sessions_per_identity: totals.avg_sessions ? Math.round(totals.avg_sessions * 10) / 10 : 0,
        avg_touchpoints_per_identity: totals.avg_touchpoints ? Math.round(totals.avg_touchpoints * 10) / 10 : 0,
        total_conversions: totals.total_conversions || 0,
        total_revenue: '$' + ((totals.total_revenue_cents || 0) / 100).toFixed(2)
      };

      if (include_match_rates) {
        response.match_rates = {
          email_match_rate: totals.total > 0 ? Math.round(totals.with_email / totals.total * 1000) / 10 : 0,
          stripe_match_rate: totals.total > 0 ? Math.round(totals.with_stripe / totals.total * 1000) / 10 : 0,
          shopify_match_rate: totals.total > 0 ? Math.round(totals.with_shopify / totals.total * 1000) / 10 : 0,
          user_id_match_rate: totals.total > 0 ? Math.round(totals.with_user_id / totals.total * 1000) / 10 : 0,
          fingerprint_match_rate: totals.total > 0 ? Math.round(totals.with_fingerprint / totals.total * 1000) / 10 : 0,
          with_email: totals.with_email,
          with_stripe: totals.with_stripe,
          with_shopify: totals.with_shopify,
          with_user_id: totals.with_user_id,
          with_fingerprint: totals.with_fingerprint
        };
      }

      // Breakdown
      if (breakdown_by) {
        const breakdownCol = breakdown_by === 'identity_method' ? 'identity_method'
          : breakdown_by === 'first_touch_source' ? 'first_touch_source'
          : 'first_touch_medium';

        const bdResult = await this.db.prepare(`
          SELECT ${breakdownCol} as dimension,
                 COUNT(*) as count,
                 AVG(identity_confidence) as avg_confidence,
                 SUM(total_conversions) as conversions,
                 SUM(total_revenue_cents) as revenue_cents
          FROM customer_identities
          WHERE organization_id = ?
            AND last_seen_at >= ?
            ${min_confidence ? 'AND identity_confidence >= ?' : ''}
          GROUP BY ${breakdownCol}
          ORDER BY count DESC
          LIMIT 20
        `).bind(...params).all<{
          dimension: string | null;
          count: number;
          avg_confidence: number | null;
          conversions: number | null;
          revenue_cents: number | null;
        }>();

        response.breakdown = (bdResult.results || []).map(r => ({
          [breakdown_by]: r.dimension || '(unknown)',
          identities: r.count,
          avg_confidence: r.avg_confidence ? Math.round(r.avg_confidence * 100) / 100 : 0,
          conversions: r.conversions || 0,
          revenue: '$' + ((r.revenue_cents || 0) / 100).toFixed(2)
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Customer identities table not yet created', total_identities: 0 } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query communication platform engagement (email/SMS)
   */
  private async queryCommEngagement(
    input: QueryCommEngagementInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, channel = 'all', include_campaigns = true, include_subscriber_health = false } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      const response: any = { days, platform: platform || 'all', channel };

      // All communication data now lives in connector_events
      const commPlatforms = ['sendgrid', 'attentive', 'mailchimp', 'tracking_link'];

      if (include_campaigns) {
        // Aggregate engagement by event_type from connector_events
        let engSql = `
          SELECT event_type, COUNT(*) as count, SUM(value_cents) as total_value_cents
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform IN (${commPlatforms.map(() => '?').join(',')})
            AND transacted_at >= ?
        `;
        const engParams: any[] = [orgId, ...commPlatforms, startStr + 'T00:00:00Z'];

        if (platform) {
          engSql += ' AND source_platform = ?';
          engParams.push(platform);
        }

        engSql += ' GROUP BY event_type';

        const engResult = await this.db.prepare(engSql).bind(...engParams).all<{
          event_type: string;
          count: number;
          total_value_cents: number | null;
        }>();

        const engagementByType: Record<string, number> = {};
        for (const r of engResult.results || []) {
          engagementByType[r.event_type] = r.count;
        }

        const totalSent = engagementByType['email_sent'] || engagementByType['campaign_sent'] || engagementByType['sms_sent'] || 0;
        const totalOpens = engagementByType['email_open'] || engagementByType['sms_open'] || 0;
        const totalClicks = engagementByType['email_click'] || engagementByType['sms_click'] || engagementByType['link_click'] || 0;
        const totalBounces = engagementByType['bounce'] || engagementByType['email_bounce'] || 0;
        const totalUnsubscribes = engagementByType['unsubscribe'] || engagementByType['email_unsubscribe'] || 0;
        const totalConversions = engagementByType['conversion'] || engagementByType['purchase'] || 0;

        response.campaign_summary = {
          total_events: (engResult.results || []).reduce((s, r) => s + r.count, 0),
          total_sent: totalSent,
          total_opens: totalOpens,
          total_clicks: totalClicks,
          total_bounces: totalBounces,
          total_unsubscribes: totalUnsubscribes,
          total_conversions: totalConversions,
          open_rate: totalSent > 0 ? (totalOpens / totalSent * 100).toFixed(1) + '%' : 'N/A',
          click_rate: totalSent > 0 ? (totalClicks / totalSent * 100).toFixed(1) + '%' : 'N/A',
          click_to_open_rate: totalOpens > 0 ? (totalClicks / totalOpens * 100).toFixed(1) + '%' : 'N/A',
          bounce_rate: totalSent > 0 ? (totalBounces / totalSent * 100).toFixed(1) + '%' : 'N/A',
          unsubscribe_rate: totalSent > 0 ? (totalUnsubscribes / totalSent * 100).toFixed(2) + '%' : 'N/A'
        };

        response.engagement_by_type = engagementByType;
      }

      // Subscriber health from connector_customers if available
      if (include_subscriber_health) {
        try {
          let subSql = `
            SELECT
              COUNT(*) as total_contacts,
              COUNT(DISTINCT customer_external_id) as unique_contacts
            FROM connector_events
            WHERE organization_id = ?
              AND source_platform IN (${commPlatforms.map(() => '?').join(',')})
              AND transacted_at >= ?
          `;
          const subParams: any[] = [orgId, ...commPlatforms, startStr + 'T00:00:00Z'];

          const subResult = await this.db.prepare(subSql).bind(...subParams).first<any>();
          response.subscriber_health = {
            total_events: subResult?.total_contacts || 0,
            unique_contacts: subResult?.unique_contacts || 0,
            note: 'Subscriber-level health metrics require live API query (use query_api tool)'
          };
        } catch {
          response.subscriber_health = { note: 'Subscriber data not available' };
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Communication data not yet synced', campaign_summary: null } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query unified e-commerce analytics from connector_events
   */
  private async queryEcommerceAnalytics(
    input: QueryEcommerceAnalyticsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by = 'day', include_products = false, include_customers = false } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Query connector_events for e-commerce orders
      const ecommPlatforms = platform ? [platform] : ['shopify', 'stripe', 'lemon_squeezy', 'paddle', 'chargebee'];
      let orderSql = `
        SELECT id, source_platform, external_id, event_type, status,
               value_cents, metadata, transacted_at
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform IN (${ecommPlatforms.map(() => '?').join(',')})
          AND event_type = 'order'
          AND transacted_at >= ?
        ORDER BY transacted_at DESC LIMIT 2000
      `;
      const orderParams: any[] = [orgId, ...ecommPlatforms, startStr + 'T00:00:00Z'];

      const orderResult = await this.db.prepare(orderSql).bind(...orderParams).all<any>();
      const orders = orderResult.results || [];

      if (orders.length === 0) {
        return { success: true, data: { note: 'No e-commerce orders in period', summary: { total_revenue: '$0.00', total_orders: 0 } } };
      }

      const totalRevenue = orders.reduce((s: number, o: any) => s + (o.value_cents || 0), 0);
      const paidOrders = orders.filter((o: any) => ['paid', 'completed', 'succeeded'].includes(o.status));
      const cancelledOrders = orders.filter((o: any) => ['cancelled', 'refunded', 'voided'].includes(o.status));

      // Parse metadata for UTM info
      const parseMeta = (m: string | null) => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };
      const withUtm = orders.filter((o: any) => parseMeta(o.metadata).utm_source);

      const response: any = {
        summary: {
          total_revenue: '$' + (totalRevenue / 100).toFixed(2),
          total_revenue_cents: totalRevenue,
          total_orders: orders.length,
          paid_orders: paidOrders.length,
          cancelled_orders: cancelledOrders.length,
          avg_order_value: '$' + (orders.length > 0 ? (totalRevenue / 100 / orders.length).toFixed(2) : '0.00'),
          orders_with_utm: withUtm.length,
          utm_coverage: orders.length > 0 ? Math.round(withUtm.length / orders.length * 100) + '%' : 'N/A',
          platforms: [...new Set(orders.map((o: any) => o.source_platform))].filter(Boolean)
        }
      };

      // Grouped data
      const grouped = new Map<string, { revenue_cents: number; count: number }>();
      for (const order of orders) {
        const meta = parseMeta(order.metadata);
        let key: string;
        switch (group_by) {
          case 'platform':
            key = order.source_platform || 'unknown';
            break;
          case 'status':
            key = order.status || 'unknown';
            break;
          case 'utm_source':
            key = meta.utm_source || '(direct)';
            break;
          case 'utm_campaign':
            key = meta.utm_campaign || '(none)';
            break;
          default:
            key = (order.transacted_at || '').split('T')[0];
        }
        if (!grouped.has(key)) grouped.set(key, { revenue_cents: 0, count: 0 });
        const g = grouped.get(key)!;
        g.revenue_cents += order.value_cents || 0;
        g.count += 1;
      }

      response.grouped = Array.from(grouped.entries())
        .sort((a, b) => group_by === 'day' ? a[0].localeCompare(b[0]) : b[1].revenue_cents - a[1].revenue_cents)
        .map(([key, data]) => ({
          [group_by]: key,
          revenue: '$' + (data.revenue_cents / 100).toFixed(2),
          orders: data.count
        }));

      // Product breakdown from metadata JSON
      if (include_products) {
        const productMap = new Map<string, { count: number; revenue_cents: number }>();
        for (const order of orders) {
          const meta = parseMeta(order.metadata);
          const items = meta.line_items || meta.products || [];
          for (const item of (Array.isArray(items) ? items : [])) {
            const name = item.name || item.title || 'unknown';
            if (!productMap.has(name)) productMap.set(name, { count: 0, revenue_cents: 0 });
            const p = productMap.get(name)!;
            p.count += item.quantity || 1;
            p.revenue_cents += item.price_cents || item.amount || 0;
          }
        }
        response.products = Array.from(productMap.entries())
          .sort((a, b) => b[1].revenue_cents - a[1].revenue_cents)
          .slice(0, 50)
          .map(([name, data]) => ({
            name,
            quantity_sold: data.count,
            revenue: '$' + (data.revenue_cents / 100).toFixed(2)
          }));
      }

      // Customer metrics from connector_customers if available
      if (include_customers) {
        try {
          const custSql = `
            SELECT
              COUNT(*) as total_customers,
              COUNT(DISTINCT customer_external_id) as unique_customers
            FROM connector_events
            WHERE organization_id = ?
              AND source_platform IN (${ecommPlatforms.map(() => '?').join(',')})
              AND event_type = 'order'
              AND transacted_at >= ?
          `;
          const custResult = await this.db.prepare(custSql).bind(orgId, ...ecommPlatforms, startStr + 'T00:00:00Z').first<any>();
          response.customers = {
            total_orders: custResult?.total_customers || 0,
            unique_customers: custResult?.unique_customers || 0,
            avg_orders_per_customer: custResult?.unique_customers > 0
              ? Math.round((custResult.total_customers / custResult.unique_customers) * 10) / 10
              : 0,
          };
        } catch {
          response.customers = null;
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'connector_events table not yet created', summary: { total_revenue: '$0.00', total_orders: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query support metrics from connector_events (zendesk, intercom)
   */
  private async querySupportMetrics(
    input: QuerySupportMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform, group_by,
      categoryPlatforms: ['zendesk', 'intercom'],
      categoryName: 'support',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query scheduling metrics from connector_events (calendly, acuity)
   */
  private async querySchedulingMetrics(
    input: QuerySchedulingMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform, group_by,
      categoryPlatforms: ['calendly', 'acuity'],
      categoryName: 'scheduling',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query form submission metrics from connector_events (typeform, jotform)
   */
  private async queryFormSubmissions(
    input: QueryFormSubmissionsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform, group_by,
      categoryPlatforms: ['typeform', 'jotform'],
      categoryName: 'forms',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query accounting metrics from connector_events (quickbooks, xero)
   */
  private async queryAccountingMetrics(
    input: QueryAccountingMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform, group_by,
      categoryPlatforms: ['quickbooks', 'xero'],
      categoryName: 'accounting',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query review metrics from connector_events (trustpilot, g2)
   */
  private async queryReviews(
    input: QueryReviewsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform,
      categoryPlatforms: ['trustpilot', 'g2'],
      categoryName: 'reviews',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query affiliate metrics from connector_events
   */
  private async queryAffiliateMetrics(
    input: QueryAffiliateMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, group_by } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform, group_by,
      categoryPlatforms: ['rewardful', 'partnerstack', 'impact'],
      categoryName: 'affiliate',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Query social media metrics from connector_events (instagram, twitter)
   */
  private async querySocialMetrics(
    input: QuerySocialMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform } = input;
    return this.queryConnectorEventCategory({
      orgId, days, platform,
      categoryPlatforms: ['instagram', 'twitter', 'linkedin', 'facebook_pages'],
      categoryName: 'social',
      dateGroupCol: 'transacted_at',
    });
  }

  /**
   * Generic connector_events query for categories without active sync writers yet.
   * Returns event counts, value totals, and status breakdown from connector_events.
   * Returns 0 rows until the connector ships — no scaffolding, no dead tables.
   */
  private async queryConnectorEventCategory(opts: {
    orgId: string;
    days: number;
    platform?: string;
    group_by?: string;
    categoryPlatforms: string[];
    categoryName: string;
    dateGroupCol: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    const { orgId, days, platform, group_by, categoryPlatforms, categoryName, dateGroupCol } = opts;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      const platforms = platform ? [platform] : categoryPlatforms;

      // Summary query
      const summSql = `
        SELECT
          COUNT(*) as total_events,
          SUM(value_cents) as total_value_cents,
          COUNT(DISTINCT customer_external_id) as unique_entities,
          COUNT(DISTINCT source_platform) as platforms_count
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform IN (${platforms.map(() => '?').join(',')})
          AND transacted_at >= ?
      `;
      const summResult = await this.db.prepare(summSql)
        .bind(orgId, ...platforms, startStr + 'T00:00:00Z')
        .first<{ total_events: number; total_value_cents: number | null; unique_entities: number; platforms_count: number }>();

      const totalEvents = summResult?.total_events || 0;

      const response: any = {
        category: categoryName,
        days,
        summary: {
          total_events: totalEvents,
          total_value: '$' + ((summResult?.total_value_cents || 0) / 100).toFixed(2),
          unique_entities: summResult?.unique_entities || 0,
          platforms_count: summResult?.platforms_count || 0,
        }
      };

      if (totalEvents === 0) {
        response.note = `No ${categoryName} data synced yet. Connect a ${categoryName} platform to see data here.`;
        return { success: true, data: response };
      }

      // Status breakdown
      const statusSql = `
        SELECT status, COUNT(*) as count, SUM(value_cents) as value_cents
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform IN (${platforms.map(() => '?').join(',')})
          AND transacted_at >= ?
        GROUP BY status
        ORDER BY count DESC LIMIT 20
      `;
      const statusResult = await this.db.prepare(statusSql)
        .bind(orgId, ...platforms, startStr + 'T00:00:00Z')
        .all<{ status: string; count: number; value_cents: number | null }>();

      response.by_status = (statusResult.results || []).map(r => ({
        status: r.status,
        count: r.count,
        value: '$' + ((r.value_cents || 0) / 100).toFixed(2)
      }));

      // Event type breakdown
      const typeSql = `
        SELECT event_type, COUNT(*) as count, SUM(value_cents) as value_cents
        FROM connector_events
        WHERE organization_id = ?
          AND source_platform IN (${platforms.map(() => '?').join(',')})
          AND transacted_at >= ?
        GROUP BY event_type
        ORDER BY count DESC LIMIT 20
      `;
      const typeResult = await this.db.prepare(typeSql)
        .bind(orgId, ...platforms, startStr + 'T00:00:00Z')
        .all<{ event_type: string; count: number; value_cents: number | null }>();

      response.by_event_type = (typeResult.results || []).map(r => ({
        event_type: r.event_type,
        count: r.count,
        value: '$' + ((r.value_cents || 0) / 100).toFixed(2)
      }));

      // Group by dimension if requested
      if (group_by) {
        const grpCol = group_by === 'day' ? `date(${dateGroupCol})` : 'status';
        const grpSql = `
          SELECT ${grpCol} as dimension, COUNT(*) as count, SUM(value_cents) as value_cents
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform IN (${platforms.map(() => '?').join(',')})
            AND transacted_at >= ?
          GROUP BY ${grpCol}
          ORDER BY count DESC LIMIT 30
        `;
        const grpResult = await this.db.prepare(grpSql)
          .bind(orgId, ...platforms, startStr + 'T00:00:00Z')
          .all<{ dimension: string | null; count: number; value_cents: number | null }>();

        response.grouped = (grpResult.results || []).map(r => ({
          [group_by]: r.dimension || '(unknown)',
          events: r.count,
          value: '$' + ((r.value_cents || 0) / 100).toFixed(2)
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: `${categoryName} tables not yet created`, summary: { total_events: 0 } } };
      }
      return { success: false, error: msg };
    }
  }
}
