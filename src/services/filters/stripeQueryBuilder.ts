/**
 * Stripe Query Builder
 *
 * Converts filter rules into Stripe Search API queries and applies
 * client-side filtering for unsupported operations
 */

import {
  FilterRule,
  FilterCondition,
  FilterOperator,
  FilterValidationResult,
  MetadataKeyInfo
} from './types';

export class StripeQueryBuilder {
  /**
   * Check if a filter can be handled by Stripe Search API
   */
  canUseStripeSearch(condition: FilterCondition): boolean {
    // Stripe Search API supports limited operators for metadata
    if (condition.type === 'metadata') {
      return ['equals', 'not_equals', 'exists', 'not_exists'].includes(condition.operator);
    }

    // Standard fields with supported operators
    if (condition.type === 'standard') {
      switch (condition.field) {
        case 'amount':
          return ['equals', 'gt', 'gte', 'lt', 'lte'].includes(condition.operator);
        case 'currency':
        case 'status':
        case 'customer_id':
          return ['equals', 'not_equals'].includes(condition.operator);
        default:
          return false;
      }
    }

    return false;
  }

  /**
   * Build Stripe Search API query from filter rules
   */
  buildQuery(rules: FilterRule[]): string {
    const clauses: string[] = [];

    for (const rule of rules) {
      if (!rule.is_active) continue;

      const ruleClause = this.buildRuleClause(rule);
      if (ruleClause) {
        clauses.push(ruleClause);
      }
    }

    // Stripe Search API combines with AND by default
    return clauses.join(' AND ');
  }

  private buildRuleClause(rule: FilterRule): string | null {
    const conditions = rule.conditions
      .filter(c => this.canUseStripeSearch(c))
      .map(c => this.buildConditionClause(c))
      .filter(c => c !== null) as string[];

    if (conditions.length === 0) return null;

    // Wrap OR conditions in parentheses
    if (rule.operator === 'OR' && conditions.length > 1) {
      return `(${conditions.join(' OR ')})`;
    }

    return conditions.join(` ${rule.operator} `);
  }

  private buildConditionClause(condition: FilterCondition): string | null {
    if (condition.type === 'metadata') {
      return this.buildMetadataClause(condition);
    }

    return this.buildStandardClause(condition);
  }

  private buildMetadataClause(condition: FilterCondition): string | null {
    const { metadata_key, operator, value } = condition;

    if (!metadata_key) return null;

    // Escape special characters in metadata key
    const escapedKey = metadata_key.replace(/"/g, '\\"');

    switch (operator) {
      case 'equals':
        return `metadata["${escapedKey}"]:"${this.escapeValue(value)}"`;
      case 'not_equals':
        return `-metadata["${escapedKey}"]:"${this.escapeValue(value)}"`;
      case 'exists':
        return `-metadata["${escapedKey}"]:null`;
      case 'not_exists':
        return `metadata["${escapedKey}"]:null`;
      default:
        return null;
    }
  }

  private buildStandardClause(condition: FilterCondition): string | null {
    const { field, operator, value } = condition;

    if (!field) return null;

    switch (field) {
      case 'amount':
        return this.buildNumericClause('amount', operator as FilterOperator, value);
      case 'currency':
      case 'status':
        if (operator === 'equals') {
          return `${field}:"${this.escapeValue(value)}"`;
        } else if (operator === 'not_equals') {
          return `-${field}:"${this.escapeValue(value)}"`;
        }
        break;
      case 'customer_id':
        if (operator === 'equals') {
          return `customer:"${this.escapeValue(value)}"`;
        } else if (operator === 'not_equals') {
          return `-customer:"${this.escapeValue(value)}"`;
        }
        break;
    }

    return null;
  }

  private buildNumericClause(field: string, operator: FilterOperator, value: any): string | null {
    const numValue = Number(value);
    if (isNaN(numValue)) return null;

    switch (operator) {
      case 'equals':
        return `${field}:${numValue}`;
      case 'gt':
        return `${field}>${numValue}`;
      case 'gte':
        return `${field}>=${numValue}`;
      case 'lt':
        return `${field}<${numValue}`;
      case 'lte':
        return `${field}<=${numValue}`;
      default:
        return null;
    }
  }

  private escapeValue(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/"/g, '\\"');
  }

  /**
   * Apply filters to local dataset (for operations Stripe Search doesn't support)
   */
  applyFilters(data: any[], rules: FilterRule[]): any[] {
    let filtered = [...data];

    for (const rule of rules) {
      if (!rule.is_active) continue;

      filtered = this.applyRule(filtered, rule);
    }

    return filtered;
  }

  private applyRule(data: any[], rule: FilterRule): any[] {
    return data.filter(item => {
      const results = rule.conditions.map(condition =>
        this.evaluateCondition(item, condition)
      );

      if (rule.operator === 'OR') {
        return results.some(r => r);
      } else {
        return results.every(r => r);
      }
    });
  }

  private evaluateCondition(item: any, condition: FilterCondition): boolean {
    if (condition.type === 'metadata') {
      return this.evaluateMetadataCondition(item, condition);
    }

    return this.evaluateStandardCondition(item, condition);
  }

  private evaluateMetadataCondition(item: any, condition: FilterCondition): boolean {
    const { metadata_source, metadata_key, operator, value } = condition;

    if (!metadata_source || !metadata_key) return false;

    // Get the metadata object
    const metadataField = `${metadata_source}_metadata`;
    let metadata = item[metadataField];

    // Parse if stored as JSON string
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        return false;
      }
    }

