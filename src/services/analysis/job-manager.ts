/**
 * Job Manager
 *
 * Manages async analysis job lifecycle
 */

import { AnalysisLevel } from './llm-provider';
import { JobStatus } from '../../types';
import { structuredLog } from '../../utils/structured-logger';

// Re-export for backward compatibility
export type { JobStatus } from '../../types';

export type StoppedReason = 'max_recommendations' | 'no_tool_calls' | 'max_iterations' | 'early_termination';

export interface AnalysisJob {
  id: string;
  organization_id: string;
  days: number;
  webhook_url: string | null;
  status: JobStatus;
  total_entities: number | null;
  processed_entities: number;
  current_level: AnalysisLevel | null;
  analysis_run_id: string | null;
  error_message: string | null;
  stopped_reason: StoppedReason | null;
  termination_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobProgress {
  processed: number;
  total: number | null;
  currentLevel: AnalysisLevel | null;
  percentComplete: number | null;
}

export class JobManager {
  constructor(private db: D1Database) {}

  /**
   * Create a new analysis job
   */
  async createJob(
    orgId: string,
    days: number,
    webhookUrl?: string
  ): Promise<string> {
    const jobId = crypto.randomUUID().replace(/-/g, '');

    await this.db.prepare(`
      INSERT INTO analysis_jobs (
        id, organization_id, days, webhook_url, status
      ) VALUES (?, ?, ?, ?, 'pending')
    `).bind(jobId, orgId, days, webhookUrl || null).run();

    return jobId;
  }

  /**
   * Start a job (set status to running)
   */
  async startJob(jobId: string, totalEntities: number): Promise<void> {
    await this.db.prepare(`
      UPDATE analysis_jobs
      SET status = 'running',
          total_entities = ?,
          started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).bind(totalEntities, jobId).run();
  }

  /**
   * Update job progress
   */
  async updateProgress(
    jobId: string,
    processed: number,
    currentLevel: AnalysisLevel
  ): Promise<void> {
    await this.db.prepare(`
      UPDATE analysis_jobs
      SET processed_entities = ?,
          current_level = ?
      WHERE id = ?
    `).bind(processed, currentLevel, jobId).run();
  }

  /**
   * Complete a job successfully
   */
  async completeJob(
    jobId: string,
    analysisRunId: string,
    stoppedReason?: StoppedReason,
    terminationReason?: string
  ): Promise<void> {
    await this.db.prepare(`
      UPDATE analysis_jobs
      SET status = 'completed',
          analysis_run_id = ?,
          stopped_reason = ?,
          termination_reason = ?,
          completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).bind(analysisRunId, stoppedReason || null, terminationReason || null, jobId).run();

    // Check for webhook and trigger if set
    const job = await this.getJob(jobId);
    if (job?.webhook_url) {
      await this.triggerWebhook(job);
    }
  }

  /**
   * Mark a job as failed
   */
  async failJob(jobId: string, errorMessage: string): Promise<void> {
    await this.db.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed',
          error_message = ?,
          completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).bind(errorMessage, jobId).run();

    // Check for webhook and trigger if set
    const job = await this.getJob(jobId);
    if (job?.webhook_url) {
      await this.triggerWebhook(job);
    }
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<AnalysisJob | null> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_jobs WHERE id = ?
    `).bind(jobId).first<AnalysisJob>();

    return result || null;
  }

  /**
   * Get job progress
   */
  async getJobProgress(jobId: string): Promise<JobProgress | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;

    const percentComplete = job.total_entities
      ? Math.round((job.processed_entities / job.total_entities) * 100)
      : null;

    return {
      processed: job.processed_entities,
      total: job.total_entities,
      currentLevel: job.current_level,
      percentComplete
    };
  }

  /**
   * Get recent jobs for an organization
   */
  async getRecentJobs(orgId: string, limit: number = 10): Promise<AnalysisJob[]> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_jobs
      WHERE organization_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(orgId, limit).all<AnalysisJob>();

    return result.results || [];
  }

  /**
   * Get the most recent completed job for an organization
   */
  async getLatestCompletedJob(orgId: string): Promise<AnalysisJob | null> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_jobs
      WHERE organization_id = ? AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).bind(orgId).first<AnalysisJob>();

    return result || null;
  }

  /**
   * Trigger webhook notification
   */
  private async triggerWebhook(job: AnalysisJob): Promise<void> {
    if (!job.webhook_url) return;

    try {
      await fetch(job.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'analysis_complete',
          job_id: job.id,
          status: job.status,
          analysis_run_id: job.analysis_run_id,
          error_message: job.error_message,
          completed_at: job.completed_at
        })
      });
    } catch (error) {
      // Webhook failure shouldn't affect job completion
      structuredLog('ERROR', 'Webhook trigger failed', { service: 'job-manager', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
