/**
 * Canonical API Response Types
 *
 * Discriminated union with consistent metadata structure.
 * All API responses should use these types for consistency.
 *
 * Key design decisions:
 * - request_id in meta for SOC 2 compliance and debugging
 * - timestamp in meta (not in error object) for consistency
 * - Discriminated union via `success` field for type narrowing
 *
 * @see clearlift-cron/docs/SHARED_CODE.md for API patterns
 */

/**
 * Response metadata included in all API responses.
 * request_id enables request tracing for debugging and compliance.
 */
export interface ResponseMeta {
  timestamp: string;
  request_id: string;
  count?: number;
  page?: number;
  total?: number;
  [key: string]: unknown;
}

/**
 * Successful API response structure.
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

/**
 * Error response structure.
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ResponseMeta;
}

/**
 * Discriminated union type for all API responses.
 * Use `success` field to narrow the type.
 *
 * @example
 * const response: ApiResponse<User> = await fetch('/api/user');
 * if (response.success) {
 *   // TypeScript knows response.data is User
 *   console.log(response.data.name);
 * } else {
 *   // TypeScript knows response.error exists
 *   console.error(response.error.message);
 * }
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;
