import { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Re-export canonical types for backward compatibility
export type {
  ApiResponse,
  ApiSuccessResponse,
  ApiErrorResponse,
  ResponseMeta
} from "../types/response";

import type { ApiResponse as ApiResponseType } from "../types/response";

type StatusCode = ContentfulStatusCode;

/**
 * Standard API response utilities
 *
 * Uses canonical types from src/types/response.ts
 * Includes request_id in meta for SOC 2 compliance.
 */

/**
 * Get request_id from context (set by audit middleware) or generate one.
 */
export function getRequestId(c: Context): string {
  // Try to get from context variable (set by audit middleware)
  const requestId = c.get('request_id') as string | undefined;
  if (requestId) return requestId;

  // Fall back to header or generate new
  return c.req.header("X-Request-Id") || crypto.randomUUID();
}

/**
 * Send success response with request_id in meta.
 */
export function success<T>(
  c: Context,
  data: T,
  meta?: Record<string, any>,
  statusCode: StatusCode = 200
) {
  return c.json<ApiResponseType<T>>(
    {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        request_id: getRequestId(c),
        ...meta
      }
    },
    statusCode
  );
}

/**
 * Send error response with request_id in meta.
 */
export function error(
  c: Context,
  code: string,
  message: string,
  statusCode: StatusCode = 500,
  details?: any
) {
  return c.json<ApiResponseType>(
    {
      success: false,
      error: {
        code,
        message,
        details
      },
      meta: {
        timestamp: new Date().toISOString(),
        request_id: getRequestId(c)
      }
    },
    statusCode
  );
}

/**
 * Send paginated response
 */
export function paginated<T>(
  c: Context,
  data: T[],
  page: number,
  limit: number,
  total: number
) {
  return success(c, data, {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1
  });
}

/**
 * Extract pagination params from query
 */
export function getPagination(c: Context): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(c.req.query("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20")));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Extract date range from query
 */
export function getDateRange(c: Context): { start_date: string; end_date: string } {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const start_date = c.req.query("start_date") || thirtyDaysAgo.toISOString().split("T")[0];
  const end_date = c.req.query("end_date") || today.toISOString().split("T")[0];

  return { start_date, end_date };
}