    if (!metadata || typeof metadata !== 'object') {
      return operator === 'not_exists';
    }

    // Support nested keys with dot notation
    const metadataValue = this.getNestedValue(metadata, metadata_key);

    return this.compareValues(metadataValue, operator, value);
  }

  private evaluateStandardCondition(item: any, condition: FilterCondition): boolean {
    const { field, operator, value } = condition;

    if (!field) return false;

    const itemValue = item[field];
    return this.compareValues(itemValue, operator, value);
  }

  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private compareValues(actual: any, operator: FilterOperator, expected: any): boolean {
    switch (operator) {
      case 'equals':
        return actual == expected;
      case 'not_equals':
        return actual != expected;
      case 'contains':
        return String(actual).includes(String(expected));
      case 'not_contains':
        return !String(actual).includes(String(expected));
      case 'starts_with':
        return String(actual).startsWith(String(expected));
      case 'ends_with':
        return String(actual).endsWith(String(expected));
      case 'gt':
        return Number(actual) > Number(expected);
      case 'gte':
        return Number(actual) >= Number(expected);
      case 'lt':
        return Number(actual) < Number(expected);
      case 'lte':
        return Number(actual) <= Number(expected);
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'not_in':
        return Array.isArray(expected) && !expected.includes(actual);
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'not_exists':
        return actual === undefined || actual === null;
      case 'regex':
        try {
          const regex = new RegExp(String(expected));
          return regex.test(String(actual));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Validate filter syntax
   */
  validateFilter(rule: FilterRule): FilterValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!rule.name) {
      errors.push('Filter name is required');
    }

    if (!rule.conditions || rule.conditions.length === 0) {
      errors.push('At least one condition is required');
    }

    // Check Stripe Search API limit (10 clauses)
    const searchableConditions = rule.conditions.filter(c => this.canUseStripeSearch(c));
    if (searchableConditions.length > 10) {
      warnings.push('Stripe Search API supports maximum 10 conditions. Additional conditions will be applied client-side.');
    }

    // Validate each condition
    for (let i = 0; i < rule.conditions.length; i++) {
      const condition = rule.conditions[i];
      const conditionErrors = this.validateCondition(condition);

      if (conditionErrors.length > 0) {
        errors.push(`Condition ${i + 1}: ${conditionErrors.join(', ')}`);
      }

      // Warn about client-side filtering
      if (!this.canUseStripeSearch(condition)) {
        warnings.push(`Condition ${i + 1} will be applied client-side (not supported by Stripe Search API)`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  private validateCondition(condition: FilterCondition): string[] {
    const errors: string[] = [];

    if (!condition.type) {
      errors.push('Condition type is required');
    }

    if (!condition.operator) {
      errors.push('Operator is required');
    }

    if (condition.type === 'standard' && !condition.field) {
      errors.push('Field is required for standard conditions');
    }

    if (condition.type === 'metadata') {
      if (!condition.metadata_source) {
        errors.push('Metadata source is required');
      }
      if (!condition.metadata_key) {
        errors.push('Metadata key is required');
      }
    }

    // Validate operator requires value
    const requiresValue = !['exists', 'not_exists'].includes(condition.operator);
    if (requiresValue && (condition.value === undefined || condition.value === null)) {
      errors.push(`Value is required for operator '${condition.operator}'`);
    }

    // Validate numeric operators
    const numericOperators = ['gt', 'gte', 'lt', 'lte'];
    if (numericOperators.includes(condition.operator) && condition.value !== undefined) {
      if (isNaN(Number(condition.value))) {
        errors.push(`Numeric value required for operator '${condition.operator}'`);
      }
    }

    // Validate array operators
    const arrayOperators = ['in', 'not_in'];
    if (arrayOperators.includes(condition.operator) && !Array.isArray(condition.value)) {
      errors.push(`Array value required for operator '${condition.operator}'`);
    }

    return errors;
  }

  /**
   * Extract metadata keys from data samples
   */
  extractMetadataKeys(data: any[]): Map<string, MetadataKeyInfo> {
    const keyMap = new Map<string, MetadataKeyInfo>();

    const sources: MetadataSource[] = ['charge', 'product', 'price', 'customer'];

    for (const item of data) {
      for (const source of sources) {
        const metadataField = `${source}_metadata`;
        let metadata = item[metadataField];

        if (!metadata) continue;

        // Parse if JSON string
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            continue;
          }
        }

        if (typeof metadata === 'object' && metadata !== null) {
          this.extractKeysFromObject(metadata, source, '', keyMap);
        }
      }
    }

    return keyMap;
  }

  private extractKeysFromObject(
    obj: any,
    source: MetadataSource,
    prefix: string,
    keyMap: Map<string, MetadataKeyInfo>
  ): void {
    for (const key in obj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const mapKey = `${source}:${fullKey}`;

      let keyInfo = keyMap.get(mapKey);
      if (!keyInfo) {
        keyInfo = {
          key: fullKey,
          source,
          value_types: new Set(),
          sample_values: [],
          occurrence_count: 0
        };
        keyMap.set(mapKey, keyInfo);
      }

      keyInfo.occurrence_count++;

      const value = obj[key];
      const valueType = value === null ? 'null' : typeof value;
      keyInfo.value_types.add(valueType);

      // Store sample values (limit to 5)
      if (keyInfo.sample_values.length < 5 && !keyInfo.sample_values.includes(value)) {
        keyInfo.sample_values.push(value);
      }

      // Recursively extract nested keys
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this.extractKeysFromObject(value, source, fullKey, keyMap);
      }
    }
  }
}