/**
 * Demo Recommendations Generator for Meta App Review
 *
 * Generates 6 AI recommendations (one for each Facebook API write operation)
 * when a Facebook Ads account is connected and synced. This allows Meta reviewers
 * to test all API endpoints during App Review.
 */

import { SupabaseClient } from './supabase';
import { FacebookSupabaseAdapter } from '../adapters/platforms/facebook-supabase';

interface DemoRecommendation {
  tool: string;
  platform: 'facebook';
  entity_type: 'campaign' | 'ad_set' | 'ad';
  entity_id: string;
  entity_name: string;
  parameters: Record<string, any>;
  current_state: Record<string, any>;
  reason: string;
  predicted_impact: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Generate demo recommendations for Meta App Review
 * Creates 6 recommendations - one for each Facebook API write operation
 */
export async function generateFacebookDemoRecommendations(
  aiDb: D1Database,
  supabase: SupabaseClient,
  orgId: string,
  connectionId: string
): Promise<{ success: boolean; recommendations_created: number; error?: string }> {
  console.log(`[DemoRec] Generating Facebook demo recommendations for org ${orgId}`);

  try {
    // Check if we already have demo recommendations for this org (avoid duplicates)
    const existingCheck = await aiDb.prepare(`
      SELECT COUNT(*) as count FROM ai_decisions
      WHERE organization_id = ?
        AND platform = 'facebook'
        AND status = 'pending'
        AND reason LIKE '%[Demo]%'
    `).bind(orgId).first<{ count: number }>();

    if (existingCheck && existingCheck.count >= 6) {
      console.log(`[DemoRec] Org ${orgId} already has ${existingCheck.count} demo recommendations, skipping`);
      return { success: true, recommendations_created: 0 };
    }

    // Fetch Facebook entities from Supabase
    const adapter = new FacebookSupabaseAdapter(supabase);

    // Get first ACTIVE campaign
    const campaigns = await adapter.getCampaigns(orgId, { status: 'ACTIVE', limit: 1 });
    if (!campaigns || campaigns.length === 0) {
      console.log(`[DemoRec] No active campaigns found for org ${orgId}`);
      return { success: false, recommendations_created: 0, error: 'No active campaigns found' };
    }
    const campaign = campaigns[0];
    console.log(`[DemoRec] Found campaign: ${campaign.campaign_name} (${campaign.campaign_id})`);

    // Get first ACTIVE ad set
    const adSets = await adapter.getAdSets(orgId, { status: 'ACTIVE', limit: 1 });
    if (!adSets || adSets.length === 0) {
      console.log(`[DemoRec] No active ad sets found for org ${orgId}`);
      return { success: false, recommendations_created: 0, error: 'No active ad sets found' };
    }
    const adSet = adSets[0];
    console.log(`[DemoRec] Found ad set: ${adSet.ad_set_name} (${adSet.ad_set_id})`);

    // Get first ACTIVE ad
    const ads = await adapter.getAds(orgId, { status: 'ACTIVE', limit: 1 });
    if (!ads || ads.length === 0) {
      console.log(`[DemoRec] No active ads found for org ${orgId}`);
      return { success: false, recommendations_created: 0, error: 'No active ads found' };
    }
    const ad = ads[0];
    console.log(`[DemoRec] Found ad: ${ad.ad_name} (${ad.ad_id})`);

    // Build 6 demo recommendations
    const recommendations: DemoRecommendation[] = [
      // 1. Campaign Status (Pause)
      {
        tool: 'set_status',
        platform: 'facebook',
        entity_type: 'campaign',
        entity_id: campaign.campaign_id,
        entity_name: campaign.campaign_name,
        parameters: { status: 'PAUSED' },
        current_state: { status: campaign.campaign_status },
        reason: '[Demo] Campaign performance review - pause to evaluate strategy and prevent unnecessary spend.',
        predicted_impact: -15.0,
        confidence: 'medium'
      },

      // 2. Campaign Budget (Increase)
      {
        tool: 'set_budget',
        platform: 'facebook',
        entity_type: 'campaign',
        entity_id: campaign.campaign_id,
        entity_name: campaign.campaign_name,
        parameters: {
          amount_cents: Math.max((campaign.daily_budget_cents || 1000) + 500, 1500),
          budget_type: 'daily'
        },
        current_state: {
          daily_budget_cents: campaign.daily_budget_cents || 1000
        },
        reason: '[Demo] Increase campaign budget to capture additional conversion opportunities.',
        predicted_impact: 20.0,
        confidence: 'high'
      },

      // 3. Ad Set Status (Pause)
      {
        tool: 'set_status',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: { status: 'PAUSED' },
        current_state: { status: adSet.ad_set_status },
        reason: '[Demo] Pause ad set for audience optimization and budget reallocation.',
        predicted_impact: -10.0,
        confidence: 'medium'
      },

      // 4. Ad Set Budget
      {
        tool: 'set_budget',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: {
          amount_cents: Math.max((adSet.daily_budget_cents || 500) + 300, 800),
          budget_type: 'daily'
        },
        current_state: {
          daily_budget_cents: adSet.daily_budget_cents || 500
        },
        reason: '[Demo] Optimize ad set budget allocation based on performance potential.',
        predicted_impact: 10.0,
        confidence: 'medium'
      },

      // 5. Ad Set Targeting (Age Range)
      {
        tool: 'set_age_range',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: {
          min_age: 25,
          max_age: 54
        },
        current_state: {
          targeting: adSet.targeting || {}
        },
        reason: '[Demo] Expand audience targeting to reach high-converting 25-54 demographic.',
        predicted_impact: 15.0,
        confidence: 'medium'
      },

      // 6. Ad Status (Pause)
      {
        tool: 'set_status',
        platform: 'facebook',
        entity_type: 'ad',
        entity_id: ad.ad_id,
        entity_name: ad.ad_name,
        parameters: { status: 'PAUSED' },
        current_state: { status: ad.ad_status },
        reason: '[Demo] Pause ad creative to test new variations and improve overall performance.',
        predicted_impact: -5.0,
        confidence: 'low'
      }
    ];

    // Insert recommendations into ai_decisions
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7-day expiry
    const expiresAtStr = expiresAt.toISOString();

    let created = 0;
    for (const rec of recommendations) {
      const id = crypto.randomUUID().replace(/-/g, '');

      try {
        await aiDb.prepare(`
          INSERT INTO ai_decisions (
            id, organization_id, tool, platform, entity_type, entity_id, entity_name,
            parameters, current_state, reason, predicted_impact, confidence, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          id,
          orgId,
          rec.tool,
          rec.platform,
          rec.entity_type,
          rec.entity_id,
          rec.entity_name,
          JSON.stringify(rec.parameters),
          JSON.stringify(rec.current_state),
          rec.reason,
          rec.predicted_impact,
          rec.confidence,
          expiresAtStr
        ).run();

        created++;
        console.log(`[DemoRec] Created recommendation: ${rec.tool} on ${rec.entity_type} ${rec.entity_name}`);
      } catch (err) {
        console.error(`[DemoRec] Failed to create recommendation for ${rec.tool}:`, err);
      }
    }

    console.log(`[DemoRec] Successfully created ${created} demo recommendations for org ${orgId}`);
    return { success: true, recommendations_created: created };

  } catch (err: any) {
    console.error(`[DemoRec] Error generating demo recommendations:`, err);
    return { success: false, recommendations_created: 0, error: err.message };
  }
}
