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
    description: 'Query ad platform data. Scopes: "performance" — metrics for a specific entity (spend, impressions, clicks, etc.); "creatives" — ad creative details (copy, media); "audiences" — targeting/audience breakdown by dimension; "budgets" — current budget configuration for a campaign or ad set. Common params: platform, entity_type, entity_id, days. For "performance" scope: metrics array, include_verified_revenue. For "creatives" scope: ad_id. For "audiences" scope: dimension. For "budgets" scope: entity_type includes ad_group.',
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
          description: 'The entity ID to query'
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
    description: 'Query revenue data from connected platforms. Scopes: "stripe" — Stripe charges/subscriptions with metadata filtering; "jobber" — Jobber completed jobs for field service; "shopify" — Shopify orders with UTM attribution and product breakdown; "ecommerce" — unified e-commerce data across platforms; "subscriptions" — MRR, LTV, churn, retention cohort analysis; "accounting" — invoices, expenses, P&L from QuickBooks/Xero. Common params: days, group_by. For "stripe": conversion_type, filters, metadata_filters, breakdown_by_metadata_key. For "shopify": filters (financial_status, fulfillment_status, etc.), include_products, include_attribution. For "ecommerce": platform, include_products, include_customers. For "subscriptions": metric (required), breakdown_by, filters. For "accounting": platform, data_type.',
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
  constructor(private db: D1Database, private aiDb?: D1Database) {}

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
        case 'query_ad_metrics':
          switch (input.scope) {
            case 'performance': return await this.queryMetrics(input as QueryMetricsInput, orgId);
            case 'creatives': return await this.getCreativeDetails(input as GetCreativeDetailsInput, orgId);
            case 'audiences': return await this.getAudienceBreakdown(input as GetAudienceBreakdownInput, orgId);
            case 'budgets': return await this.getEntityBudget(input as GetEntityBudgetInput, orgId);
            default: return { success: false, error: `Unknown scope for query_ad_metrics: ${input.scope}` };
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
        SELECT SUM(amount_cents) as total_cents, COUNT(*) as count
        FROM stripe_charges
        WHERE organization_id = ?
          AND created_at >= ? AND created_at <= ?
          AND status IN ('succeeded', 'active', 'trialing')
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
      // Build D1 SQL query for stripe_charges table
      let sql = `
        SELECT charge_id, amount_cents, currency, status, customer_id, created_at, metadata
        FROM stripe_charges
        WHERE organization_id = ?
          AND created_at >= ? AND created_at <= ?
      `;
      const params: any[] = [orgId, startStr, endStr + 'T23:59:59Z'];

      // Apply status filter
      if (filters?.status) {
        sql += ` AND status = ?`;
        params.push(filters.status);
      }
      if (filters?.min_amount_cents) {
        sql += ` AND amount_cents >= ?`;
        params.push(filters.min_amount_cents);
      }
      if (filters?.max_amount_cents) {
        sql += ` AND amount_cents <= ?`;
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
   * Query Jobber completed jobs as revenue (D1 version)
   * Note: Requires jobber_jobs table in ANALYTICS_DB
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
      // D1 SQL query for jobber_jobs table
      let sql = `
        SELECT job_id, total_amount_cents, client_id, completed_at
        FROM jobber_jobs
        WHERE organization_id = ?
          AND job_status = 'COMPLETED'
          AND completed_at >= ? AND completed_at <= ?
        ORDER BY completed_at ASC
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
      // If jobber_jobs table doesn't exist yet, return empty result
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

      // Fetch verified Stripe revenue using D1
      const stripeSql = `
        SELECT SUM(amount_cents) as total_cents, COUNT(*) as count
        FROM stripe_charges
        WHERE organization_id = ?
          AND created_at >= ? AND created_at <= ?
          AND status IN ('succeeded', 'active', 'trialing')
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
   * Note: Requires stripe_subscriptions table in ANALYTICS_DB
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
      // Build D1 SQL query for stripe_subscriptions
      let sql = `SELECT * FROM stripe_subscriptions WHERE organization_id = ?`;
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
   * Query verified conversions grouped by goal
   * Uses the conversions table with linked_goal_id populated by ConversionLinkingWorkflow
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
      // Query conversions with linked goals from D1
      let sql = `
        SELECT
          c.conversion_id,
          c.linked_goal_id,
          c.link_method,
          c.link_confidence,
          c.value_cents,
          c.currency,
          c.conversion_timestamp,
          c.source_platform,
          g.name as goal_name,
          g.event_type as goal_event_type
        FROM conversions c
        LEFT JOIN conversion_goals g ON g.id = c.linked_goal_id
        WHERE c.organization_id = ?
          AND c.linked_goal_id IS NOT NULL
          AND c.link_confidence >= ?
          AND c.conversion_timestamp >= ?
          AND c.conversion_timestamp <= ?
      `;
      const params: any[] = [orgId, min_confidence, startStr, endStr + 'T23:59:59Z'];

      if (goal_id) {
        sql += ` AND c.linked_goal_id = ?`;
        params.push(goal_id);
      }

      sql += ` ORDER BY c.conversion_timestamp DESC`;

      const result = await this.db.prepare(sql).bind(...params).all<{
        conversion_id: string;
        linked_goal_id: string;
        link_method: string;
        link_confidence: number;
        value_cents: number;
        currency: string;
        conversion_timestamp: string;
        source_platform: string;
        goal_name: string;
        goal_event_type: string;
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

      // Fetch verified conversions (linked to goals with sufficient confidence)
      const verifiedSql = `
        SELECT
          COUNT(*) as verified_count,
          SUM(value_cents) as verified_value_cents,
          AVG(link_confidence) as avg_confidence,
          link_method
        FROM conversions
        WHERE organization_id = ?
          AND linked_goal_id IS NOT NULL
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
   * Group conversions by goal
   */
  private groupConversionsByGoal(conversions: any[]): any[] {
    const byGoal = new Map<string, { conversions: number; value_cents: number; avg_confidence: number; confidences: number[] }>();

    for (const c of conversions) {
      const goalId = c.linked_goal_id || 'unlinked';
      if (!byGoal.has(goalId)) {
        byGoal.set(goalId, { conversions: 0, value_cents: 0, avg_confidence: 0, confidences: [] });
      }
      const g = byGoal.get(goalId)!;
      g.conversions += 1;
      g.value_cents += c.value_cents || 0;
      g.confidences.push(c.link_confidence || 0);
    }

    return Array.from(byGoal.entries()).map(([goalId, data]) => {
      const matchingConversion = conversions.find(c => c.linked_goal_id === goalId);
      return {
        goal_id: goalId,
        goal_name: matchingConversion?.goal_name || 'Unknown',
        goal_event_type: matchingConversion?.goal_event_type || 'unknown',
        conversions: data.conversions,
        value: '$' + (data.value_cents / 100).toFixed(2),
        avg_confidence: (data.confidences.reduce((a, b) => a + b, 0) / data.confidences.length).toFixed(2)
      };
    }).sort((a, b) => b.conversions - a.conversions);
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
      let query = 'SELECT 1 FROM ad_metrics WHERE organization_id = ?';
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
    entityId: string,
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
    // Unified tables
    const unifiedTables: Record<string, { table: string; idColumn: string }> = {
      ad: { table: 'ads', idColumn: 'ad_id' },
      adset: { table: 'ad_groups', idColumn: 'ad_group_id' },
      campaign: { table: 'ad_campaigns', idColumn: 'campaign_id' }
    };

    if (unifiedTables[entityType]) {
      return { ...unifiedTables[entityType], unified: true };
    }

    // Legacy fallback
    const legacyTables: Record<string, Record<string, { table: string; idColumn: string }>> = {
      facebook: {
        ad: { table: 'facebook_ads', idColumn: 'ad_id' },
        adset: { table: 'facebook_ad_sets', idColumn: 'ad_set_id' },
        campaign: { table: 'facebook_campaigns', idColumn: 'campaign_id' },
        account: { table: 'facebook_accounts', idColumn: 'account_id' }
      },
      google: {
        ad: { table: 'google_ads', idColumn: 'ad_id' },
        adset: { table: 'google_ad_groups', idColumn: 'ad_group_id' },
        campaign: { table: 'google_campaigns', idColumn: 'campaign_id' },
        account: { table: 'google_accounts', idColumn: 'customer_id' }
      },
      tiktok: {
        ad: { table: 'tiktok_ads', idColumn: 'ad_id' },
        adset: { table: 'tiktok_ad_groups', idColumn: 'ad_group_id' },
        campaign: { table: 'tiktok_campaigns', idColumn: 'campaign_id' },
        account: { table: 'tiktok_advertisers', idColumn: 'advertiser_id' }
      }
    };

    const legacy = legacyTables[platform]?.[entityType];
    return legacy ? { ...legacy, unified: false } : null;
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
   * Supports daily_metrics, goal_conversions, and hourly_metrics tables
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
          metric_date,
          SUM(total_visits) as page_views,
          SUM(unique_visitors) as unique_visitors,
          SUM(total_conversions) as conversions,
          SUM(total_conversion_value) as conversion_value_cents
        FROM daily_metrics
        WHERE organization_id = ?
          AND metric_date >= ?
        GROUP BY metric_date
        ORDER BY metric_date DESC
      `).bind(orgId, startStr).all<{
        metric_date: string;
        page_views: number;
        unique_visitors: number;
        conversions: number;
        conversion_value_cents: number;
      }>();

      response.daily_summary = dailyResult.results || [];

      // Query goal conversions if looking for specific goals or conversions
      if (goal_ids?.length || event_types?.includes('goal_completed')) {
        let goalQuery = `
          SELECT
            gc.goal_id,
            g.name as goal_name,
            COUNT(*) as conversion_count,
            SUM(gc.value_cents) as total_value_cents
          FROM goal_conversions gc
          LEFT JOIN conversion_goals g ON gc.goal_id = g.id
          WHERE gc.organization_id = ?
            AND gc.converted_at >= ?
        `;
        const params: any[] = [orgId, startStr + 'T00:00:00Z'];

        if (goal_ids?.length) {
          goalQuery += ` AND gc.goal_id IN (${goal_ids.map(() => '?').join(',')})`;
          params.push(...goal_ids);
        }

        goalQuery += ' GROUP BY gc.goal_id, g.name';

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
            AND metric_date >= ?
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
   * Query CRM pipeline data from unified tables
   * Uses crm_deals table for deal/opportunity data
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
      // Build dynamic query
      let query = `
        SELECT
          id,
          platform,
          deal_id,
          deal_name,
          stage,
          status,
          value_cents,
          owner_name,
          source,
          utm_source,
          utm_campaign,
          created_at,
          closed_at
        FROM crm_deals
        WHERE organization_id = ?
          AND created_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (stages?.length) {
        query += ` AND stage IN (${stages.map(() => '?').join(',')})`;
        params.push(...stages);
      }

      if (status && status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
      }

      if (min_value_cents) {
        query += ' AND value_cents >= ?';
        params.push(min_value_cents);
      }

      query += ' ORDER BY created_at DESC LIMIT 500';

      const result = await this.db.prepare(query).bind(...params).all<{
        id: string;
        platform: string;
        deal_id: string;
        deal_name: string | null;
        stage: string;
        status: string;
        value_cents: number | null;
        owner_name: string | null;
        source: string | null;
        utm_source: string | null;
        utm_campaign: string | null;
        created_at: string;
        closed_at: string | null;
      }>();

      const deals = result.results || [];

      // Calculate pipeline summary
      const summary = {
        total_deals: deals.length,
        total_value: '$' + (deals.reduce((sum, d) => sum + (d.value_cents || 0), 0) / 100).toFixed(2),
        won_deals: deals.filter(d => d.status === 'won').length,
        won_value: '$' + (deals.filter(d => d.status === 'won').reduce((sum, d) => sum + (d.value_cents || 0), 0) / 100).toFixed(2),
        lost_deals: deals.filter(d => d.status === 'lost').length,
        open_deals: deals.filter(d => d.status === 'open').length
      };

      // Group by dimension if requested
      let grouped: any = null;
      if (group_by) {
        const groups = new Map<string, { count: number; value_cents: number }>();

        for (const deal of deals) {
          let key: string;
          switch (group_by) {
            case 'day':
              key = deal.created_at.split('T')[0];
              break;
            case 'stage':
              key = deal.stage || 'unknown';
              break;
            case 'source':
              key = deal.source || deal.utm_source || 'unknown';
              break;
            case 'owner':
              key = deal.owner_name || 'unassigned';
              break;
            default:
              key = 'all';
          }

          if (!groups.has(key)) {
            groups.set(key, { count: 0, value_cents: 0 });
          }
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

      // Build response
      const response: any = {
        days,
        filters: { stages, status, min_value_cents },
        summary,
        deals: deals.slice(0, 50).map(d => ({
          deal_id: d.deal_id,
          name: d.deal_name,
          stage: d.stage,
          status: d.status,
          value: d.value_cents ? '$' + (d.value_cents / 100).toFixed(2) : null,
          owner: d.owner_name,
          created_at: d.created_at,
          ...(include_attribution ? {
            source: d.source,
            utm_source: d.utm_source,
            utm_campaign: d.utm_campaign
          } : {})
        }))
      };

      if (grouped) {
        response.grouped = grouped;
      }

      return { success: true, data: response };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
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
    const { connector_type, platform, days, metrics, group_by } = input;

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
              source,
              COUNT(*) as count,
              SUM(value_cents) as total_cents
            FROM conversions
            WHERE organization_id = ?
              AND created_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND source = ?';
            params.push(platform);
          }

          query += ' GROUP BY source';

          const result = await this.db.prepare(query).bind(...params).all<{
            source: string;
            count: number;
            total_cents: number | null;
          }>();

          response.sources = (result.results || []).map(r => ({
            source: r.source,
            conversions: r.count,
            revenue: '$' + ((r.total_cents || 0) / 100).toFixed(2)
          }));
          break;
        }

        case 'crm': {
          // Query crm_deals table
          let query = `
            SELECT
              platform,
              COUNT(*) as deals,
              SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
              SUM(value_cents) as total_value_cents
            FROM crm_deals
            WHERE organization_id = ?
              AND created_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY platform';

          const result = await this.db.prepare(query).bind(...params).all<{
            platform: string;
            deals: number;
            won: number;
            total_value_cents: number | null;
          }>();

          response.platforms = (result.results || []).map(r => ({
            platform: r.platform,
            total_deals: r.deals,
            won_deals: r.won,
            total_value: '$' + ((r.total_value_cents || 0) / 100).toFixed(2),
            win_rate: r.deals > 0 ? ((r.won / r.deals) * 100).toFixed(0) + '%' : '0%'
          }));
          break;
        }

        case 'communication': {
          // Query comm_campaigns table if it exists
          let query = `
            SELECT
              platform,
              COUNT(*) as campaigns,
              SUM(sent_count) as total_sent,
              SUM(open_count) as total_opens,
              SUM(click_count) as total_clicks
            FROM comm_campaigns
            WHERE organization_id = ?
              AND sent_at >= ?
          `;
          const params: any[] = [orgId, startStr + 'T00:00:00Z'];

          if (platform) {
            query += ' AND platform = ?';
            params.push(platform);
          }

          query += ' GROUP BY platform';

          try {
            const result = await this.db.prepare(query).bind(...params).all<{
              platform: string;
              campaigns: number;
              total_sent: number | null;
              total_opens: number | null;
              total_clicks: number | null;
            }>();

            response.platforms = (result.results || []).map(r => ({
              platform: r.platform,
              campaigns: r.campaigns,
              sent: r.total_sent || 0,
              opens: r.total_opens || 0,
              clicks: r.total_clicks || 0,
              open_rate: r.total_sent ? ((r.total_opens || 0) / r.total_sent * 100).toFixed(1) + '%' : '0%'
            }));
          } catch {
            response.platforms = [];
            response.note = 'No communication campaign data available';
          }
          break;
        }

        case 'field_service': {
          // Query field service jobs (Jobber)
          let query = `
            SELECT
              COUNT(*) as jobs,
              SUM(total_price_cents) as revenue_cents,
              COUNT(DISTINCT customer_id) as customers
            FROM field_service_jobs
            WHERE organization_id = ?
              AND job_date >= ?
          `;
          const params: any[] = [orgId, startStr];

          if (platform) {
            query += ' AND platform = ?';
            params.push(platform);
          }

          try {
            const result = await this.db.prepare(query).bind(...params).first<{
              jobs: number;
              revenue_cents: number | null;
              customers: number;
            }>();

            response.summary = {
              jobs: result?.jobs || 0,
              revenue: '$' + ((result?.revenue_cents || 0) / 100).toFixed(2),
              unique_customers: result?.customers || 0
            };
          } catch {
            response.summary = { jobs: 0, revenue: '$0.00', unique_customers: 0 };
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

      // Check ad platforms (unified tables)
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

        // Also check legacy tables for backward compatibility
        const legacyPlatforms = ['google', 'facebook', 'tiktok'];
        const legacyTables = ['google_campaigns', 'facebook_campaigns', 'tiktok_campaigns'];

        for (let i = 0; i < legacyPlatforms.length; i++) {
          const exists = connectors.some(c => c.platform === legacyPlatforms[i]);
          if (!exists) {
            try {
              const check = await this.db.prepare(`
                SELECT COUNT(*) as count FROM ${legacyTables[i]} WHERE organization_id = ?
              `).bind(orgId).first<{ count: number }>();

              if (check && check.count > 0) {
                connectors.push({
                  type: 'ad_platform',
                  platform: legacyPlatforms[i],
                  has_data: true,
                  ...(include_data_stats ? { record_count: check.count } : {})
                });
              }
            } catch {
              // Table doesn't exist, skip
            }
          }
        }
      }

      // Check revenue sources
      if (!connector_type || connector_type === 'all' || connector_type === 'payments' || connector_type === 'ecommerce') {
        const revenueResult = await this.db.prepare(`
          SELECT source, COUNT(*) as count, MAX(created_at) as last_sync
          FROM conversions
          WHERE organization_id = ?
          GROUP BY source
        `).bind(orgId).all<{ source: string; count: number; last_sync: string | null }>();

        for (const r of revenueResult.results || []) {
          connectors.push({
            type: ['shopify'].includes(r.source) ? 'ecommerce' : 'payments',
            platform: r.source,
            has_data: r.count > 0,
            ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
          });
        }
      }

      // Check CRM
      if (!connector_type || connector_type === 'all' || connector_type === 'crm') {
        try {
          const crmResult = await this.db.prepare(`
            SELECT platform, COUNT(*) as count, MAX(created_at) as last_sync
            FROM crm_deals
            WHERE organization_id = ?
            GROUP BY platform
          `).bind(orgId).all<{ platform: string; count: number; last_sync: string | null }>();

          for (const r of crmResult.results || []) {
            connectors.push({
              type: 'crm',
              platform: r.platform,
              has_data: r.count > 0,
              ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
            });
          }
        } catch {
          // CRM table doesn't exist yet
        }
      }

      // Check events/tag
      if (!connector_type || connector_type === 'all') {
        const eventsResult = await this.db.prepare(`
          SELECT COUNT(*) as count, MAX(metric_date) as last_date
          FROM daily_metrics
          WHERE organization_id = ?
        `).bind(orgId).first<{ count: number; last_date: string | null }>();

        if (eventsResult && eventsResult.count > 0) {
          connectors.push({
            type: 'events',
            platform: 'clearlift_tag',
            has_data: true,
            ...(include_data_stats ? { record_count: eventsResult.count, last_sync: eventsResult.last_date || undefined } : {})
          });
        }
      }

      // Check all unified connector categories
      const unifiedChecks: Array<{ type: string; table: string; dateCol: string }> = [
        { type: 'communication', table: 'comm_campaigns', dateCol: 'sent_at' },
        { type: 'ecommerce', table: 'ecommerce_orders', dateCol: 'ordered_at' },
        { type: 'support', table: 'support_tickets', dateCol: 'opened_at' },
        { type: 'scheduling', table: 'scheduling_appointments', dateCol: 'booked_at' },
        { type: 'forms', table: 'forms_submissions', dateCol: 'submitted_at' },
        { type: 'accounting', table: 'accounting_invoices', dateCol: 'invoice_date' },
        { type: 'reviews', table: 'reviews_items', dateCol: 'reviewed_at' },
        { type: 'affiliate', table: 'affiliate_conversions', dateCol: 'converted_at' },
        { type: 'social', table: 'social_posts', dateCol: 'published_at' },
        { type: 'field_service', table: 'jobber_jobs', dateCol: 'completed_at' },
      ];

      for (const check of unifiedChecks) {
        if (connector_type && connector_type !== 'all' && connector_type !== check.type) continue;
        // Skip types we've already checked above
        if (check.type === 'ecommerce' && connectors.some(c => c.type === 'ecommerce')) continue;

        try {
          const uResult = await this.db.prepare(`
            SELECT source_platform, COUNT(*) as count, MAX(last_synced_at) as last_sync
            FROM ${check.table}
            WHERE organization_id = ?
            GROUP BY source_platform
          `).bind(orgId).all<{ source_platform: string; count: number; last_sync: string | null }>();

          for (const r of uResult.results || []) {
            if (r.count > 0 && !connectors.some(c => c.type === check.type && c.platform === r.source_platform)) {
              connectors.push({
                type: check.type,
                platform: r.source_platform || check.table,
                has_data: true,
                ...(include_data_stats ? { record_count: r.count, last_sync: r.last_sync || undefined } : {})
              });
            }
          }
        } catch {
          // Table doesn't exist yet — skip
        }
      }

      // Check Shopify specifically (shopify_orders table)
      if (!connector_type || connector_type === 'all' || connector_type === 'ecommerce') {
        if (!connectors.some(c => c.platform === 'shopify')) {
          try {
            const shopResult = await this.db.prepare(`
              SELECT COUNT(*) as count, MAX(created_at) as last_sync
              FROM shopify_orders
              WHERE organization_id = ?
            `).bind(orgId).first<{ count: number; last_sync: string | null }>();

            if (shopResult && shopResult.count > 0) {
              connectors.push({
                type: 'ecommerce',
                platform: 'shopify',
                has_data: true,
                ...(include_data_stats ? { record_count: shopResult.count, last_sync: shopResult.last_sync || undefined } : {})
              });
            }
          } catch { /* table doesn't exist */ }
        }
      }

      // Check customer identities
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
      const row = await this.db.prepare(
        'SELECT org_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1'
      ).bind(orgId).first<{ org_tag: string }>();
      return row?.org_tag || null;
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

      // Get conversion goals
      let goalSql = `
        SELECT id, goal_name, goal_type, event_type, configuration
        FROM conversion_goals
        WHERE organization_id = ?
      `;
      const goalParams: any[] = [orgId];
      if (goal_id) {
        goalSql += ' AND id = ?';
        goalParams.push(goal_id);
      }

      const goalsResult = await this.db.prepare(goalSql).bind(...goalParams).all<{
        id: string;
        goal_name: string;
        goal_type: string;
        event_type: string;
        configuration: string | null;
      }>();

      const goals = goalsResult.results || [];
      const channels = journey.channel_distribution ? JSON.parse(journey.channel_distribution) : {};
      const totalSessions = journey.total_sessions || 1;

      // Build funnel stages from goals
      const stages = goals.map((goal, idx) => {
        // Estimate visitors per stage using a simple decay model
        // First stage gets all sessions, subsequent stages decay
        const decayFactor = Math.pow(0.6, idx);
        const estimatedVisitors = Math.round(totalSessions * decayFactor);
        const nextVisitors = idx < goals.length - 1
          ? Math.round(totalSessions * Math.pow(0.6, idx + 1))
          : journey.converting_sessions;
        const dropoffRate = estimatedVisitors > 0
          ? ((estimatedVisitors - nextVisitors) / estimatedVisitors * 100)
          : 0;

        return {
          goal_id: goal.id,
          goal_name: goal.goal_name,
          goal_type: goal.goal_type,
          estimated_visitors: estimatedVisitors,
          dropoff_rate: Math.round(dropoffRate * 10) / 10,
          conversion_rate: totalSessions > 0
            ? Math.round((nextVisitors / totalSessions) * 1000) / 10
            : 0
        };
      });

      // Identify bottleneck (highest dropoff)
      const bottleneck = stages.length > 0
        ? stages.reduce((max, s) => s.dropoff_rate > max.dropoff_rate ? s : max, stages[0])
        : null;

      return {
        success: true,
        data: {
          total_sessions: journey.total_sessions,
          converting_sessions: journey.converting_sessions,
          overall_conversion_rate: journey.total_sessions > 0
            ? Math.round((journey.converting_sessions / journey.total_sessions) * 1000) / 10
            : 0,
          stages,
          bottleneck_stage: bottleneck ? { goal_name: bottleneck.goal_name, dropoff_rate: bottleneck.dropoff_rate } : null,
          computed_at: journey.computed_at
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

    const db = this.aiDb;
    if (!db) {
      return { success: false, error: 'AI database not available for CAC queries' };
    }

    try {
      // Query CAC history
      const historyResult = await db.prepare(`
        SELECT date, cac_cents, spend_cents, conversions, notes
        FROM cac_history
        WHERE organization_id = ?
        ORDER BY date DESC
        LIMIT ?
      `).bind(orgId, days).all<{
        date: string;
        cac_cents: number;
        spend_cents: number;
        conversions: number;
        notes: string | null;
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
          const predsResult = await db.prepare(`
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
          const basResult = await db.prepare(`
            SELECT target_cac_cents, baseline_type, notes
            FROM cac_baselines
            WHERE organization_id = ?
            ORDER BY created_at DESC
            LIMIT 5
          `).bind(orgId).all<{
            target_cac_cents: number;
            baseline_type: string;
            notes: string | null;
          }>();
          result.baselines = (basResult.results || []).map(b => ({
            target_cac: '$' + (b.target_cac_cents / 100).toFixed(2),
            target_cac_cents: b.target_cac_cents,
            type: b.baseline_type,
            notes: b.notes
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
        hour_ts?: string;
        metric_date?: string;
        sessions: number;
        unique_users: number;
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
          SELECT hour_ts, sessions, unique_users, page_views, conversions, revenue_cents,
                 by_channel, by_device, by_geo, by_utm_source
          FROM hourly_metrics
          WHERE org_tag = ?
            AND hour_ts >= datetime('now', '-${Math.min(hours, 168)} hours')
          ORDER BY hour_ts DESC
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
            SELECT metric_date, sessions, unique_users, page_views, conversions, revenue_cents,
                   by_channel, by_device, by_geo, by_utm_source
            FROM daily_metrics
            WHERE org_tag = ?
              AND metric_date >= date('now', '-${dailyDays} days')
            ORDER BY metric_date DESC
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
        unique_users: 0,
        page_views: 0,
        conversions: 0,
        revenue_cents: 0
      };
      for (const row of rows) {
        totals.sessions += row.sessions || 0;
        totals.unique_users += row.unique_users || 0;
        totals.page_views += row.page_views || 0;
        totals.conversions += row.conversions || 0;
        totals.revenue_cents += row.revenue_cents || 0;
      }

      const result: any = {
        period_hours: hours,
        data_points: rows.length,
        summary: {
          sessions: totals.sessions,
          unique_users: totals.unique_users,
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
        SELECT shopify_order_id, order_number, total_price_cents, subtotal_price_cents,
               total_tax_cents, total_discounts_cents, total_shipping_cents, currency,
               financial_status, fulfillment_status, source_name,
               utm_source, utm_medium, utm_campaign, utm_content, utm_term,
               gclid, fbclid, ttclid, landing_site_path, referring_site,
               shipping_country, shipping_province, shipping_city,
               line_items_count, total_items_quantity,
               customer_orders_count, shopify_created_at
        FROM shopify_orders
        WHERE organization_id = ?
          AND shopify_created_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (filters?.financial_status) {
        sql += ' AND financial_status = ?';
        params.push(filters.financial_status);
      }
      if (filters?.fulfillment_status) {
        sql += ' AND fulfillment_status = ?';
        params.push(filters.fulfillment_status);
      }
      if (filters?.min_total_cents) {
        sql += ' AND total_price_cents >= ?';
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

      // Product breakdown from ecommerce_orders if requested
      if (include_products) {
        try {
          const prodResult = await this.db.prepare(`
            SELECT name, COUNT(*) as order_count, SUM(price_cents) as total_revenue_cents
            FROM ecommerce_products
            WHERE organization_id = ? AND source_platform = 'shopify'
            GROUP BY name
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

      // Campaign metrics
      if (include_campaigns) {
        let campSql = `
          SELECT source_platform, name, campaign_type, status,
                 audience_count, subject_line, sent_at
          FROM comm_campaigns
          WHERE organization_id = ?
            AND (sent_at >= ? OR scheduled_at >= ?)
        `;
        const campParams: any[] = [orgId, startStr + 'T00:00:00Z', startStr + 'T00:00:00Z'];

        if (platform) {
          campSql += ' AND source_platform = ?';
          campParams.push(platform);
        }

        campSql += ' ORDER BY sent_at DESC LIMIT 100';

        const campResult = await this.db.prepare(campSql).bind(...campParams).all<any>();
        const campaigns = campResult.results || [];

        // Get engagement metrics for these campaigns
        const campaignIds = campaigns.map((c: any) => c.id).filter(Boolean);
        let engagementByType: Record<string, number> = {};

        if (campaignIds.length > 0) {
          const engSql = `
            SELECT engagement_type, COUNT(*) as count,
                   SUM(conversion_value_cents) as conversion_value_cents
            FROM comm_engagements
            WHERE organization_id = ?
              AND occurred_at >= ?
              ${platform ? 'AND source_platform = ?' : ''}
              ${channel !== 'all' ? 'AND channel = ?' : ''}
            GROUP BY engagement_type
          `;
          const engParams: any[] = [orgId, startStr + 'T00:00:00Z'];
          if (platform) engParams.push(platform);
          if (channel !== 'all') engParams.push(channel);

          const engResult = await this.db.prepare(engSql).bind(...engParams).all<{
            engagement_type: string;
            count: number;
            conversion_value_cents: number | null;
          }>();

          for (const r of engResult.results || []) {
            engagementByType[r.engagement_type] = r.count;
          }
        }

        const totalSent = engagementByType['sent'] || engagementByType['delivered'] || campaigns.reduce((s: number, c: any) => s + (c.audience_count || 0), 0);
        const totalOpens = engagementByType['open'] || engagementByType['opened'] || 0;
        const totalClicks = engagementByType['click'] || engagementByType['clicked'] || 0;
        const totalBounces = engagementByType['bounce'] || engagementByType['bounced'] || 0;
        const totalUnsubscribes = engagementByType['unsubscribe'] || engagementByType['unsubscribed'] || 0;
        const totalConversions = engagementByType['conversion'] || engagementByType['purchase'] || 0;

        response.campaign_summary = {
          total_campaigns: campaigns.length,
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

        response.recent_campaigns = campaigns.slice(0, 20).map((c: any) => ({
          platform: c.source_platform,
          name: c.name,
          type: c.campaign_type,
          status: c.status,
          audience: c.audience_count,
          subject: c.subject_line,
          sent_at: c.sent_at
        }));

        response.engagement_by_type = engagementByType;
      }

      // Subscriber health
      if (include_subscriber_health) {
        let subSql = `
          SELECT
            COUNT(*) as total_subscribers,
            COUNT(CASE WHEN email_status = 'subscribed' THEN 1 END) as email_subscribed,
            COUNT(CASE WHEN email_status = 'unsubscribed' THEN 1 END) as email_unsubscribed,
            COUNT(CASE WHEN sms_status = 'subscribed' THEN 1 END) as sms_subscribed,
            AVG(email_open_rate) as avg_open_rate,
            AVG(email_click_rate) as avg_click_rate,
            AVG(total_emails_received) as avg_emails_received,
            AVG(total_emails_opened) as avg_emails_opened
          FROM comm_subscribers
          WHERE organization_id = ?
        `;
        const subParams: any[] = [orgId];
        if (platform) {
          subSql += ' AND source_platform = ?';
          subParams.push(platform);
        }

        const subResult = await this.db.prepare(subSql).bind(...subParams).first<any>();

        if (subResult) {
          response.subscriber_health = {
            total_subscribers: subResult.total_subscribers || 0,
            email_subscribed: subResult.email_subscribed || 0,
            email_unsubscribed: subResult.email_unsubscribed || 0,
            sms_subscribed: subResult.sms_subscribed || 0,
            avg_open_rate: subResult.avg_open_rate ? (subResult.avg_open_rate * 100).toFixed(1) + '%' : 'N/A',
            avg_click_rate: subResult.avg_click_rate ? (subResult.avg_click_rate * 100).toFixed(1) + '%' : 'N/A',
            avg_emails_per_subscriber: subResult.avg_emails_received ? Math.round(subResult.avg_emails_received) : 0,
            list_health: subResult.total_subscribers > 0
              ? ((subResult.email_subscribed || 0) / subResult.total_subscribers * 100).toFixed(0) + '% active'
              : 'N/A'
          };
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
   * Query unified e-commerce analytics
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
      // Orders summary
      let orderSql = `
        SELECT source_platform, status, financial_status, fulfillment_status,
               total_cents, discount_cents, shipping_cents, tax_cents,
               item_count, utm_source, utm_medium, utm_campaign, ordered_at
        FROM ecommerce_orders
        WHERE organization_id = ?
          AND ordered_at >= ?
      `;
      const orderParams: any[] = [orgId, startStr + 'T00:00:00Z'];

      if (platform) {
        orderSql += ' AND source_platform = ?';
        orderParams.push(platform);
      }
      orderSql += ' ORDER BY ordered_at DESC LIMIT 2000';

      const orderResult = await this.db.prepare(orderSql).bind(...orderParams).all<any>();
      const orders = orderResult.results || [];

      if (orders.length === 0) {
        return { success: true, data: { note: 'No e-commerce orders in period', summary: { total_revenue: '$0.00', total_orders: 0 } } };
      }

      const totalRevenue = orders.reduce((s: number, o: any) => s + (o.total_cents || 0), 0);
      const totalDiscounts = orders.reduce((s: number, o: any) => s + (o.discount_cents || 0), 0);
      const totalItems = orders.reduce((s: number, o: any) => s + (o.item_count || 0), 0);
      const paidOrders = orders.filter((o: any) => o.financial_status === 'paid' || o.status === 'completed');
      const cancelledOrders = orders.filter((o: any) => o.cancelled_at || o.status === 'cancelled');
      const withUtm = orders.filter((o: any) => o.utm_source);

      const response: any = {
        summary: {
          total_revenue: '$' + (totalRevenue / 100).toFixed(2),
          total_revenue_cents: totalRevenue,
          total_orders: orders.length,
          paid_orders: paidOrders.length,
          cancelled_orders: cancelledOrders.length,
          avg_order_value: '$' + (orders.length > 0 ? (totalRevenue / 100 / orders.length).toFixed(2) : '0.00'),
          total_discounts: '$' + (totalDiscounts / 100).toFixed(2),
          total_items_sold: totalItems,
          orders_with_utm: withUtm.length,
          utm_coverage: orders.length > 0 ? Math.round(withUtm.length / orders.length * 100) + '%' : 'N/A',
          platforms: [...new Set(orders.map((o: any) => o.source_platform))].filter(Boolean)
        }
      };

      // Grouped data
      const grouped = new Map<string, { revenue_cents: number; count: number; items: number }>();
      for (const order of orders) {
        let key: string;
        switch (group_by) {
          case 'platform':
            key = order.source_platform || 'unknown';
            break;
          case 'status':
            key = order.financial_status || order.status || 'unknown';
            break;
          case 'utm_source':
            key = order.utm_source || '(direct)';
            break;
          case 'utm_campaign':
            key = order.utm_campaign || '(none)';
            break;
          default:
            key = (order.ordered_at || '').split('T')[0];
        }
        if (!grouped.has(key)) grouped.set(key, { revenue_cents: 0, count: 0, items: 0 });
        const g = grouped.get(key)!;
        g.revenue_cents += order.total_cents || 0;
        g.count += 1;
        g.items += order.item_count || 0;
      }

      response.grouped = Array.from(grouped.entries())
        .sort((a, b) => group_by === 'day' ? a[0].localeCompare(b[0]) : b[1].revenue_cents - a[1].revenue_cents)
        .map(([key, data]) => ({
          [group_by]: key,
          revenue: '$' + (data.revenue_cents / 100).toFixed(2),
          orders: data.count,
          items: data.items
        }));

      // Product breakdown
      if (include_products) {
        try {
          let prodSql = `
            SELECT name, vendor, product_type, status, price_cents, inventory_quantity
            FROM ecommerce_products
            WHERE organization_id = ?
          `;
          const prodParams: any[] = [orgId];
          if (platform) {
            prodSql += ' AND source_platform = ?';
            prodParams.push(platform);
          }
          prodSql += ' ORDER BY price_cents DESC LIMIT 50';

          const prodResult = await this.db.prepare(prodSql).bind(...prodParams).all<any>();
          response.products = (prodResult.results || []).map((p: any) => ({
            name: p.name,
            vendor: p.vendor,
            type: p.product_type,
            status: p.status,
            price: '$' + ((p.price_cents || 0) / 100).toFixed(2),
            inventory: p.inventory_quantity
          }));
        } catch {
          response.products = [];
        }
      }

      // Customer cohort metrics
      if (include_customers) {
        try {
          let custSql = `
            SELECT
              COUNT(*) as total_customers,
              AVG(total_orders) as avg_orders,
              AVG(total_spent_cents) as avg_ltv_cents,
              COUNT(CASE WHEN total_orders = 1 THEN 1 END) as single_purchase,
              COUNT(CASE WHEN total_orders > 1 THEN 1 END) as repeat_customers,
              COUNT(CASE WHEN accepts_marketing = 1 THEN 1 END) as marketing_opted_in
            FROM ecommerce_customers
            WHERE organization_id = ?
          `;
          const custParams: any[] = [orgId];
          if (platform) {
            custSql += ' AND source_platform = ?';
            custParams.push(platform);
          }

          const custResult = await this.db.prepare(custSql).bind(...custParams).first<any>();
          if (custResult) {
            response.customers = {
              total_customers: custResult.total_customers || 0,
              avg_orders_per_customer: custResult.avg_orders ? Math.round(custResult.avg_orders * 10) / 10 : 0,
              avg_ltv: '$' + ((custResult.avg_ltv_cents || 0) / 100).toFixed(2),
              single_purchase_customers: custResult.single_purchase || 0,
              repeat_customers: custResult.repeat_customers || 0,
              repeat_rate: custResult.total_customers > 0 ? Math.round((custResult.repeat_customers || 0) / custResult.total_customers * 100) + '%' : 'N/A',
              marketing_opted_in: custResult.marketing_opted_in || 0
            };
          }
        } catch {
          response.customers = null;
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'E-commerce tables not yet created', summary: { total_revenue: '$0.00', total_orders: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query support ticket and conversation metrics
   */
  private async querySupportMetrics(
    input: QuerySupportMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, include_satisfaction = true, include_conversations = false, group_by } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Ticket summary
      let ticketSql = `
        SELECT
          COUNT(*) as total_tickets,
          COUNT(CASE WHEN status = 'open' OR status = 'new' THEN 1 END) as open_tickets,
          COUNT(CASE WHEN status = 'solved' OR status = 'closed' THEN 1 END) as resolved_tickets,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_tickets,
          AVG(CASE WHEN first_response_at IS NOT NULL AND opened_at IS NOT NULL
            THEN (julianday(first_response_at) - julianday(opened_at)) * 24
          END) as avg_first_response_hours,
          AVG(CASE WHEN full_resolution_at IS NOT NULL AND opened_at IS NOT NULL
            THEN (julianday(full_resolution_at) - julianday(opened_at)) * 24
          END) as avg_resolution_hours,
          AVG(reply_count) as avg_replies,
          AVG(reopened_count) as avg_reopens
        FROM support_tickets
        WHERE organization_id = ?
          AND opened_at >= ?
      `;
      const ticketParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        ticketSql += ' AND source_platform = ?';
        ticketParams.push(platform);
      }

      const ticketResult = await this.db.prepare(ticketSql).bind(...ticketParams).first<any>();

      const response: any = {
        ticket_summary: {
          total_tickets: ticketResult?.total_tickets || 0,
          open_tickets: ticketResult?.open_tickets || 0,
          resolved_tickets: ticketResult?.resolved_tickets || 0,
          pending_tickets: ticketResult?.pending_tickets || 0,
          resolution_rate: ticketResult?.total_tickets > 0
            ? Math.round((ticketResult.resolved_tickets || 0) / ticketResult.total_tickets * 100) + '%'
            : 'N/A',
          avg_first_response_hours: ticketResult?.avg_first_response_hours
            ? Math.round(ticketResult.avg_first_response_hours * 10) / 10
            : null,
          avg_resolution_hours: ticketResult?.avg_resolution_hours
            ? Math.round(ticketResult.avg_resolution_hours * 10) / 10
            : null,
          avg_replies_per_ticket: ticketResult?.avg_replies
            ? Math.round(ticketResult.avg_replies * 10) / 10
            : 0
        }
      };

      // Satisfaction
      if (include_satisfaction) {
        let satSql = `
          SELECT
            satisfaction_rating,
            COUNT(*) as count
          FROM support_tickets
          WHERE organization_id = ?
            AND opened_at >= ?
            AND satisfaction_rating IS NOT NULL
        `;
        const satParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          satSql += ' AND source_platform = ?';
          satParams.push(platform);
        }
        satSql += ' GROUP BY satisfaction_rating ORDER BY satisfaction_rating DESC';

        const satResult = await this.db.prepare(satSql).bind(...satParams).all<{
          satisfaction_rating: string;
          count: number;
        }>();

        const ratings = satResult.results || [];
        const totalRated = ratings.reduce((s, r) => s + r.count, 0);
        const goodRatings = ratings.filter(r =>
          r.satisfaction_rating === 'good' || r.satisfaction_rating === 'great' || r.satisfaction_rating === '5' || r.satisfaction_rating === '4'
        ).reduce((s, r) => s + r.count, 0);

        response.satisfaction = {
          total_rated: totalRated,
          csat_score: totalRated > 0 ? Math.round(goodRatings / totalRated * 100) + '%' : 'N/A',
          distribution: ratings.map(r => ({ rating: r.satisfaction_rating, count: r.count }))
        };
      }

      // Grouped breakdown
      if (group_by) {
        let grpCol: string;
        switch (group_by) {
          case 'day': grpCol = "date(opened_at)"; break;
          case 'status': grpCol = 'status'; break;
          case 'priority': grpCol = 'priority'; break;
          case 'channel': grpCol = 'channel'; break;
          case 'assignee': grpCol = 'assignee_name'; break;
          default: grpCol = 'status';
        }

        let grpSql = `
          SELECT ${grpCol} as dimension, COUNT(*) as count
          FROM support_tickets
          WHERE organization_id = ? AND opened_at >= ?
        `;
        const grpParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          grpSql += ' AND source_platform = ?';
          grpParams.push(platform);
        }
        grpSql += ` GROUP BY ${grpCol} ORDER BY count DESC LIMIT 30`;

        const grpResult = await this.db.prepare(grpSql).bind(...grpParams).all<{ dimension: string | null; count: number }>();
        response.grouped = (grpResult.results || []).map(r => ({
          [group_by]: r.dimension || '(unknown)',
          tickets: r.count
        }));
      }

      // Conversations
      if (include_conversations) {
        let convSql = `
          SELECT
            COUNT(*) as total_conversations,
            COUNT(CASE WHEN state = 'open' THEN 1 END) as open_conversations,
            COUNT(CASE WHEN state = 'closed' THEN 1 END) as closed_conversations,
            AVG(message_count) as avg_messages,
            AVG(admin_reply_count) as avg_admin_replies,
            AVG(user_reply_count) as avg_user_replies
          FROM support_conversations
          WHERE organization_id = ?
            AND started_at >= ?
        `;
        const convParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          convSql += ' AND source_platform = ?';
          convParams.push(platform);
        }

        const convResult = await this.db.prepare(convSql).bind(...convParams).first<any>();
        response.conversations = {
          total: convResult?.total_conversations || 0,
          open: convResult?.open_conversations || 0,
          closed: convResult?.closed_conversations || 0,
          avg_messages: convResult?.avg_messages ? Math.round(convResult.avg_messages * 10) / 10 : 0,
          avg_admin_replies: convResult?.avg_admin_replies ? Math.round(convResult.avg_admin_replies * 10) / 10 : 0,
          avg_user_replies: convResult?.avg_user_replies ? Math.round(convResult.avg_user_replies * 10) / 10 : 0
        };
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Support tables not yet created', ticket_summary: { total_tickets: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query scheduling/appointment metrics
   */
  private async querySchedulingMetrics(
    input: QuerySchedulingMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, include_services = true, group_by } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      let sql = `
        SELECT
          COUNT(*) as total_appointments,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'cancelled' OR status = 'canceled' THEN 1 END) as cancelled,
          COUNT(CASE WHEN status = 'no_show' OR status = 'noshow' THEN 1 END) as no_shows,
          COUNT(CASE WHEN status = 'scheduled' OR status = 'confirmed' THEN 1 END) as upcoming,
          SUM(price_cents) as total_revenue_cents,
          AVG(duration_minutes) as avg_duration,
          COUNT(DISTINCT assignee_id) as unique_assignees,
          COUNT(CASE WHEN utm_source IS NOT NULL THEN 1 END) as with_utm
        FROM scheduling_appointments
        WHERE organization_id = ?
          AND (booked_at >= ? OR start_time >= ?)
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z', startStr + 'T00:00:00Z'];
      if (platform) {
        sql += ' AND source_platform = ?';
        params.push(platform);
      }

      const result = await this.db.prepare(sql).bind(...params).first<any>();

      const total = result?.total_appointments || 0;
      const response: any = {
        summary: {
          total_appointments: total,
          completed: result?.completed || 0,
          cancelled: result?.cancelled || 0,
          no_shows: result?.no_shows || 0,
          upcoming: result?.upcoming || 0,
          completion_rate: total > 0 ? Math.round((result?.completed || 0) / total * 100) + '%' : 'N/A',
          cancellation_rate: total > 0 ? Math.round((result?.cancelled || 0) / total * 100) + '%' : 'N/A',
          no_show_rate: total > 0 ? Math.round((result?.no_shows || 0) / total * 100) + '%' : 'N/A',
          total_revenue: '$' + ((result?.total_revenue_cents || 0) / 100).toFixed(2),
          avg_duration_minutes: result?.avg_duration ? Math.round(result.avg_duration) : null,
          unique_assignees: result?.unique_assignees || 0,
          utm_coverage: total > 0 ? Math.round((result?.with_utm || 0) / total * 100) + '%' : 'N/A'
        }
      };

      // Grouped breakdown
      if (group_by) {
        let grpCol: string;
        switch (group_by) {
          case 'day': grpCol = "date(booked_at)"; break;
          case 'status': grpCol = 'status'; break;
          case 'assignee': grpCol = 'assignee_name'; break;
          case 'utm_source': grpCol = 'utm_source'; break;
          case 'service': grpCol = 'service_external_id'; break;
          default: grpCol = 'status';
        }

        let grpSql = `
          SELECT ${grpCol} as dimension, COUNT(*) as count, SUM(price_cents) as revenue_cents
          FROM scheduling_appointments
          WHERE organization_id = ? AND (booked_at >= ? OR start_time >= ?)
        `;
        const grpParams: any[] = [orgId, startStr + 'T00:00:00Z', startStr + 'T00:00:00Z'];
        if (platform) {
          grpSql += ' AND source_platform = ?';
          grpParams.push(platform);
        }
        grpSql += ` GROUP BY ${grpCol} ORDER BY count DESC LIMIT 30`;

        const grpResult = await this.db.prepare(grpSql).bind(...grpParams).all<{ dimension: string | null; count: number; revenue_cents: number | null }>();
        response.grouped = (grpResult.results || []).map(r => ({
          [group_by]: r.dimension || '(unknown)',
          appointments: r.count,
          revenue: '$' + ((r.revenue_cents || 0) / 100).toFixed(2)
        }));
      }

      // Service breakdown
      if (include_services) {
        try {
          let svcSql = `
            SELECT name, duration_minutes, price_cents, status, booking_url, category
            FROM scheduling_services
            WHERE organization_id = ?
          `;
          const svcParams: any[] = [orgId];
          if (platform) {
            svcSql += ' AND source_platform = ?';
            svcParams.push(platform);
          }
          svcSql += ' ORDER BY price_cents DESC LIMIT 20';

          const svcResult = await this.db.prepare(svcSql).bind(...svcParams).all<any>();
          response.services = (svcResult.results || []).map((s: any) => ({
            name: s.name,
            duration: s.duration_minutes ? s.duration_minutes + ' min' : null,
            price: '$' + ((s.price_cents || 0) / 100).toFixed(2),
            status: s.status,
            category: s.category
          }));
        } catch {
          response.services = [];
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Scheduling tables not yet created', summary: { total_appointments: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query form submission metrics
   */
  private async queryFormSubmissions(
    input: QueryFormSubmissionsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, form_id, group_by, include_utm_breakdown = true } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      let sql = `
        SELECT
          COUNT(*) as total_submissions,
          COUNT(CASE WHEN status = 'completed' OR status IS NULL THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'partial' THEN 1 END) as partial,
          AVG(time_to_complete_seconds) as avg_completion_time_secs,
          AVG(score) as avg_score,
          COUNT(CASE WHEN utm_source IS NOT NULL THEN 1 END) as with_utm,
          COUNT(DISTINCT form_external_id) as unique_forms
        FROM forms_submissions
        WHERE organization_id = ?
          AND submitted_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        sql += ' AND source_platform = ?';
        params.push(platform);
      }
      if (form_id) {
        sql += ' AND form_external_id = ?';
        params.push(form_id);
      }

      const result = await this.db.prepare(sql).bind(...params).first<any>();
      const total = result?.total_submissions || 0;

      const response: any = {
        summary: {
          total_submissions: total,
          completed: result?.completed || 0,
          partial: result?.partial || 0,
          completion_rate: total > 0 ? Math.round((result?.completed || 0) / total * 100) + '%' : 'N/A',
          avg_completion_time: result?.avg_completion_time_secs
            ? Math.round(result.avg_completion_time_secs) + 's'
            : null,
          avg_score: result?.avg_score ? Math.round(result.avg_score * 10) / 10 : null,
          unique_forms: result?.unique_forms || 0,
          utm_coverage: total > 0 ? Math.round((result?.with_utm || 0) / total * 100) + '%' : 'N/A'
        }
      };

      // UTM breakdown
      if (include_utm_breakdown) {
        let utmSql = `
          SELECT utm_source, utm_campaign, COUNT(*) as count
          FROM forms_submissions
          WHERE organization_id = ?
            AND submitted_at >= ?
            AND utm_source IS NOT NULL
        `;
        const utmParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          utmSql += ' AND source_platform = ?';
          utmParams.push(platform);
        }
        utmSql += ' GROUP BY utm_source, utm_campaign ORDER BY count DESC LIMIT 20';

        const utmResult = await this.db.prepare(utmSql).bind(...utmParams).all<{
          utm_source: string;
          utm_campaign: string | null;
          count: number;
        }>();

        response.utm_breakdown = (utmResult.results || []).map(r => ({
          source: r.utm_source,
          campaign: r.utm_campaign,
          submissions: r.count,
          pct: total > 0 ? Math.round(r.count / total * 100) : 0
        }));
      }

      // Group by dimension
      if (group_by) {
        let grpCol: string;
        switch (group_by) {
          case 'day': grpCol = "date(submitted_at)"; break;
          case 'form': grpCol = 'form_external_id'; break;
          case 'utm_source': grpCol = 'utm_source'; break;
          case 'utm_campaign': grpCol = 'utm_campaign'; break;
          case 'device_type': grpCol = 'device_type'; break;
          default: grpCol = "date(submitted_at)";
        }

        let grpSql = `
          SELECT ${grpCol} as dimension, COUNT(*) as count
          FROM forms_submissions
          WHERE organization_id = ? AND submitted_at >= ?
        `;
        const grpParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          grpSql += ' AND source_platform = ?';
          grpParams.push(platform);
        }
        grpSql += ` GROUP BY ${grpCol} ORDER BY count DESC LIMIT 30`;

        const grpResult = await this.db.prepare(grpSql).bind(...grpParams).all<{ dimension: string | null; count: number }>();
        response.grouped = (grpResult.results || []).map(r => ({
          [group_by]: r.dimension || '(unknown)',
          submissions: r.count
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Forms tables not yet created', summary: { total_submissions: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query accounting invoices and expenses
   */
  private async queryAccountingMetrics(
    input: QueryAccountingMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, data_type = 'both', group_by } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      const response: any = {};

      // Invoices
      if (data_type === 'invoices' || data_type === 'both') {
        let invSql = `
          SELECT
            COUNT(*) as total_invoices,
            COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid,
            COUNT(CASE WHEN status = 'open' OR status = 'sent' THEN 1 END) as outstanding,
            COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue,
            SUM(total_cents) as total_invoiced_cents,
            SUM(amount_paid_cents) as total_collected_cents,
            SUM(balance_due_cents) as total_outstanding_cents,
            AVG(total_cents) as avg_invoice_cents
          FROM accounting_invoices
          WHERE organization_id = ?
            AND invoice_date >= ?
        `;
        const invParams: any[] = [orgId, startStr];
        if (platform) {
          invSql += ' AND source_platform = ?';
          invParams.push(platform);
        }

        const invResult = await this.db.prepare(invSql).bind(...invParams).first<any>();

        response.invoices = {
          total_invoices: invResult?.total_invoices || 0,
          paid: invResult?.paid || 0,
          outstanding: invResult?.outstanding || 0,
          overdue: invResult?.overdue || 0,
          total_invoiced: '$' + ((invResult?.total_invoiced_cents || 0) / 100).toFixed(2),
          total_collected: '$' + ((invResult?.total_collected_cents || 0) / 100).toFixed(2),
          total_outstanding: '$' + ((invResult?.total_outstanding_cents || 0) / 100).toFixed(2),
          avg_invoice_value: '$' + ((invResult?.avg_invoice_cents || 0) / 100).toFixed(2),
          collection_rate: (invResult?.total_invoiced_cents || 0) > 0
            ? Math.round((invResult?.total_collected_cents || 0) / invResult.total_invoiced_cents * 100) + '%'
            : 'N/A'
        };
      }

      // Expenses
      if (data_type === 'expenses' || data_type === 'both') {
        let expSql = `
          SELECT
            COUNT(*) as total_expenses,
            SUM(total_cents) as total_expense_cents,
            AVG(total_cents) as avg_expense_cents,
            COUNT(DISTINCT category) as unique_categories,
            COUNT(DISTINCT vendor_name) as unique_vendors
          FROM accounting_expenses
          WHERE organization_id = ?
            AND expense_date >= ?
        `;
        const expParams: any[] = [orgId, startStr];
        if (platform) {
          expSql += ' AND source_platform = ?';
          expParams.push(platform);
        }

        const expResult = await this.db.prepare(expSql).bind(...expParams).first<any>();

        response.expenses = {
          total_expenses: expResult?.total_expenses || 0,
          total_amount: '$' + ((expResult?.total_expense_cents || 0) / 100).toFixed(2),
          avg_expense: '$' + ((expResult?.avg_expense_cents || 0) / 100).toFixed(2),
          unique_categories: expResult?.unique_categories || 0,
          unique_vendors: expResult?.unique_vendors || 0
        };

        // Category breakdown
        let catSql = `
          SELECT category, COUNT(*) as count, SUM(total_cents) as total_cents
          FROM accounting_expenses
          WHERE organization_id = ? AND expense_date >= ?
        `;
        const catParams: any[] = [orgId, startStr];
        if (platform) {
          catSql += ' AND source_platform = ?';
          catParams.push(platform);
        }
        catSql += ' GROUP BY category ORDER BY total_cents DESC LIMIT 15';

        const catResult = await this.db.prepare(catSql).bind(...catParams).all<{
          category: string | null;
          count: number;
          total_cents: number;
        }>();

        response.expense_categories = (catResult.results || []).map(r => ({
          category: r.category || '(uncategorized)',
          count: r.count,
          total: '$' + ((r.total_cents || 0) / 100).toFixed(2)
        }));
      }

      // P&L summary if both types
      if (data_type === 'both' && response.invoices && response.expenses) {
        const invoicedCents = parseInt(String(response.invoices.total_invoiced).replace(/[$,]/g, '')) * 100 || 0;
        const collectedCents = parseInt(String(response.invoices.total_collected).replace(/[$,]/g, '')) * 100 || 0;
        const expenseCents = parseInt(String(response.expenses.total_amount).replace(/[$,]/g, '')) * 100 || 0;
        // Re-parse from raw numbers
        response.profit_loss = {
          note: 'Approximate P&L from accounting data only (excludes ad platform spend)'
        };
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Accounting tables not yet created' } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query review and reputation metrics
   */
  private async queryReviews(
    input: QueryReviewsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, min_rating, include_sentiment = true } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      let sql = `
        SELECT
          COUNT(*) as total_reviews,
          AVG(rating) as avg_rating,
          MIN(rating) as min_rating,
          MAX(rating) as max_rating,
          COUNT(CASE WHEN rating >= 4 THEN 1 END) as positive_reviews,
          COUNT(CASE WHEN rating <= 2 THEN 1 END) as negative_reviews,
          COUNT(CASE WHEN is_verified = 1 OR reviewer_verified = 1 THEN 1 END) as verified_reviews,
          COUNT(CASE WHEN is_incentivized = 1 THEN 1 END) as incentivized_reviews,
          COUNT(DISTINCT source_platform) as platforms
        FROM reviews_items
        WHERE organization_id = ?
          AND reviewed_at >= ?
      `;
      const params: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        sql += ' AND source_platform = ?';
        params.push(platform);
      }
      if (min_rating) {
        sql += ' AND rating >= ?';
        params.push(min_rating);
      }

      const result = await this.db.prepare(sql).bind(...params).first<any>();
      const total = result?.total_reviews || 0;

      const response: any = {
        summary: {
          total_reviews: total,
          avg_rating: result?.avg_rating ? Math.round(result.avg_rating * 10) / 10 : null,
          rating_range: result?.min_rating && result?.max_rating
            ? `${result.min_rating}-${result.max_rating}`
            : null,
          positive_reviews: result?.positive_reviews || 0,
          negative_reviews: result?.negative_reviews || 0,
          positive_rate: total > 0
            ? Math.round((result?.positive_reviews || 0) / total * 100) + '%'
            : 'N/A',
          verified_reviews: result?.verified_reviews || 0,
          incentivized_reviews: result?.incentivized_reviews || 0,
          platforms_count: result?.platforms || 0
        }
      };

      // Rating distribution
      let distSql = `
        SELECT rating, COUNT(*) as count
        FROM reviews_items
        WHERE organization_id = ? AND reviewed_at >= ?
      `;
      const distParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        distSql += ' AND source_platform = ?';
        distParams.push(platform);
      }
      distSql += ' GROUP BY rating ORDER BY rating DESC';

      const distResult = await this.db.prepare(distSql).bind(...distParams).all<{ rating: number; count: number }>();
      response.rating_distribution = (distResult.results || []).map(r => ({
        rating: r.rating,
        count: r.count,
        pct: total > 0 ? Math.round(r.count / total * 100) : 0
      }));

      // Sentiment analysis
      if (include_sentiment) {
        let sentSql = `
          SELECT sentiment, COUNT(*) as count, AVG(sentiment_score) as avg_score
          FROM reviews_items
          WHERE organization_id = ? AND reviewed_at >= ?
            AND sentiment IS NOT NULL
        `;
        const sentParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          sentSql += ' AND source_platform = ?';
          sentParams.push(platform);
        }
        sentSql += ' GROUP BY sentiment ORDER BY count DESC';

        const sentResult = await this.db.prepare(sentSql).bind(...sentParams).all<{
          sentiment: string;
          count: number;
          avg_score: number | null;
        }>();

        response.sentiment = (sentResult.results || []).map(r => ({
          sentiment: r.sentiment,
          count: r.count,
          avg_score: r.avg_score ? Math.round(r.avg_score * 100) / 100 : null
        }));
      }

      // Recent notable reviews
      let recentSql = `
        SELECT source_platform, rating, title, body, reviewer_name,
               product_name, sentiment, reviewed_at
        FROM reviews_items
        WHERE organization_id = ? AND reviewed_at >= ?
      `;
      const recentParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        recentSql += ' AND source_platform = ?';
        recentParams.push(platform);
      }
      recentSql += ' ORDER BY reviewed_at DESC LIMIT 10';

      const recentResult = await this.db.prepare(recentSql).bind(...recentParams).all<any>();
      response.recent_reviews = (recentResult.results || []).map((r: any) => ({
        platform: r.source_platform,
        rating: r.rating,
        title: r.title,
        body: r.body ? (r.body.length > 200 ? r.body.substring(0, 200) + '...' : r.body) : null,
        reviewer: r.reviewer_name,
        product: r.product_name,
        sentiment: r.sentiment,
        date: r.reviewed_at
      }));

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Reviews tables not yet created', summary: { total_reviews: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query affiliate/partner program metrics
   */
  private async queryAffiliateMetrics(
    input: QueryAffiliateMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, include_partners = true, group_by } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Referrals summary
      let refSql = `
        SELECT
          COUNT(*) as total_referrals,
          COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
          COUNT(DISTINCT partner_external_id) as unique_partners,
          COUNT(DISTINCT visitor_id) as unique_visitors
        FROM affiliate_referrals
        WHERE organization_id = ?
          AND referred_at >= ?
      `;
      const refParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        refSql += ' AND source_platform = ?';
        refParams.push(platform);
      }

      const refResult = await this.db.prepare(refSql).bind(...refParams).first<any>();

      // Conversions summary
      let convSql = `
        SELECT
          COUNT(*) as total_conversions,
          SUM(sale_amount_cents) as total_sales_cents,
          SUM(commission_cents) as total_commission_cents,
          COUNT(CASE WHEN is_recurring = 1 THEN 1 END) as recurring_conversions,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_approval
        FROM affiliate_conversions
        WHERE organization_id = ?
          AND converted_at >= ?
      `;
      const convParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        convSql += ' AND source_platform = ?';
        convParams.push(platform);
      }

      const convResult = await this.db.prepare(convSql).bind(...convParams).first<any>();

      const totalReferrals = refResult?.total_referrals || 0;
      const totalConversions = convResult?.total_conversions || 0;
      const totalSales = convResult?.total_sales_cents || 0;
      const totalCommission = convResult?.total_commission_cents || 0;

      const response: any = {
        summary: {
          total_referrals: totalReferrals,
          converted_referrals: refResult?.converted || 0,
          referral_conversion_rate: totalReferrals > 0
            ? Math.round((refResult?.converted || 0) / totalReferrals * 100) + '%'
            : 'N/A',
          unique_partners: refResult?.unique_partners || 0,
          total_conversions: totalConversions,
          total_sales: '$' + (totalSales / 100).toFixed(2),
          total_commission: '$' + (totalCommission / 100).toFixed(2),
          commission_rate: totalSales > 0
            ? (totalCommission / totalSales * 100).toFixed(1) + '%'
            : 'N/A',
          recurring_conversions: convResult?.recurring_conversions || 0,
          approved_conversions: convResult?.approved || 0,
          pending_approval: convResult?.pending_approval || 0
        }
      };

      // Partner breakdown
      if (include_partners) {
        let partnerSql = `
          SELECT
            ac.partner_external_id,
            COUNT(*) as conversions,
            SUM(ac.sale_amount_cents) as sales_cents,
            SUM(ac.commission_cents) as commission_cents
          FROM affiliate_conversions ac
          WHERE ac.organization_id = ?
            AND ac.converted_at >= ?
        `;
        const partnerParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          partnerSql += ' AND ac.source_platform = ?';
          partnerParams.push(platform);
        }
        partnerSql += ' GROUP BY ac.partner_external_id ORDER BY sales_cents DESC LIMIT 20';

        const partnerResult = await this.db.prepare(partnerSql).bind(...partnerParams).all<{
          partner_external_id: string;
          conversions: number;
          sales_cents: number;
          commission_cents: number;
        }>();

        response.top_partners = (partnerResult.results || []).map(p => ({
          partner_id: p.partner_external_id,
          conversions: p.conversions,
          sales: '$' + ((p.sales_cents || 0) / 100).toFixed(2),
          commission: '$' + ((p.commission_cents || 0) / 100).toFixed(2),
          pct_of_sales: totalSales > 0 ? Math.round((p.sales_cents || 0) / totalSales * 100) : 0
        }));
      }

      // Group by dimension
      if (group_by) {
        let grpCol: string;
        switch (group_by) {
          case 'day': grpCol = "date(converted_at)"; break;
          case 'partner': grpCol = 'partner_external_id'; break;
          case 'status': grpCol = 'status'; break;
          case 'conversion_type': grpCol = 'conversion_type'; break;
          default: grpCol = "date(converted_at)";
        }

        let grpSql = `
          SELECT ${grpCol} as dimension, COUNT(*) as count,
                 SUM(sale_amount_cents) as sales_cents,
                 SUM(commission_cents) as commission_cents
          FROM affiliate_conversions
          WHERE organization_id = ? AND converted_at >= ?
        `;
        const grpParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          grpSql += ' AND source_platform = ?';
          grpParams.push(platform);
        }
        grpSql += ` GROUP BY ${grpCol} ORDER BY sales_cents DESC LIMIT 30`;

        const grpResult = await this.db.prepare(grpSql).bind(...grpParams).all<{
          dimension: string | null;
          count: number;
          sales_cents: number;
          commission_cents: number;
        }>();

        response.grouped = (grpResult.results || []).map(r => ({
          [group_by]: r.dimension || '(unknown)',
          conversions: r.count,
          sales: '$' + ((r.sales_cents || 0) / 100).toFixed(2),
          commission: '$' + ((r.commission_cents || 0) / 100).toFixed(2)
        }));
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Affiliate tables not yet created', summary: { total_referrals: 0, total_conversions: 0 } } };
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Query organic social media metrics
   */
  private async querySocialMetrics(
    input: QuerySocialMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { days, platform, include_posts = false, include_follower_trends = true } = input;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      // Post performance summary
      let postSql = `
        SELECT
          COUNT(*) as total_posts,
          SUM(impressions) as total_impressions,
          SUM(reach) as total_reach,
          SUM(likes) as total_likes,
          SUM(comments) as total_comments,
          SUM(shares) as total_shares,
          SUM(saves) as total_saves,
          SUM(clicks) as total_clicks,
          SUM(video_views) as total_video_views,
          AVG(engagement_rate) as avg_engagement_rate,
          COUNT(DISTINCT source_platform) as platforms
        FROM social_posts
        WHERE organization_id = ?
          AND published_at >= ?
      `;
      const postParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        postSql += ' AND source_platform = ?';
        postParams.push(platform);
      }

      const postResult = await this.db.prepare(postSql).bind(...postParams).first<any>();

      const totalPosts = postResult?.total_posts || 0;
      const totalImpressions = postResult?.total_impressions || 0;
      const totalEngagements = (postResult?.total_likes || 0) + (postResult?.total_comments || 0)
        + (postResult?.total_shares || 0) + (postResult?.total_saves || 0);

      const response: any = {
        post_summary: {
          total_posts: totalPosts,
          total_impressions: totalImpressions,
          total_reach: postResult?.total_reach || 0,
          total_engagements: totalEngagements,
          total_likes: postResult?.total_likes || 0,
          total_comments: postResult?.total_comments || 0,
          total_shares: postResult?.total_shares || 0,
          total_saves: postResult?.total_saves || 0,
          total_clicks: postResult?.total_clicks || 0,
          total_video_views: postResult?.total_video_views || 0,
          avg_engagement_rate: postResult?.avg_engagement_rate
            ? (postResult.avg_engagement_rate * 100).toFixed(2) + '%'
            : 'N/A',
          calculated_engagement_rate: totalImpressions > 0
            ? (totalEngagements / totalImpressions * 100).toFixed(2) + '%'
            : 'N/A',
          platforms_count: postResult?.platforms || 0
        }
      };

      // Per-platform breakdown
      let platSql = `
        SELECT source_platform,
               COUNT(*) as posts,
               SUM(impressions) as impressions,
               SUM(likes) as likes,
               SUM(comments) as comments,
               SUM(shares) as shares,
               SUM(clicks) as clicks,
               AVG(engagement_rate) as avg_engagement_rate
        FROM social_posts
        WHERE organization_id = ? AND published_at >= ?
      `;
      const platParams: any[] = [orgId, startStr + 'T00:00:00Z'];
      if (platform) {
        platSql += ' AND source_platform = ?';
        platParams.push(platform);
      }
      platSql += ' GROUP BY source_platform ORDER BY impressions DESC';

      const platResult = await this.db.prepare(platSql).bind(...platParams).all<any>();
      response.by_platform = (platResult.results || []).map((r: any) => ({
        platform: r.source_platform,
        posts: r.posts,
        impressions: r.impressions || 0,
        likes: r.likes || 0,
        comments: r.comments || 0,
        shares: r.shares || 0,
        clicks: r.clicks || 0,
        engagement_rate: r.avg_engagement_rate
          ? (r.avg_engagement_rate * 100).toFixed(2) + '%'
          : 'N/A'
      }));

      // Individual posts
      if (include_posts) {
        let topSql = `
          SELECT source_platform, post_type, content, published_at,
                 impressions, reach, likes, comments, shares, saves, clicks,
                 engagement_rate, video_views
          FROM social_posts
          WHERE organization_id = ? AND published_at >= ?
        `;
        const topParams: any[] = [orgId, startStr + 'T00:00:00Z'];
        if (platform) {
          topSql += ' AND source_platform = ?';
          topParams.push(platform);
        }
        topSql += ' ORDER BY impressions DESC LIMIT 20';

        const topResult = await this.db.prepare(topSql).bind(...topParams).all<any>();
        response.top_posts = (topResult.results || []).map((p: any) => ({
          platform: p.source_platform,
          type: p.post_type,
          content: p.content ? (p.content.length > 150 ? p.content.substring(0, 150) + '...' : p.content) : null,
          published: p.published_at,
          impressions: p.impressions || 0,
          engagement: (p.likes || 0) + (p.comments || 0) + (p.shares || 0),
          engagement_rate: p.engagement_rate ? (p.engagement_rate * 100).toFixed(2) + '%' : null,
          clicks: p.clicks || 0
        }));
      }

      // Follower trends
      if (include_follower_trends) {
        let followerSql = `
          SELECT source_platform, snapshot_date, follower_count,
                 new_followers, lost_followers, net_change
          FROM social_followers
          WHERE organization_id = ?
            AND snapshot_date >= ?
        `;
        const followerParams: any[] = [orgId, startStr];
        if (platform) {
          followerSql += ' AND source_platform = ?';
          followerParams.push(platform);
        }
        followerSql += ' ORDER BY snapshot_date DESC LIMIT 90';

        const followerResult = await this.db.prepare(followerSql).bind(...followerParams).all<any>();
        const followers = (followerResult.results || []).reverse();

        if (followers.length > 0) {
          const latest = followers[followers.length - 1];
          const earliest = followers[0];
          const totalNetChange = followers.reduce((s: number, f: any) => s + (f.net_change || 0), 0);

          response.follower_trends = {
            current_followers: latest.follower_count || 0,
            net_change: totalNetChange,
            growth_rate: earliest.follower_count > 0
              ? ((totalNetChange / earliest.follower_count) * 100).toFixed(1) + '%'
              : 'N/A',
            timeline: followers.map((f: any) => ({
              platform: f.source_platform,
              date: f.snapshot_date,
              followers: f.follower_count,
              new: f.new_followers || 0,
              lost: f.lost_followers || 0,
              net: f.net_change || 0
            }))
          };
        }
      }

      return { success: true, data: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      if (msg.includes('no such table')) {
        return { success: true, data: { note: 'Social media tables not yet created', post_summary: { total_posts: 0 } } };
      }
      return { success: false, error: msg };
    }
  }
}
