/**
 * Audit Logger Service for SOC 2 Compliance
 *
 * Provides centralized audit logging for all security-relevant events.
 * Implements async logging to minimize performance impact.
 */

import { AppContext } from "../types";
import { structuredLog } from '../utils/structured-logger';

export interface AuditLogEntry {
  user_id?: string;
  organization_id?: string;
  session_token_hash?: string;
  action: string;
  method?: string;
  path?: string;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  user_agent?: string;
  request_id?: string;
  success: boolean;
  status_code?: number;
  error_code?: string;
  error_message?: string;
  response_time_ms?: number;
  metadata?: Record<string, any>;
}

export interface AuthAuditEntry {
  event_type: 'login' | 'logout' | 'session_refresh' | 'oauth_connect' | 'failed_login';
  user_id?: string;
  email?: string;
  auth_method?: string;
  provider?: string;
  ip_address?: string;
  user_agent?: string;
  success: boolean;
  failure_reason?: string;
  session_id?: string;
  session_created?: boolean;
  metadata?: Record<string, any>;
}

export interface DataAccessEntry {
  user_id: string;
  organization_id: string;
  access_type: 'query' | 'export' | 'report' | 'api_fetch';
  data_source: 'r2_sql' | 'd1' | 'external_api';
  table_name?: string;
  query_hash?: string;
  filters_applied?: Record<string, any>;
  records_accessed?: number;
  fields_accessed?: string[];
  query_time_ms?: number;
  export_format?: string;
  export_destination?: string;
  contains_pii?: boolean;
  data_classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  request_id?: string;
  ip_address?: string;
}

export interface ConfigChangeEntry {
  user_id: string;
  organization_id?: string;
  config_type: string;
  config_id?: string;
  action: 'create' | 'update' | 'delete';
  field_name?: string;
  old_value?: any;
  new_value?: any;
  requires_approval?: boolean;
  approved_by?: string;
  approved_at?: string;
  request_id?: string;
  ip_address?: string;
  reason?: string;
}

export interface SecurityEventEntry {
  severity: 'info' | 'warning' | 'critical';
  event_type: string;
  user_id?: string;
  organization_id?: string;
  threat_indicator?: string;
  threat_source?: string;
  automated_response?: string;
  manual_review_required?: boolean;
  request_data?: string;
  metadata?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  request_id?: string;
}

export class AuditLogger {
  constructor(private db: D1Database) {}

