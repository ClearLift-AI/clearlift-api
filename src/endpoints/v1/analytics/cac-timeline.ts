/**
 * CAC Timeline API Endpoint
 *
 * Returns TRUTHFUL data for the CAC Timeline chart:
 * - actual_cac: Real historical CAC from cac_history table
 * - predicted_with_ai: Predictions made BEFORE outcomes (from cac_predictions)
 * - baseline_no_ai: Counterfactual CAC without AI (from cac_baselines)
 *
 * This replaces the synthetic/hallucinated numbers with real data.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

// ═══════════════════════════════════════════════════════════════════════════
// GET /v1/analytics/cac/timeline
// ═══════════════════════════════════════════════════════════════════════════

export class GetCACTimeline extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get CAC timeline data",
    description: "Returns historical CAC, AI predictions, and no-AI baselines for the chart",
    operationId: "get-cac-timeline",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        days: z.coerce.number().int().min(1).max(90).optional().default(7).describe("Days of historical data"),
        forecast_days: z.coerce.number().int().min(0).max(7).optional().default(3).describe("Days of forecast")
      })
    },
    responses: {
      200: {
        description: "CAC timeline data",
        content: {
          "application/json": {
            schema: z.object({
              data: z.array(z.object({
                date: z.string(),
                actual_cac: z.number().nullable(),
                predicted_with_ai: z.number().nullable(),
                baseline_no_ai: z.number().nullable()
              })),
              metadata: z.object({
                start_date: z.string(),
                end_date: z.string(),
                days_historical: z.number(),
                days_forecast: z.number(),
                has_predictions: z.boolean(),
                has_baselines: z.boolean()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id, days, forecast_days } = data.query;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const forecastEndDate = new Date();
    forecastEndDate.setDate(forecastEndDate.getDate() + forecast_days);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    const forecastEndStr = forecastEndDate.toISOString().split('T')[0];

    try {
      // Fetch actual CAC history
      const historyResult = await c.env.AI_DB.prepare(`
        SELECT date, cac_cents
        FROM cac_history
        WHERE organization_id = ?
          AND date >= ?
          AND date <= ?
        ORDER BY date ASC
      `).bind(org_id, startDateStr, endDateStr).all<{
        date: string;
        cac_cents: number;
      }>();

      // Fetch predictions (for forecast period)
      const predictionsResult = await c.env.AI_DB.prepare(`
        SELECT prediction_date as date, predicted_cac_cents
        FROM cac_predictions
        WHERE organization_id = ?
          AND prediction_date > ?
          AND prediction_date <= ?
        ORDER BY prediction_date ASC
      `).bind(org_id, endDateStr, forecastEndStr).all<{
        date: string;
        predicted_cac_cents: number;
      }>();

      // Fetch baselines (for historical period)
      const baselinesResult = await c.env.AI_DB.prepare(`
        SELECT baseline_date as date, baseline_cac_cents
        FROM cac_baselines
        WHERE organization_id = ?
          AND baseline_date >= ?
          AND baseline_date <= ?
        ORDER BY baseline_date ASC
      `).bind(org_id, startDateStr, endDateStr).all<{
        date: string;
        baseline_cac_cents: number;
      }>();

      // Build lookup maps
      const historyMap = new Map<string, number>();
      for (const row of historyResult.results || []) {
        historyMap.set(row.date, row.cac_cents / 100);
      }

      const predictionsMap = new Map<string, number>();
      for (const row of predictionsResult.results || []) {
        predictionsMap.set(row.date, row.predicted_cac_cents / 100);
      }

      const baselinesMap = new Map<string, number>();
      for (const row of baselinesResult.results || []) {
        baselinesMap.set(row.date, row.baseline_cac_cents / 100);
      }

      // Generate complete date range
      const data: Array<{
        date: string;
        actual_cac: number | null;
        predicted_with_ai: number | null;
        baseline_no_ai: number | null;
      }> = [];
      const currentDate = new Date(startDate);
      const finalDate = new Date(forecastEndDate);

      while (currentDate <= finalDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const isHistorical = currentDate <= endDate;

        data.push({
          date: dateStr,
          actual_cac: isHistorical ? (historyMap.get(dateStr) ?? null) : null,
          predicted_with_ai: predictionsMap.get(dateStr) ?? null,
          baseline_no_ai: isHistorical ? (baselinesMap.get(dateStr) ?? null) : null
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      return success(c, {
        data,
        metadata: {
          start_date: startDateStr,
          end_date: forecastEndStr,
          days_historical: days,
          days_forecast: forecast_days,
          has_predictions: predictionsMap.size > 0,
          has_baselines: baselinesMap.size > 0
        }
      });

    } catch (err) {
      console.error('CAC timeline error:', err);
      return error(c, 'CAC_TIMELINE_ERROR', 'Failed to fetch CAC timeline', 500);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /v1/analytics/cac/generate
// ═══════════════════════════════════════════════════════════════════════════

export class GenerateCACPredictions extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Generate CAC predictions from pending recommendations",
    description: "Creates forecast based on AI recommendations with simulation data",
    operationId: "generate-cac-predictions",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string(),
              analysis_run_id: z.string().optional()
            })
          }
        }
      }
    },
    responses: {
      200: { description: "Predictions generated" }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id, analysis_run_id } = data.body;

    try {
      // Get pending recommendations with simulation data
      const recsResult = await c.env.AI_DB.prepare(`
        SELECT
          id,
          simulation_data,
          simulation_confidence,
          predicted_impact,
          created_at
        FROM ai_decisions
        WHERE organization_id = ?
          AND status = 'pending'
          AND simulation_data IS NOT NULL
        ORDER BY created_at DESC
      `).bind(org_id).all<{
        id: string;
        simulation_data: string;
        simulation_confidence: string;
        predicted_impact: number;
        created_at: string;
      }>();

      if (!recsResult.results || recsResult.results.length === 0) {
        return success(c, {
          success: true,
          message: 'No pending recommendations with simulation data',
          predictions_created: 0
        });
      }

      // Get current CAC
      const currentCacResult = await c.env.AI_DB.prepare(`
        SELECT cac_cents
        FROM cac_history
        WHERE organization_id = ?
        ORDER BY date DESC
        LIMIT 1
      `).bind(org_id).first<{ cac_cents: number }>();

      const currentCac = currentCacResult?.cac_cents || 0;
      if (currentCac === 0) {
        return error(c, 'NO_CAC_DATA', 'No current CAC data available. Run backfill first.', 400);
      }

      // Calculate aggregate impact
      let totalImpactPercent = 0;
      const recommendationIds: string[] = [];

      for (const rec of recsResult.results) {
        totalImpactPercent += rec.predicted_impact || 0;
        recommendationIds.push(rec.id);
      }

      // Generate predictions for next 3 days
      const predictions: Array<{ date: string; cac_cents: number }> = [];
      const today = new Date();

      for (let i = 1; i <= 3; i++) {
        const predDate = new Date(today);
        predDate.setDate(predDate.getDate() + i);
        const dateStr = predDate.toISOString().split('T')[0];

        // Linear interpolation of impact
        const dayImpact = (totalImpactPercent * i) / 3;
        const predictedCac = Math.round(currentCac * (1 + dayImpact / 100));

        predictions.push({ date: dateStr, cac_cents: predictedCac });
      }

      // Upsert predictions
      for (const pred of predictions) {
        await c.env.AI_DB.prepare(`
          INSERT INTO cac_predictions (
            organization_id, prediction_date, predicted_cac_cents,
            recommendation_ids, analysis_run_id, assumptions
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(organization_id, prediction_date)
          DO UPDATE SET
            predicted_cac_cents = excluded.predicted_cac_cents,
            recommendation_ids = excluded.recommendation_ids,
            analysis_run_id = excluded.analysis_run_id,
            assumptions = excluded.assumptions,
            created_at = datetime('now')
        `).bind(
          org_id,
          pred.date,
          pred.cac_cents,
          JSON.stringify(recommendationIds),
          analysis_run_id || null,
          JSON.stringify({
            current_cac_cents: currentCac,
            total_impact_percent: totalImpactPercent,
            recommendation_count: recommendationIds.length
          })
        ).run();
      }

      return success(c, {
        success: true,
        predictions_created: predictions.length,
        total_impact_percent: totalImpactPercent,
        current_cac: currentCac / 100,
        predictions: predictions.map(p => ({
          date: p.date,
          predicted_cac: p.cac_cents / 100
        }))
      });

    } catch (err) {
      console.error('CAC prediction generation error:', err);
      return error(c, 'CAC_PREDICTION_ERROR', 'Failed to generate CAC predictions', 500);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /v1/analytics/cac/compute-baselines
// ═══════════════════════════════════════════════════════════════════════════
// Mathematically computes "Without ClearLift" baselines using trend extrapolation

export class ComputeCACBaselines extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Compute CAC baselines using trend extrapolation",
    description: "Calculates counterfactual CAC (without AI) using linear regression on pre-AI period",
    operationId: "compute-cac-baselines",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string(),
              days: z.number().min(7).max(90).optional().default(30)
            })
          }
        }
      }
    },
    responses: {
      200: { description: "Baselines computed" }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id, days } = data.body;

    try {
      // 1. Find when AI recommendations were first accepted
      const firstDecisionResult = await c.env.AI_DB.prepare(`
        SELECT MIN(applied_at) as first_ai_date
        FROM ai_decisions
        WHERE organization_id = ?
          AND status = 'approved'
          AND applied_at IS NOT NULL
      `).bind(org_id).first<{ first_ai_date: string | null }>();

      const firstAIDate = firstDecisionResult?.first_ai_date;

      // 2. Get all CAC history
      const historyResult = await c.env.AI_DB.prepare(`
        SELECT date, cac_cents, spend_cents, conversions
        FROM cac_history
        WHERE organization_id = ?
        ORDER BY date ASC
      `).bind(org_id).all<{
        date: string;
        cac_cents: number;
        spend_cents: number;
        conversions: number;
      }>();

      if (!historyResult.results || historyResult.results.length < 3) {
        return success(c, {
          success: true,
          message: 'Insufficient CAC history for baseline computation (need at least 3 days)',
          baselines_created: 0
        });
      }

      const allData = historyResult.results;

      // 3. Split into pre-AI and post-AI periods
      let preAIData: typeof allData = [];
      let postAIData: typeof allData = [];

      if (firstAIDate) {
        preAIData = allData.filter(d => d.date < firstAIDate);
        postAIData = allData.filter(d => d.date >= firstAIDate);
      } else {
        // No AI decisions yet - use first 70% as "pre-AI" to establish trend
        const splitIdx = Math.floor(allData.length * 0.7);
        preAIData = allData.slice(0, splitIdx);
        postAIData = allData.slice(splitIdx);
      }

      if (preAIData.length < 3) {
        // Not enough pre-AI data - use overall average as baseline
        const avgCAC = allData.reduce((sum, d) => sum + d.cac_cents, 0) / allData.length;

        let baselinesCreated = 0;
        for (const day of allData.slice(-days)) {
          await this.upsertBaseline(c.env.AI_DB, org_id, day.date, day.cac_cents, Math.round(avgCAC), 'average', {
            method: 'insufficient_pre_ai_data',
            average_cac_cents: avgCAC
          });
          baselinesCreated++;
        }

        return success(c, {
          success: true,
          method: 'average',
          message: 'Used average CAC as baseline (insufficient pre-AI data)',
          baselines_created: baselinesCreated,
          average_cac: avgCAC / 100
        });
      }

      // 4. Calculate linear regression on pre-AI period
      // y = mx + b, where x is day index, y is CAC
      const { slope, intercept, r_squared } = this.linearRegression(preAIData.map((d, i) => ({
        x: i,
        y: d.cac_cents
      })));

      console.log(`[CACBaselines] Linear regression: slope=${slope.toFixed(2)}, intercept=${intercept.toFixed(2)}, R²=${r_squared.toFixed(3)}`);

      // 5. Extrapolate baseline for each post-AI day
      let baselinesCreated = 0;
      const preAILength = preAIData.length;

      for (let i = 0; i < postAIData.length && i < days; i++) {
        const day = postAIData[i];
        const dayIndex = preAILength + i;

        // Extrapolated baseline = trend continuation
        let baselineCAC = slope * dayIndex + intercept;

        // Apply decay factor - trends don't continue linearly forever
        // After 14 days, assume trend flattens by 50%
        const daysFromStart = i;
        const decayFactor = Math.max(0.5, 1 - (daysFromStart / 28) * 0.5);
        const decayedSlope = slope * decayFactor;
        baselineCAC = decayedSlope * dayIndex + intercept;

        // Ensure baseline is positive and reasonable (within 3x of actual)
        baselineCAC = Math.max(baselineCAC, day.cac_cents * 0.5);
        baselineCAC = Math.min(baselineCAC, day.cac_cents * 3);

        await this.upsertBaseline(c.env.AI_DB, org_id, day.date, day.cac_cents, Math.round(baselineCAC), 'trend_extrapolation', {
          slope,
          intercept,
          r_squared,
          decay_factor: decayFactor,
          day_index: dayIndex
        });
        baselinesCreated++;
      }

      // 6. Get accepted decisions to show impact
      const decisionsResult = await c.env.AI_DB.prepare(`
        SELECT id, recommended_action, impact
        FROM ai_decisions
        WHERE organization_id = ?
          AND status = 'approved'
      `).bind(org_id).all<{ id: string; recommended_action: string; impact: number }>();

      const totalImpact = (decisionsResult.results || []).reduce((sum, d) => sum + (d.impact || 0), 0);

      return success(c, {
        success: true,
        method: 'trend_extrapolation',
        baselines_created: baselinesCreated,
        regression: {
          slope: slope / 100, // Convert to dollars per day
          intercept: intercept / 100,
          r_squared,
          interpretation: slope > 0
            ? `CAC was increasing by $${(slope / 100).toFixed(2)}/day before ClearLift`
            : `CAC was decreasing by $${(Math.abs(slope) / 100).toFixed(2)}/day before ClearLift`
        },
        ai_impact: {
          first_ai_date: firstAIDate,
          accepted_decisions: decisionsResult.results?.length || 0,
          total_impact_percent: totalImpact
        }
      });

    } catch (err) {
      console.error('CAC baseline computation error:', err);
      return error(c, 'CAC_BASELINE_ERROR', 'Failed to compute CAC baselines', 500);
    }
  }

  /**
   * Linear regression: y = mx + b
   */
  private linearRegression(points: Array<{ x: number; y: number }>): {
    slope: number;
    intercept: number;
    r_squared: number;
  } {
    const n = points.length;
    if (n === 0) return { slope: 0, intercept: 0, r_squared: 0 };

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (const { x, y } of points) {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return { slope: 0, intercept: sumY / n, r_squared: 0 };

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    // Calculate R² (coefficient of determination)
    const yMean = sumY / n;
    let ssTotal = 0, ssResidual = 0;

    for (const { x, y } of points) {
      const yPredicted = slope * x + intercept;
      ssTotal += (y - yMean) ** 2;
      ssResidual += (y - yPredicted) ** 2;
    }

    const r_squared = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);

    return { slope, intercept, r_squared };
  }

  /**
   * Upsert a baseline record
   */
  private async upsertBaseline(
    db: D1Database,
    orgId: string,
    date: string,
    actualCacCents: number,
    baselineCacCents: number,
    method: string,
    calculationData: Record<string, any>
  ): Promise<void> {
    await db.prepare(`
      INSERT INTO cac_baselines (
        organization_id, baseline_date, actual_cac_cents, baseline_cac_cents,
        calculation_method, calculation_data
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, baseline_date)
      DO UPDATE SET
        actual_cac_cents = excluded.actual_cac_cents,
        baseline_cac_cents = excluded.baseline_cac_cents,
        calculation_method = excluded.calculation_method,
        calculation_data = excluded.calculation_data,
        created_at = datetime('now')
    `).bind(
      orgId,
      date,
      actualCacCents,
      baselineCacCents,
      method,
      JSON.stringify(calculationData)
    ).run();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /v1/analytics/cac/backfill
// ═══════════════════════════════════════════════════════════════════════════

export class BackfillCACHistory extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Backfill CAC history from platform metrics",
    description: "Populates cac_history table from campaign_daily_metrics",
    operationId: "backfill-cac-history",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string(),
              days: z.number().min(1).max(90).optional().default(30)
            })
          }
        }
      }
    },
    responses: {
      200: { description: "Backfill complete" }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id, days } = data.body;

    try {
      // Query daily spend and conversions across all platform-specific tables
      const metricsResult = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          metric_date as date,
          SUM(spend_cents) as spend_cents,
          SUM(conversions) as conversions
        FROM (
          SELECT metric_date, spend_cents, conversions FROM facebook_campaign_daily_metrics
          WHERE organization_id = ?1 AND metric_date >= date('now', '-' || ?2 || ' days')
          UNION ALL
          SELECT metric_date, spend_cents, conversions FROM google_campaign_daily_metrics
          WHERE organization_id = ?1 AND metric_date >= date('now', '-' || ?2 || ' days')
          UNION ALL
          SELECT metric_date, spend_cents, conversions FROM tiktok_campaign_daily_metrics
          WHERE organization_id = ?1 AND metric_date >= date('now', '-' || ?2 || ' days')
        )
        GROUP BY metric_date
        ORDER BY metric_date ASC
      `).bind(org_id, days).all<{
        date: string;
        spend_cents: number;
        conversions: number;
      }>();

      if (!metricsResult.results || metricsResult.results.length === 0) {
        return success(c, {
          success: true,
          message: 'No metrics data to backfill',
          rows_inserted: 0
        });
      }

      let rowsInserted = 0;

      for (const row of metricsResult.results) {
        if (row.conversions === 0) continue;

        const cacCents = Math.round(row.spend_cents / row.conversions);

        await c.env.AI_DB.prepare(`
          INSERT INTO cac_history (
            organization_id, date, spend_cents, conversions, revenue_cents, cac_cents
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(organization_id, date)
          DO UPDATE SET
            spend_cents = excluded.spend_cents,
            conversions = excluded.conversions,
            revenue_cents = excluded.revenue_cents,
            cac_cents = excluded.cac_cents,
            created_at = datetime('now')
        `).bind(
          org_id,
          row.date,
          row.spend_cents,
          row.conversions,
          0, // revenue_cents - not available in campaign metrics
          cacCents
        ).run();

        rowsInserted++;
      }

      return success(c, {
        success: true,
        rows_inserted: rowsInserted,
        date_range: {
          start: metricsResult.results[0]?.date,
          end: metricsResult.results[metricsResult.results.length - 1]?.date
        }
      });

    } catch (err) {
      console.error('CAC backfill error:', err);
      return error(c, 'CAC_BACKFILL_ERROR', 'Failed to backfill CAC history', 500);
    }
  }
}
