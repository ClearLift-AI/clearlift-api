/**
 * Prompt Manager
 *
 * Handles prompt template loading, caching, and hydration
 */

import { AnalysisLevel } from './llm-provider';

interface PromptTemplate {
  id: string;
  slug: string;
  level: AnalysisLevel;
  platform: string | null;
  template: string;
  version: number;
}

interface ChildSummary {
  name: string;
  summary: string;
  platform?: string;
}

export class PromptManager {
  // In-memory cache for templates
  private templateCache: Map<string, PromptTemplate> = new Map();

  constructor(private db: D1Database) {}

  /**
   * Get a prompt template by slug
   * Uses in-memory cache to avoid repeated DB queries
   */
  async getTemplate(slug: string): Promise<string | null> {
    // Check cache first
    if (this.templateCache.has(slug)) {
      return this.templateCache.get(slug)!.template;
    }

    // Query database
    const result = await this.db.prepare(
      'SELECT id, slug, level, platform, template, version FROM analysis_prompts WHERE slug = ?'
    ).bind(slug).first<PromptTemplate>();

    if (!result) {
      return null;
    }

    // Cache and return
    this.templateCache.set(slug, result);
    return result.template;
  }

  /**
   * Get template for a specific level and platform
   * Falls back to default level template if platform-specific not found
   */
  async getTemplateForLevel(
    level: AnalysisLevel,
    platform?: string
  ): Promise<string | null> {
    // Try platform-specific first
    if (platform) {
      const platformSlug = `${level}_level_${platform}`;
      const platformTemplate = await this.getTemplate(platformSlug);
      if (platformTemplate) {
        return platformTemplate;
      }
    }

    // Fall back to default level template
    const defaultSlug = `${level}_level_default`;
    return this.getTemplate(defaultSlug);
  }

  /**
   * Hydrate a template with variables
   * Replaces {placeholder} with actual values
   */
  hydrateTemplate(template: string, variables: Record<string, string>): string {
    let hydrated = template;

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      hydrated = hydrated.replaceAll(placeholder, value);
    }

    return hydrated;
  }

  /**
   * Format child summaries as a structured outline
   * Used for parent-level prompts that need to see child summaries
   */
  formatChildSummaries(children: ChildSummary[]): string {
    if (children.length === 0) {
      return '_No child entities to summarize._';
    }

    const lines: string[] = [];

    for (const child of children) {
      const prefix = child.platform ? `[${child.platform}] ` : '';
      lines.push(`### ${prefix}${child.name}`);
      lines.push(child.summary);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format metrics as a markdown table
   */
  formatMetricsTable(
    metrics: Array<{
      date: string;
      impressions: number;
      clicks: number;
      spend_cents: number;
      conversions: number;
      conversion_value_cents: number;
    }>
  ): string {
    if (metrics.length === 0) {
      return '_No metrics available._';
    }

    // Sort by date descending
    const sorted = [...metrics].sort((a, b) =>
      b.date.localeCompare(a.date)
    );

    const lines: string[] = [];
    lines.push('| Date | Spend | Impr | Clicks | CTR | Conv | ROAS |');
    lines.push('|------|-------|------|--------|-----|------|------|');

    for (const m of sorted) {
      const spend = (m.spend_cents / 100).toFixed(2);
      const ctr = m.impressions > 0
        ? ((m.clicks / m.impressions) * 100).toFixed(2)
        : '0.00';
      const roas = m.spend_cents > 0
        ? (m.conversion_value_cents / m.spend_cents).toFixed(2)
        : '0.00';

      lines.push(
        `| ${m.date} | $${spend} | ${m.impressions.toLocaleString()} | ${m.clicks} | ${ctr}% | ${m.conversions} | ${roas}x |`
      );
    }

    return lines.join('\n');
  }

  /**
   * Clear the template cache
   * Useful when templates are updated
   */
  clearCache(): void {
    this.templateCache.clear();
  }
}