  /**
   * Hash sensitive data for logging (like session tokens)
   */
  private async hashSensitive(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Log general API activity
   */
  async logApiRequest(entry: AuditLogEntry): Promise<void> {
    try {
      const tokenHash = entry.session_token_hash
        ? await this.hashSensitive(entry.session_token_hash)
        : null;

      await this.db.prepare(`
        INSERT INTO audit_logs (
          user_id, organization_id, session_token_hash, action, method, path,
          resource_type, resource_id, ip_address, user_agent, request_id,
          success, status_code, error_code, error_message, response_time_ms, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.user_id || null,
        entry.organization_id || null,
        tokenHash,
        entry.action,
        entry.method || null,
        entry.path || null,
        entry.resource_type || null,
        entry.resource_id || null,
        entry.ip_address || null,
        entry.user_agent || null,
        entry.request_id || null,
        entry.success ? 1 : 0,
        entry.status_code || null,
        entry.error_code || null,
        entry.error_message || null,
        entry.response_time_ms || null,
        JSON.stringify(entry.metadata || {})
      ).run();
    } catch (error) {
      // Log to console but don't fail the request
      structuredLog('ERROR', 'Failed to write audit log', { service: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Log authentication events
   */
  async logAuthEvent(entry: AuthAuditEntry): Promise<void> {
    try {
      await this.db.prepare(`
        INSERT INTO auth_audit_logs (
          event_type, user_id, email, auth_method, provider,
          ip_address, user_agent, success, failure_reason,
          session_id, session_created, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.event_type,
        entry.user_id || null,
        entry.email || null,
        entry.auth_method || null,
        entry.provider || null,
        entry.ip_address || null,
        entry.user_agent || null,
        entry.success ? 1 : 0,
        entry.failure_reason || null,
        entry.session_id || null,
        entry.session_created ? 1 : 0,
        JSON.stringify(entry.metadata || {})
      ).run();
    } catch (error) {
      structuredLog('ERROR', 'Failed to write auth audit log', { service: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Log data access events
   */
  async logDataAccess(entry: DataAccessEntry): Promise<void> {
    try {
      // Hash the query for pattern detection
      const queryHash = entry.query_hash
        ? await this.hashSensitive(entry.query_hash)
        : null;

      await this.db.prepare(`
        INSERT INTO data_access_logs (
          user_id, organization_id, access_type, data_source, table_name,
          query_hash, filters_applied, records_accessed, fields_accessed,
          query_time_ms, export_format, export_destination, contains_pii,
          data_classification, request_id, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.user_id,
        entry.organization_id,
        entry.access_type,
        entry.data_source,
        entry.table_name || null,
        queryHash,
        JSON.stringify(entry.filters_applied || {}),
        entry.records_accessed || null,
        JSON.stringify(entry.fields_accessed || []),
        entry.query_time_ms || null,
        entry.export_format || null,
        entry.export_destination || null,
        entry.contains_pii ? 1 : 0,
        entry.data_classification || 'internal',
        entry.request_id || null,
        entry.ip_address || null
      ).run();
    } catch (error) {
      structuredLog('ERROR', 'Failed to write data access log', { service: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Log configuration changes
   */
  async logConfigChange(entry: ConfigChangeEntry): Promise<void> {
    try {
      // Encrypt sensitive values if needed
      const oldValue = this.sanitizeValue(entry.old_value);
      const newValue = this.sanitizeValue(entry.new_value);

      await this.db.prepare(`
        INSERT INTO config_audit_logs (
          user_id, organization_id, config_type, config_id, action,
          field_name, old_value, new_value, requires_approval,
          approved_by, approved_at, request_id, ip_address, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.user_id,
        entry.organization_id || null,
        entry.config_type,
        entry.config_id || null,
        entry.action,
        entry.field_name || null,
        oldValue,
        newValue,
        entry.requires_approval ? 1 : 0,
        entry.approved_by || null,
        entry.approved_at || null,
        entry.request_id || null,
        entry.ip_address || null,
        entry.reason || null
      ).run();
    } catch (error) {
      structuredLog('ERROR', 'Failed to write config audit log', { service: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Log security events
   */
  async logSecurityEvent(entry: SecurityEventEntry): Promise<void> {
    try {
      await this.db.prepare(`
        INSERT INTO security_events (
          severity, event_type, user_id, organization_id,
          threat_indicator, threat_source, automated_response,
          manual_review_required, request_data, metadata,
          ip_address, user_agent, request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.severity,
        entry.event_type,
        entry.user_id || null,
        entry.organization_id || null,
        entry.threat_indicator || null,
        entry.threat_source || null,
        entry.automated_response || null,
        entry.manual_review_required ? 1 : 0,
        entry.request_data || null,
        JSON.stringify(entry.metadata || {}),
        entry.ip_address || null,
        entry.user_agent || null,
        entry.request_id || null
      ).run();

      // Alert on critical events
      if (entry.severity === 'critical') {
        structuredLog('CRITICAL', 'Critical security event detected', { service: 'AuditLogger', event_type: entry.event_type, user_id: entry.user_id, organization_id: entry.organization_id });
        // In production, this would trigger alerts
      }
    } catch (error) {
      structuredLog('ERROR', 'Failed to write security event log', { service: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Sanitize sensitive values for logging
   */
  private sanitizeValue(value: any): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    // Don't log passwords or tokens
    if (typeof value === 'string') {
      const sensitive = ['password', 'token', 'secret', 'key', 'credential'];
      const valueLower = value.toLowerCase();
      for (const keyword of sensitive) {
        if (valueLower.includes(keyword)) {
          return '[REDACTED]';
        }
      }
    }

    return JSON.stringify(value);
  }

  /**
   * Query audit logs for reporting
   */
  async getAuditLogs(filters: {
    user_id?: string;
    organization_id?: string;
    action?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<any[]> {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: any[] = [];

    if (filters.user_id) {
      query += ' AND user_id = ?';
      params.push(filters.user_id);
    }

    if (filters.organization_id) {
      query += ' AND organization_id = ?';
      params.push(filters.organization_id);
    }

    if (filters.action) {
      query += ' AND action = ?';
      params.push(filters.action);
    }

    if (filters.start_date) {
      query += ' AND timestamp >= ?';
      params.push(filters.start_date);
    }

    if (filters.end_date) {
      query += ' AND timestamp <= ?';
      params.push(filters.end_date);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const result = await this.db.prepare(query).bind(...params).all();
    return result.results || [];
  }

  /**
   * Get failed authentication attempts for security monitoring
   */
  async getFailedAuthAttempts(since: string, limit = 100): Promise<any[]> {
    const result = await this.db.prepare(`
      SELECT * FROM auth_audit_logs
      WHERE success = 0 AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(since, limit).all();

    return result.results || [];
  }

  /**
   * Get security events for incident response
   */
  async getSecurityEvents(severity?: string, requiresReview?: boolean): Promise<any[]> {
    let query = 'SELECT * FROM security_events WHERE 1=1';
    const params: any[] = [];

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }

    if (requiresReview !== undefined) {
      query += ' AND manual_review_required = ?';
      params.push(requiresReview ? 1 : 0);
    }

    query += ' ORDER BY timestamp DESC LIMIT 100';

    const result = await this.db.prepare(query).bind(...params).all();
    return result.results || [];
  }
}

/**
 * Create audit logger instance from context
 */
export function createAuditLogger(c: AppContext): AuditLogger {
  return new AuditLogger(c.env.DB);
}