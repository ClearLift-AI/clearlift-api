/**
 * Filter System Type Definitions
 *
 * Supports filtering on standard fields and arbitrary user-defined metadata
 */

export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists'
  | 'regex';

export type LogicalOperator = 'AND' | 'OR';

export type StandardField =
  | 'charge_id'
  | 'product_id'
  | 'price_id'
  | 'amount'
  | 'currency'
  | 'status'
  | 'customer_id'
  | 'description'
  | 'created_at';

export type MetadataSource = 'charge' | 'product' | 'price' | 'customer';

export interface FilterCondition {
  type: 'standard' | 'metadata';

  // For standard fields
  field?: StandardField;

  // For metadata - completely open-ended
  metadata_source?: MetadataSource;
  metadata_key?: string; // ANY key the user has defined

  operator: FilterOperator;
  value?: any; // Can be string, number, boolean, array, etc.
}

export interface FilterRule {
  id?: string;
  name: string;
  description?: string;
  operator: LogicalOperator;
  conditions: FilterCondition[];
  is_active?: boolean;
}

export interface FilterValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface MetadataKeyInfo {
  key: string;
  source: MetadataSource;
  value_types: Set<string>;
  sample_values: any[];
  occurrence_count: number;
  nested_keys?: MetadataKeyInfo[];
}