/**
 * Analysis Logger
 *
 * Logs all LLM calls to DB for audit trail and cost tracking
 */

import { AnalysisLevel, LLMProvider } from './llm-provider';

export interface AnalysisLogEntry {
  id: string;
  organization_id: string;
  level: AnalysisLevel;
  platform: string | null;
  entity_id: string;
  entity_name: string;
  provider: LLMProvider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  prompt: string;
  response: string;
  analysis_run_id: string | null;
  created_at: string;
}

export interface LogCallParams {
  orgId: string;
  level: AnalysisLevel;
  platform?: string;
  entityId: string;
  entityName: string;
  provider: LLMProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  prompt: string;
  response: string;
  analysisRunId?: string;
}

export class AnalysisLogger {
  constructor(private db: D1Database) {}

  /**
   * Log an LLM call to the database
   */
  async logCall(params: LogCallParams): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, '');

    await this.db.prepare(`
      INSERT INTO analysis_logs (
        id, organization_id, level, platform, entity_id, entity_name,
        provider, model, input_tokens, output_tokens, latency_ms,
        prompt, response, analysis_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      params.orgId,
      params.level,
      params.platform ?? null,
      params.entityId ?? null,
      params.entityName ?? null,
      params.provider ?? null,
      params.model ?? null,
      params.inputTokens ?? 0,
      params.outputTokens ?? 0,
      params.latencyMs ?? 0,
      params.prompt ?? null,
      params.response ?? null,
      params.analysisRunId ?? null
    ).run();

    return id;
  }

  /**
   * Get recent logs for an organization
   */
  async getRecentLogs(
    orgId: string,
    limit: number = 50
  ): Promise<AnalysisLogEntry[]> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_logs
      WHERE organization_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(orgId, limit).all<AnalysisLogEntry>();

    return result.results || [];
  }

  /**
   * Get logs for a specific analysis run
   */
  async getLogsByRunId(runId: string): Promise<AnalysisLogEntry[]> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_logs
      WHERE analysis_run_id = ?
      ORDER BY created_at ASC
    `).bind(runId).all<AnalysisLogEntry>();

    return result.results || [];
  }

  /**
   * Get token usage summary for an organization
   */
  async getTokenUsageSummary(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
    byProvider: Record<LLMProvider, {
      inputTokens: number;
      outputTokens: number;
      calls: number;
    }>;
  }> {
    const result = await this.db.prepare(`
      SELECT
        provider,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as call_count
      FROM analysis_logs
      WHERE organization_id = ?
        AND created_at >= ?
        AND created_at <= ?
      GROUP BY provider
    `).bind(orgId, startDate, endDate).all<{
      provider: LLMProvider;
      total_input: number;
      total_output: number;
      call_count: number;
    }>();

    const byProvider: Record<LLMProvider, {
      inputTokens: number;
      outputTokens: number;
      calls: number;
    }> = {
      claude: { inputTokens: 0, outputTokens: 0, calls: 0 },
      gemini: { inputTokens: 0, outputTokens: 0, calls: 0 }
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCalls = 0;

    for (const row of result.results || []) {
      byProvider[row.provider] = {
        inputTokens: row.total_input,
        outputTokens: row.total_output,
        calls: row.call_count
      };
      totalInputTokens += row.total_input;
      totalOutputTokens += row.total_output;
      totalCalls += row.call_count;
    }

    return { totalInputTokens, totalOutputTokens, totalCalls, byProvider };
  }
}
