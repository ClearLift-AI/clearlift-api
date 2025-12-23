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
    // Delete any existing demo recommendations to regenerate fresh ones
    // This ensures recommendations always reflect current entity state
    await aiDb.prepare(`
      DELETE FROM ai_decisions
      WHERE organization_id = ?
        AND platform = 'facebook'
        AND reason LIKE '%[Demo]%'
    `).bind(orgId).run();
    console.log(`[DemoRec] Cleared existing demo recommendations for org ${orgId}`);

    // Fetch Facebook entities from Supabase
    const adapter = new FacebookSupabaseAdapter(supabase);

    // Get first campaign (required - can't generate any recommendations without at least one campaign)
    const campaigns = await adapter.getCampaigns(orgId, { limit: 1 });
    if (!campaigns || campaigns.length === 0) {
      console.log(`[DemoRec] No campaigns found for org ${orgId}`);
      return { success: false, recommendations_created: 0, error: 'No campaigns found' };
    }
    const campaign = campaigns[0];
    console.log(`[DemoRec] Found campaign: ${campaign.campaign_name} (${campaign.campaign_id})`);

    // Get first ad set (optional - we'll still generate campaign recommendations if missing)
    const adSets = await adapter.getAdSets(orgId, { limit: 1 });
    const adSet = adSets && adSets.length > 0 ? adSets[0] : null;
    if (adSet) {
      console.log(`[DemoRec] Found ad set: ${adSet.ad_set_name} (${adSet.ad_set_id})`);
    } else {
      console.log(`[DemoRec] No ad sets found for org ${orgId} - will generate campaign recommendations only`);
    }

    // Get first ad (optional - we'll still generate campaign + ad set recommendations if missing)
    const ads = await adapter.getAds(orgId, { limit: 1 });
    const ad = ads && ads.length > 0 ? ads[0] : null;
    if (ad) {
      console.log(`[DemoRec] Found ad: ${ad.ad_name} (${ad.ad_id})`);
    } else {
      console.log(`[DemoRec] No ads found for org ${orgId} - will skip ad recommendations`);
    }

    // Build demo recommendations based on available entities
    const recommendations: DemoRecommendation[] = [];

    // Campaign recommendations (always included - we require at least 1 campaign)
    // 1. Campaign Status
    recommendations.push({
      tool: 'set_status',
      platform: 'facebook',
      entity_type: 'campaign',
      entity_id: campaign.campaign_id,
      entity_name: campaign.campaign_name,
      parameters: { status: campaign.campaign_status },
      current_state: { status: campaign.campaign_status },
      reason: '[Demo] Verify campaign status control - confirms API write access for Meta App Review.',
      predicted_impact: 0,
      confidence: 'high'
    });

    // 2. Campaign Budget
    recommendations.push({
      tool: 'set_budget',
      platform: 'facebook',
      entity_type: 'campaign',
      entity_id: campaign.campaign_id,
      entity_name: campaign.campaign_name,
      parameters: {
        amount_cents: campaign.daily_budget_cents || campaign.lifetime_budget_cents || 0,
        budget_type: campaign.daily_budget_cents ? 'daily' : 'lifetime'
      },
      current_state: {
        daily_budget_cents: campaign.daily_budget_cents,
        lifetime_budget_cents: campaign.lifetime_budget_cents
      },
      reason: '[Demo] Verify campaign budget control - confirms API write access for Meta App Review.',
      predicted_impact: 0,
      confidence: 'high'
    });

    // Ad Set recommendations (only if ad sets exist)
    if (adSet) {
      // 3. Ad Set Status
      recommendations.push({
        tool: 'set_status',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: { status: adSet.ad_set_status },
        current_state: { status: adSet.ad_set_status },
        reason: '[Demo] Verify ad set status control - confirms API write access for Meta App Review.',
        predicted_impact: 0,
        confidence: 'high'
      });

      // 4. Ad Set Budget
      recommendations.push({
        tool: 'set_budget',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: {
          amount_cents: adSet.daily_budget_cents || adSet.lifetime_budget_cents || 0,
          budget_type: adSet.daily_budget_cents ? 'daily' : 'lifetime'
        },
        current_state: {
          daily_budget_cents: adSet.daily_budget_cents,
          lifetime_budget_cents: adSet.lifetime_budget_cents
        },
        reason: '[Demo] Verify ad set budget control - confirms API write access for Meta App Review.',
        predicted_impact: 0,
        confidence: 'high'
      });

      // 5. Ad Set Targeting
      recommendations.push({
        tool: 'set_age_range',
        platform: 'facebook',
        entity_type: 'ad_set',
        entity_id: adSet.ad_set_id,
        entity_name: adSet.ad_set_name,
        parameters: {
          min_age: adSet.targeting?.age_min || 18,
          max_age: adSet.targeting?.age_max || 65
        },
        current_state: {
          targeting: adSet.targeting || {}
        },
        reason: '[Demo] Verify ad set targeting control - confirms API write access for Meta App Review.',
        predicted_impact: 0,
        confidence: 'high'
      });
    }

    // Ad recommendations (only if ads exist)
    if (ad) {
      // 6. Ad Status
      recommendations.push({
        tool: 'set_status',
        platform: 'facebook',
        entity_type: 'ad',
        entity_id: ad.ad_id,
        entity_name: ad.ad_name,
        parameters: { status: ad.ad_status },
        current_state: { status: ad.ad_status },
        reason: '[Demo] Verify ad status control - confirms API write access for Meta App Review.',
        predicted_impact: 0,
        confidence: 'high'
      });
    }

    console.log(`[DemoRec] Building ${recommendations.length} recommendations (campaigns: 2, ad sets: ${adSet ? 3 : 0}, ads: ${ad ? 1 : 0})`);

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
