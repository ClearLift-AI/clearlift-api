/**
 * Analysis Queries — Read-only helpers for fetching analysis results from D1.
 *
 * Extracted from HierarchicalAnalyzer. These are pure D1 queries that don't
 * require any of the LLM/metrics/prompt service dependencies.
 */

export interface AnalysisSummary {
  id: string;
  organization_id: string;
  level: string;
  platform: string | null;
  entity_id: string;
  entity_name: string;
  summary: string;
  metrics_snapshot: string;
  days: number;
  analysis_run_id: string;
  created_at: string;
}

/**
 * Get latest analysis results for an organization.
 * Queries analysis_jobs + analysis_summaries in DB.
 */
export async function getLatestAnalysis(
  db: D1Database,
  orgId: string
): Promise<{
  runId: string;
  crossPlatformSummary: AnalysisSummary | null;
  platformSummaries: AnalysisSummary[];
  createdAt: string;
} | null> {
  const latestJob = await db.prepare(`
    SELECT id, analysis_run_id, created_at
    FROM analysis_jobs
    WHERE organization_id = ? AND status = 'completed' AND analysis_run_id IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `).bind(orgId).first<{ id: string; analysis_run_id: string; created_at: string }>();

  if (!latestJob) return null;

  const summaries = await db.prepare(`
    SELECT * FROM analysis_summaries
    WHERE analysis_run_id = ?
    ORDER BY level, entity_name
  `).bind(latestJob.analysis_run_id).all<AnalysisSummary>();

  const results = summaries.results || [];
  const crossPlatform = results.find(s => s.level === 'cross_platform') || null;
  const platforms = results.filter(s => s.level === 'account');

  return {
    runId: latestJob.analysis_run_id,
    crossPlatformSummary: crossPlatform,
    platformSummaries: platforms,
    createdAt: latestJob.created_at
  };
}

/**
 * Get summary for a specific entity.
 * Queries analysis_summaries in DB.
 */
export async function getEntitySummary(
  db: D1Database,
  orgId: string,
  level: string,
  entityId: string
): Promise<AnalysisSummary | null> {
  const result = await db.prepare(`
    SELECT * FROM analysis_summaries
    WHERE organization_id = ? AND level = ? AND entity_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(orgId, level, entityId).first<AnalysisSummary>();

  return result || null;
}
