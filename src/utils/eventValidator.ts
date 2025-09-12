import { z } from 'zod';
import { ConversionEvent } from '../services/eventAnalytics';

// Zod schema for event validation
export const ConversionEventSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  event_id: z.string(),
  timestamp: z.string(), // ISO 8601 format
  event_type: z.string(),
  event_value: z.number(),
  currency: z.string().default('USD'),
  user_id: z.string(),
  session_id: z.string(),
  utm_source: z.string().optional().nullable(),
  utm_medium: z.string().optional().nullable(),
  utm_campaign: z.string().optional().nullable(),
  device_type: z.string().optional().nullable(),
  browser: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  attribution_path: z.string().optional().nullable(),
});

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  validEvents: ConversionEvent[];
  invalidEvents: Array<{ event: any; error: string }>;
}

export class EventValidator {
  /**
   * Validate a single event
   */
  static validateEvent(event: any): { valid: boolean; error?: string; data?: ConversionEvent } {
    try {
      const validated = ConversionEventSchema.parse(event);
      return { valid: true, data: validated as ConversionEvent };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        return { valid: false, error: issues };
      }
      return { valid: false, error: String(error) };
    }
  }

  /**
   * Validate and normalize events
   */
  static validateEvents(events: any[], organizationId: string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      validEvents: [],
      invalidEvents: [],
    };

    for (let i = 0; i < events.length; i++) {
      const event = this.normalizeEvent(events[i], organizationId);
      const validation = this.validateEvent(event);

      if (validation.valid && validation.data) {
        result.validEvents.push(validation.data);
      } else {
        result.valid = false;
        result.invalidEvents.push({
          event: events[i],
          error: validation.error || 'Unknown error',
        });
        result.errors.push(`Event ${i + 1}: ${validation.error}`);
      }
    }

    return result;
  }

  /**
   * Normalize event data
   */
  static normalizeEvent(event: any, organizationId: string): any {
    const normalized = { ...event };

    // Ensure required fields
    normalized.organization_id = organizationId;
    normalized.id = normalized.id || crypto.randomUUID();
    normalized.event_id = normalized.event_id || `evt_${crypto.randomUUID().slice(0, 12)}`;

    // Ensure timestamp is ISO 8601
    if (normalized.timestamp) {
      try {
        const date = new Date(normalized.timestamp);
        normalized.timestamp = date.toISOString();
      } catch {
        normalized.timestamp = new Date().toISOString();
      }
    } else {
      normalized.timestamp = new Date().toISOString();
    }

    // Set defaults
    normalized.event_type = normalized.event_type || 'conversion';
    normalized.event_value = parseFloat(normalized.event_value) || 0;
    normalized.currency = normalized.currency || 'USD';
    normalized.user_id = normalized.user_id || 'unknown';
    normalized.session_id = normalized.session_id || crypto.randomUUID();

    // Clean up null/undefined optional fields
    const optionalFields = [
      'utm_source', 'utm_medium', 'utm_campaign',
      'device_type', 'browser', 'country', 'attribution_path'
    ];

    for (const field of optionalFields) {
      if (normalized[field] === '' || normalized[field] === 'null' || normalized[field] === 'undefined') {
        normalized[field] = null;
      }
    }

    return normalized;
  }

  /**
   * Batch validate with size limits
   */
  static validateBatch(
    events: any[],
    organizationId: string,
    maxBatchSize: number = 1000
  ): { batches: ConversionEvent[][]; errors: string[] } {
    const validation = this.validateEvents(events, organizationId);
    
    // Split valid events into batches
    const batches: ConversionEvent[][] = [];
    for (let i = 0; i < validation.validEvents.length; i += maxBatchSize) {
      batches.push(validation.validEvents.slice(i, i + maxBatchSize));
    }

    return {
      batches,
      errors: validation.errors,
    };
  }

  /**
   * Check if timestamp is within acceptable range
   */
  static isValidTimestamp(timestamp: string, maxDaysInFuture: number = 1, maxDaysInPast: number = 365): boolean {
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const futureLimit = new Date(now.getTime() + maxDaysInFuture * 24 * 60 * 60 * 1000);
      const pastLimit = new Date(now.getTime() - maxDaysInPast * 24 * 60 * 60 * 1000);

      return date >= pastLimit && date <= futureLimit;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize event data for security
   */
  static sanitizeEvent(event: any): any {
    const sanitized = { ...event };

    // Remove any potential script tags or SQL injection attempts
    for (const key in sanitized) {
      if (typeof sanitized[key] === 'string') {
        // Basic sanitization - remove script tags and SQL keywords
        sanitized[key] = sanitized[key]
          .replace(/<script[^>]*>.*?<\/script>/gi, '')
          .replace(/(<([^>]+)>)/gi, '')
          .trim();
      }
    }

    return sanitized;
  }
}