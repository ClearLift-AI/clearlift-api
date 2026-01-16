/**
 * Demo Recommendations Generator for Meta App Review
 *
 * Generates 6 AI recommendations (one for each Facebook API write operation)
 * when a Facebook Ads account is connected and synced. This allows Meta reviewers
 * to test all API endpoints during App Review.
 *
 * Uses D1 ANALYTICS_DB for campaign data
 */

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

// Facebook entity types from D1
interface FacebookCampaign {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
}

interface FacebookAdSet {
  ad_set_id: string;
  ad_set_name: string;
  ad_set_status: string;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  targeting: string | null;
}

interface FacebookAd {
  ad_id: string;
  ad_name: string;
  ad_status: string;
}

/**
 * Generate demo recommendations for Meta App Review
 * Creates 6 recommendations - one for each Facebook API write operation
 * Uses D1 ANALYTICS_DB for entity data
 */
export async function generateFacebookDemoRecommendations(
  aiDb: D1Database,
  analyticsDb: D1Database,
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

    // Fetch Facebook entities from D1 ANALYTICS_DB
    // Get first campaign (required - can't generate any recommendations without at least one campaign)
    const campaignResult = await analyticsDb.prepare(`
      SELECT campaign_id, campaign_name, campaign_status, daily_budget_cents, lifetime_budget_cents
      FROM facebook_campaigns
      WHERE organization_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(orgId).first<FacebookCampaign>();

    if (!campaignResult) {
      console.log(`[DemoRec] No campaigns found for org ${orgId}`);
      return { success: false, recommendations_created: 0, error: 'No campaigns found' };
    }
    const campaign = campaignResult;
    console.log(`[DemoRec] Found campaign: ${campaign.campaign_name} (${campaign.campaign_id})`);

    // Get first ad set (optional - we'll still generate campaign recommendations if missing)
    const adSetResult = await analyticsDb.prepare(`
      SELECT ad_set_id, ad_set_name, ad_set_status, daily_budget_cents, lifetime_budget_cents, targeting
      FROM facebook_ad_sets
      WHERE organization_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(orgId).first<FacebookAdSet>();

    const adSet = adSetResult || null;
    if (adSet) {
      console.log(`[DemoRec] Found ad set: ${adSet.ad_set_name} (${adSet.ad_set_id})`);
    } else {
      console.log(`[DemoRec] No ad sets found for org ${orgId} - will generate campaign recommendations only`);
    }

    // Get first ad (optional - we'll still generate campaign + ad set recommendations if missing)
    const adResult = await analyticsDb.prepare(`
      SELECT ad_id, ad_name, ad_status
      FROM facebook_ads
      WHERE organization_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(orgId).first<FacebookAd>();

    const ad = adResult || null;
    if (ad) {
      console.log(`[DemoRec] Found ad: ${ad.ad_name} (${ad.ad_id})`);
    } else {
      console.log(`[DemoRec] No ads found for org ${orgId} - will skip ad recommendations`);
    }

    // Parse targeting if it's a string
    const targeting = adSet?.targeting ? (typeof adSet.targeting === 'string' ? JSON.parse(adSet.targeting) : adSet.targeting) : {};

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
          min_age: targeting?.age_min || 18,
          max_age: targeting?.age_max || 65
        },
        current_state: {
          targeting: targeting || {}
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
