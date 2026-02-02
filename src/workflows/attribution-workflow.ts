/**
 * Attribution Workflow
 *
 * Cloudflare Workflow for computing Markov Chain and Shapley Value
 * attribution models. These models are compute-intensive and need
 * durable execution with long timeouts.
 *
 * Step Structure:
 * 1. fetch_paths - Query conversion and non-conversion paths from events
 * 2. markov_chain - Calculate Markov Chain removal effects
 * 3. shapley_value - Calculate Shapley Value attribution
 * 4. store_results - Persist results to D1
 * 5. complete - Mark job as finished
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import {
  ConversionPath,
  Touchpoint,
  calculateMarkovRemovalEffect,
  calculateShapleyAttribution,
  approximateShapleyAttribution,
  MarkovAttributionResult,
  ShapleyAttributionResult
} from '../services/attribution-models';

/**
 * Parameters for the attribution workflow
 */
export interface AttributionWorkflowParams {
  orgId: string;
  jobId: string;
  days: number;
}

/**
 * Serializable conversion path data
 */
interface SerializedConversionPath {
  conversion_id: string;
  user_id?: string;
  anonymous_ids: string[];
  touchpoints: Array<{
    id: string;
    session_id: string;
    anonymous_id?: string;
    timestamp: string;  // ISO string
    utm_source: string;
    utm_medium: string | null;
    utm_campaign: string | null;
    event_type: string;
    page_url?: string;
  }>;
  conversion_timestamp: string;  // ISO string
  conversion_value: number;
  conversion_type: string;
}

/**
 * Result from fetching paths
 */
interface PathsResult {
  conversionPaths: SerializedConversionPath[];
  nonConversionPaths: SerializedConversionPath[];
  channelCount: number;
}

/**
 * Attribution Workflow
 *
 * Computes Markov Chain and Shapley Value attribution models
 * from conversion and non-conversion paths.
 */
export class AttributionWorkflow extends WorkflowEntrypoint<Env, AttributionWorkflowParams> {
  /**
   * Main workflow execution
   */
  async run(event: WorkflowEvent<AttributionWorkflowParams>, step: WorkflowStep) {
    const { orgId, jobId, days } = event.payload;

    // Step 1: Fetch conversion paths from D1/events
    const paths = await step.do('fetch_paths', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      timeout: '5 minutes'
    }, async () => {
      return await this.fetchConversionPaths(orgId, days);
    });

    // If no paths found, complete early
    if (paths.conversionPaths.length === 0) {
      await step.do('complete_no_data', async () => {
        await this.env.AI_DB.prepare(`
          UPDATE analysis_jobs
          SET status = 'completed', completed_at = datetime('now'),
              result = ?
          WHERE id = ?
        `).bind(
          JSON.stringify({ error: 'No conversion paths found', paths: 0 }),
          jobId
        ).run();
      });

      return {
        status: 'no_data',
        conversion_paths: 0,
        non_conversion_paths: 0
      };
    }

    // Deserialize paths for model functions
    const conversionPaths = this.deserializePaths(paths.conversionPaths);
    const nonConversionPaths = this.deserializePaths(paths.nonConversionPaths);

