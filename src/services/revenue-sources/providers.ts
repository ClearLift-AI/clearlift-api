/**
 * Revenue Source Providers
 *
 * Import this file to register all revenue source providers.
 * Each provider self-registers when its module is imported.
 */

// Import all providers to trigger registration
import './stripe';
import './shopify';
import './jobber';

// Re-export the registry and helper functions
export { revenueSourceRegistry, getCombinedRevenue, getCombinedRevenueByDateRange } from './index';
export type {
  RevenueSourceProvider,
  RevenueSourceMeta,
  RevenueSourceSummary,
  RevenueSourceTimeSeries,
  CombinedRevenueResult,
} from './index';
