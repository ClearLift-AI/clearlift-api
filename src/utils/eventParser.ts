import { ConversionEvent } from '../services/eventAnalytics';

export interface ParseOptions {
  organizationId: string;
  format?: 'csv' | 'json' | 'jsonl' | 'auto';
  batchSize?: number;
  validateSchema?: boolean;
}

export class EventParser {
  /**
   * Parse CSV string into events
   */
  static parseCSV(csvContent: string, organizationId: string): ConversionEvent[] {
    const lines = csvContent.trim().split('\n');
    if (lines.length < 2) return [];

    // Parse headers
    const headers = this.parseCSVLine(lines[0]);
    const events: ConversionEvent[] = [];

    // Parse each data row
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length !== headers.length) continue;

      const event: any = {};
      headers.forEach((header, index) => {
        const value = values[index];
        // Handle empty values
        if (value === '' || value === 'null' || value === 'undefined') {
          event[header] = null;
        } else if (header === 'event_value') {
          event[header] = parseFloat(value) || 0;
        } else {
          event[header] = value;
        }
      });

      // Ensure required fields
      event.organization_id = organizationId;
      event.id = event.id || crypto.randomUUID();
      event.event_id = event.event_id || `evt_${crypto.randomUUID().slice(0, 12)}`;
      
      events.push(event as ConversionEvent);
    }

    return events;
  }

  /**
   * Parse a single CSV line handling quoted values
   */
  private static parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote mode
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    // Add last field
    result.push(current.trim());
    return result;
  }

  /**
   * Parse JSON array of events
   */
  static parseJSON(jsonContent: string, organizationId: string): ConversionEvent[] {
    try {
      const data = JSON.parse(jsonContent);
      const events = Array.isArray(data) ? data : [data];
      
      return events.map(event => ({
        ...event,
        organization_id: organizationId,
        id: event.id || crypto.randomUUID(),
        event_id: event.event_id || `evt_${crypto.randomUUID().slice(0, 12)}`,
        event_value: parseFloat(event.event_value) || 0,
      }));
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
  }

  /**
   * Parse JSONL (newline-delimited JSON)
   */
  static parseJSONL(jsonlContent: string, organizationId: string): ConversionEvent[] {
    const lines = jsonlContent.trim().split('\n');
    const events: ConversionEvent[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        events.push({
          ...event,
          organization_id: organizationId,
          id: event.id || crypto.randomUUID(),
          event_id: event.event_id || `evt_${crypto.randomUUID().slice(0, 12)}`,
          event_value: parseFloat(event.event_value) || 0,
        });
      } catch (error) {
        console.warn(`Skipping invalid JSONL line: ${line}`);
      }
    }

    return events;
  }

  /**
   * Auto-detect format and parse
   */
  static parse(content: string, options: ParseOptions): ConversionEvent[] {
    let format = options.format || 'auto';

    if (format === 'auto') {
      // Try to detect format
      const trimmed = content.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        format = 'json';
      } else if (trimmed.includes('\n{')) {
        format = 'jsonl';
      } else {
        format = 'csv';
      }
    }

    switch (format) {
      case 'csv':
        return this.parseCSV(content, options.organizationId);
      case 'json':
        return this.parseJSON(content, options.organizationId);
      case 'jsonl':
        return this.parseJSONL(content, options.organizationId);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Convert events to CSV format
   */
  static toCSV(events: ConversionEvent[]): string {
    if (events.length === 0) return '';

    // Get all unique keys from all events
    const allKeys = new Set<string>();
    events.forEach(event => {
      Object.keys(event).forEach(key => allKeys.add(key));
    });
    
    const headers = Array.from(allKeys).sort();
    const lines: string[] = [];

    // Add header row
    lines.push(headers.map(h => this.escapeCSVValue(h)).join(','));

    // Add data rows
    for (const event of events) {
      const values = headers.map(header => {
        const value = (event as any)[header];
        return this.escapeCSVValue(value);
      });
      lines.push(values.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Escape CSV value if needed
   */
  private static escapeCSVValue(value: any): string {
    if (value === null || value === undefined) return '';
    
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Convert events to JSON format
   */
  static toJSON(events: ConversionEvent[]): string {
    return JSON.stringify(events, null, 2);
  }

  /**
   * Convert events to JSONL format
   */
  static toJSONL(events: ConversionEvent[]): string {
    return events.map(event => JSON.stringify(event)).join('\n');
  }
}