    // Step 2: Calculate Markov Chain attribution
    const markovResults = await step.do('markov_chain', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes'
    }, async () => {
      console.log(`[Attribution] Starting Markov Chain calculation for ${orgId}`);
      const results = calculateMarkovRemovalEffect(conversionPaths, nonConversionPaths);
      console.log(`[Attribution] Markov Chain complete: ${results.length} channels`);
      return results;
    });

    // Step 3: Calculate Shapley Value attribution
    const shapleyResults = await step.do('shapley_value', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '15 minutes'
    }, async () => {
      console.log(`[Attribution] Starting Shapley Value calculation for ${orgId}`);

      // Use approximation for >10 channels (exact Shapley is O(2^n))
      let results: ShapleyAttributionResult[];
      if (paths.channelCount > 10) {
        console.log(`[Attribution] Using Monte Carlo approximation (${paths.channelCount} channels)`);
        results = approximateShapleyAttribution(conversionPaths, nonConversionPaths, 5000);
      } else {
        console.log(`[Attribution] Using exact Shapley (${paths.channelCount} channels)`);
        results = calculateShapleyAttribution(conversionPaths, nonConversionPaths);
      }

      console.log(`[Attribution] Shapley Value complete: ${results.length} channels`);
      return results;
    });

    // Step 4: Store results in D1
    await step.do('store_results', {
      retries: { limit: 3, delay: '1 second' },
      timeout: '1 minute'
    }, async () => {
      await this.storeResults(orgId, markovResults, shapleyResults, paths);
    });

    // Step 5: Mark job complete
    await step.do('complete', async () => {
      await this.env.AI_DB.prepare(`
        UPDATE analysis_jobs
        SET status = 'completed', completed_at = datetime('now'),
            result = ?
        WHERE id = ?
      `).bind(
        JSON.stringify({
          markov_channels: markovResults.length,
          shapley_channels: shapleyResults.length,
          conversion_paths: paths.conversionPaths.length,
          non_conversion_paths: paths.nonConversionPaths.length
        }),
        jobId
      ).run();
    });

    return {
      status: 'completed',
      markov_channels: markovResults.length,
      shapley_channels: shapleyResults.length,
      conversion_paths: paths.conversionPaths.length,
      non_conversion_paths: paths.nonConversionPaths.length
    };
  }

  /**
   * Fetch conversion paths from D1 conversion_attribution table
   * and/or construct from click tracking data
   */
  private async fetchConversionPaths(orgId: string, days: number): Promise<PathsResult> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    // Get conversion events with click attribution from D1
    // This uses the conversion_attribution table if populated,
    // or falls back to joining stripe_charges/shopify_orders with click data
    const conversionsResult = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        ca.id as conversion_id,
        ca.anonymous_id,
        ca.gclid,
        ca.fbclid,
        ca.ttclid,
        ca.utm_source,
        ca.utm_medium,
        ca.utm_campaign,
        ca.conversion_value_cents,
        ca.converted_at,
        COALESCE(ca.utm_source,
          CASE
            WHEN ca.gclid IS NOT NULL THEN 'google'
            WHEN ca.fbclid IS NOT NULL THEN 'facebook'
            WHEN ca.ttclid IS NOT NULL THEN 'tiktok'
            ELSE 'direct'
          END
        ) as derived_source
      FROM conversion_attribution ca
      WHERE ca.organization_id = ?
        AND ca.converted_at >= ?
      ORDER BY ca.anonymous_id, ca.converted_at
    `).bind(orgId, cutoffStr).all<{
      conversion_id: string;
      anonymous_id: string | null;
      gclid: string | null;
      fbclid: string | null;
      ttclid: string | null;
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
      conversion_value_cents: number;
      converted_at: string;
      derived_source: string;
    }>();

    const conversions = conversionsResult.results || [];

    // If no conversion_attribution data, try to build from Stripe + click tracking
    if (conversions.length === 0) {
      return await this.buildPathsFromStripe(orgId, cutoffStr);
    }

    // Build conversion paths - group by anonymous_id
    const pathsByUser = new Map<string, SerializedConversionPath>();
    const channels = new Set<string>();

    for (const conv of conversions) {
      const userId = conv.anonymous_id || conv.conversion_id;
      const source = conv.utm_source || conv.derived_source;
      channels.add(source);

      const touchpoint = {
        id: conv.conversion_id,
        session_id: conv.conversion_id,
        anonymous_id: conv.anonymous_id || undefined,
        timestamp: conv.converted_at,
        utm_source: source,
        utm_medium: conv.utm_medium,
        utm_campaign: conv.utm_campaign,
        event_type: 'conversion',
        page_url: undefined
      };

      if (pathsByUser.has(userId)) {
        // Add touchpoint to existing path
        const path = pathsByUser.get(userId)!;
        path.touchpoints.push(touchpoint);
        path.conversion_value += (conv.conversion_value_cents || 0) / 100;
      } else {
        // Create new path
        pathsByUser.set(userId, {
          conversion_id: conv.conversion_id,
          user_id: userId,
          anonymous_ids: conv.anonymous_id ? [conv.anonymous_id] : [],
          touchpoints: [touchpoint],
          conversion_timestamp: conv.converted_at,
          conversion_value: (conv.conversion_value_cents || 0) / 100,
          conversion_type: 'purchase'
        });
      }
    }

    const conversionPaths = Array.from(pathsByUser.values());

    // For non-conversion paths, we need sessions that didn't convert
    // This is a simplification - in practice you'd query session data
    const nonConversionPaths: SerializedConversionPath[] = [];

    return {
      conversionPaths,
      nonConversionPaths,
      channelCount: channels.size
    };
  }

  /**
   * Build paths from Stripe charges + platform click data
   * Fallback when conversion_attribution table is empty
   */
  private async buildPathsFromStripe(orgId: string, cutoffStr: string): Promise<PathsResult> {
    // Get Stripe charges
    const chargesResult = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        id,
        customer_id,
        amount_cents,
        created_at,
        metadata
      FROM stripe_charges
      WHERE organization_id = ?
        AND created_at >= ?
        AND status = 'succeeded'
      ORDER BY created_at
    `).bind(orgId, cutoffStr).all<{
      id: string;
      customer_id: string | null;
      amount_cents: number;
      created_at: string;
      metadata: string | null;
    }>();

    const charges = chargesResult.results || [];

    if (charges.length === 0) {
      return {
        conversionPaths: [],
        nonConversionPaths: [],
        channelCount: 0
      };
    }

    // Get recent ad clicks to attribute (using unified ad_metrics table)
    const clicksResult = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        m.platform,
        c.campaign_name,
        g.ad_group_name as ad_set_name,
        m.metric_date as date,
        m.clicks
      FROM ad_metrics m
      LEFT JOIN ad_groups g ON m.entity_type = 'ad_group' AND m.entity_ref = g.id
      JOIN ad_campaigns c ON c.id = CASE
        WHEN m.entity_type = 'campaign' THEN m.entity_ref
        WHEN m.entity_type = 'ad_group' THEN g.campaign_ref
      END
      WHERE m.organization_id = ?
        AND m.metric_date >= ?
        AND m.entity_type IN ('campaign', 'ad_group')
        AND m.clicks > 0
      ORDER BY m.metric_date
    `).bind(orgId, cutoffStr).all<{
      platform: string;
      campaign_name: string;
      ad_set_name: string | null;
      date: string;
      clicks: number;
    }>();

    const clicks = clicksResult.results || [];
    const channels = new Set<string>();

    // Build conversion paths - attribute to most recent click
    const conversionPaths: SerializedConversionPath[] = [];

    for (const charge of charges) {
      // Find click closest to but before conversion
      const chargeDate = new Date(charge.created_at);
      let attributedClick = clicks.find(c => new Date(c.date) <= chargeDate);

      // Default to direct if no click found
      const source = attributedClick?.platform || 'direct';
      channels.add(source);

      conversionPaths.push({
        conversion_id: charge.id,
        user_id: charge.customer_id || charge.id,
        anonymous_ids: [],
        touchpoints: [{
          id: `tp-${charge.id}`,
          session_id: charge.id,
          timestamp: charge.created_at,
          utm_source: source,
          utm_medium: attributedClick ? 'cpc' : null,
          utm_campaign: attributedClick?.campaign_name || null,
          event_type: 'click',
          page_url: undefined
        }],
        conversion_timestamp: charge.created_at,
        conversion_value: charge.amount_cents / 100,
        conversion_type: 'purchase'
      });
    }

    return {
      conversionPaths,
      nonConversionPaths: [],
      channelCount: channels.size
    };
  }

  /**
   * Deserialize paths from JSON-safe format to model format
   */
  private deserializePaths(serialized: SerializedConversionPath[]): ConversionPath[] {
    return serialized.map(s => ({
      conversion_id: s.conversion_id,
      user_id: s.user_id,
      anonymous_ids: s.anonymous_ids,
      touchpoints: s.touchpoints.map(t => ({
        id: t.id,
        session_id: t.session_id,
        anonymous_id: t.anonymous_id,
        timestamp: new Date(t.timestamp),
        utm_source: t.utm_source,
        utm_medium: t.utm_medium,
        utm_campaign: t.utm_campaign,
        event_type: t.event_type,
        page_url: t.page_url
      } as Touchpoint)),
      conversion_timestamp: new Date(s.conversion_timestamp),
      conversion_value: s.conversion_value,
      conversion_type: s.conversion_type
    }));
  }

  /**
   * Store computed attribution results in D1
   */
  private async storeResults(
    orgId: string,
    markovResults: MarkovAttributionResult[],
    shapleyResults: ShapleyAttributionResult[],
    paths: PathsResult
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    const today = new Date().toISOString().split('T')[0];
    const pathCount = paths.conversionPaths.length + paths.nonConversionPaths.length;

    // Delete old results for this org/date
    await this.env.AI_DB.prepare(`
      DELETE FROM attribution_model_results
      WHERE organization_id = ? AND computation_date = ?
    `).bind(orgId, today).run();

    // Insert Markov Chain results
    for (const result of markovResults) {
      await this.env.AI_DB.prepare(`
        INSERT INTO attribution_model_results
        (id, organization_id, model, channel, attributed_credit, removal_effect,
         computation_date, conversion_count, path_count, expires_at)
        VALUES (?, ?, 'markov_chain', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID().replace(/-/g, ''),
        orgId,
        result.channel,
        result.attributed_credit,
        result.removal_effect,
        today,
        paths.conversionPaths.length,
        pathCount,
        expiresAt.toISOString()
      ).run();
    }

    // Insert Shapley Value results
    for (const result of shapleyResults) {
      await this.env.AI_DB.prepare(`
        INSERT INTO attribution_model_results
        (id, organization_id, model, channel, attributed_credit, shapley_value,
         computation_date, conversion_count, path_count, expires_at)
        VALUES (?, ?, 'shapley_value', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID().replace(/-/g, ''),
        orgId,
        result.channel,
        result.attributed_credit,
        result.shapley_value,
        today,
        paths.conversionPaths.length,
        pathCount,
        expiresAt.toISOString()
      ).run();
    }

    console.log(`[Attribution] Stored ${markovResults.length} Markov + ${shapleyResults.length} Shapley results for ${orgId}`);
  }
}
