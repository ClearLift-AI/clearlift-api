import { z } from "zod";

/**
 * Hybrid Validation Schemas for Analytics Data
 *
 * These schemas validate minimal required fields while allowing
 * additional fields from Supabase to pass through unchanged.
 * This approach provides:
 * - Type safety for core fields
 * - Flexibility for schema evolution
 * - Clear API contracts
 */

// ============================================================================
// Ad Performance Schemas
// ============================================================================

/**
 * Core metrics that all ad platforms must provide
 */
export const AdMetricsSchema = z.object({
  impressions: z.number().default(0),
  clicks: z.number().default(0),
  spend: z.number().default(0),
  conversions: z.number().optional().default(0),
  revenue: z.number().optional().default(0),
}).passthrough(); // Allow additional platform-specific metrics

/**
 * Ad performance record (single ad)
 */
export const AdPerformanceSchema = z.object({
  // Identity fields (required)
  org_id: z.string(),
  date_reported: z.string(), // ISO date format

  // Campaign/Ad info (optional - may not exist in all views)
  campaign_id: z.string().optional(),
  campaign_name: z.string().optional(),
  ad_id: z.string().optional(),
  ad_name: z.string().optional(),

  // Core metrics
  metrics: AdMetricsSchema,
}).passthrough(); // Allow platform-specific fields

/**
 * Campaign summary (aggregated)
 */
export const CampaignSummarySchema = z.object({
  campaign_id: z.string(),
  campaign_name: z.string(),
  metrics: AdMetricsSchema,
}).passthrough();

/**
 * Daily metrics
 */
export const DailyMetricsSchema = z.object({
  date: z.string(),
  metrics: AdMetricsSchema,
}).passthrough();

/**
 * Overall summary across all campaigns/ads
 */
export const PlatformSummarySchema = z.object({
  total_impressions: z.number().default(0),
  total_clicks: z.number().default(0),
  total_spend: z.number().default(0),
  total_conversions: z.number().default(0),
  total_revenue: z.number().default(0),
  avg_cpc: z.number().optional(), // Cost per click
  avg_cpm: z.number().optional(), // Cost per mille (1000 impressions)
  ctr: z.number().optional(), // Click-through rate
  roas: z.number().optional(), // Return on ad spend
}).passthrough();

// ============================================================================
// Conversion Schemas
// ============================================================================

/**
 * Single conversion record from Supabase
 */
export const ConversionRecordSchema = z.object({
  // Required fields
  org_id: z.string(),
  date: z.string(), // ISO date format
  channel: z.string(), // shopify, stripe, etc.

  // Metrics
  conversion_count: z.number().default(0),
  revenue: z.union([z.string(), z.number()]).transform(val =>
    typeof val === 'string' ? parseFloat(val) : val
  ).default(0),
}).passthrough(); // Allow additional channel-specific fields

/**
 * Conversion data grouped by channel
 */
export const ConversionByChannelSchema = z.object({
  channel: z.string(),
  conversions: z.number(),
  revenue: z.number(),
}).passthrough();

/**
 * Conversion data grouped by date
 */
export const ConversionByDateSchema = z.object({
  date: z.string(),
  conversions: z.number(),
  revenue: z.number(),
}).passthrough();

/**
 * Conversion breakdown (by channel and date)
 */
export const ConversionBreakdownSchema = z.object({
  date: z.string(),
  channel: z.string(),
  conversions: z.number(),
  revenue: z.number(),
}).passthrough();

/**
 * Aggregated conversion response
 */
export const ConversionResponseSchema = z.object({
  total_conversions: z.number(),
  total_revenue: z.number(),
  channel_count: z.number().optional(),
  by_channel: z.array(ConversionByChannelSchema).optional(),
  by_date: z.array(ConversionByDateSchema).optional(),
  breakdown: z.array(ConversionBreakdownSchema).optional(),
}).passthrough();

// ============================================================================
// Event Stream Schemas (R2 SQL)
// ============================================================================

/**
 * Core event fields that we expect from R2 SQL event_stream
 */
export const EventRecordSchema = z.object({
  // Required core fields
  org_tag: z.string(),
  event_id: z.string(),
  timestamp: z.string(),
  event_type: z.string(),

  // Common fields (optional but frequently used)
  anonymous_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),

  // Page context
  page_url: z.string().nullable().optional(),
  page_title: z.string().nullable().optional(),
  page_path: z.string().nullable().optional(),

  // Device/Browser
  device_type: z.string().nullable().optional(),
  browser_name: z.string().nullable().optional(),
  browser_version: z.string().nullable().optional(),
  os_name: z.string().nullable().optional(),

  // Geo
  geo_country: z.string().nullable().optional(),
  geo_region: z.string().nullable().optional(),
  geo_city: z.string().nullable().optional(),

  // UTM params
  utm_source: z.string().nullable().optional(),
  utm_medium: z.string().nullable().optional(),
  utm_campaign: z.string().nullable().optional(),
}).passthrough(); // Allow all 60+ fields from event_stream

/**
 * Event query response
 */
export const EventResponseSchema = z.object({
  events: z.array(EventRecordSchema),
  count: z.number(),
}).passthrough();

// ============================================================================
// Helper Types (for TypeScript inference)
// ============================================================================

export type AdMetrics = z.infer<typeof AdMetricsSchema>;
export type AdPerformance = z.infer<typeof AdPerformanceSchema>;
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;
export type DailyMetrics = z.infer<typeof DailyMetricsSchema>;
export type PlatformSummary = z.infer<typeof PlatformSummarySchema>;
export type ConversionRecord = z.infer<typeof ConversionRecordSchema>;
export type ConversionResponse = z.infer<typeof ConversionResponseSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type EventResponse = z.infer<typeof EventResponseSchema>;
