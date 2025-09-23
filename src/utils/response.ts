import { Context } from "hono";

type StatusCode = number;

/**
 * Standard API response utilities
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    timestamp: string;
    count?: number;
    page?: number;
    total?: number;
    [key: string]: any;
  };
}

/**
 * Send success response
 */
export function success<T>(
  c: Context,
  data: T,
  meta?: Record<string, any>,
  statusCode: StatusCode = 200
) {
  return c.json<ApiResponse<T>>(
    {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta
      }
    },
    statusCode
  );
}

/**
 * Send error response
 */
export function error(
  c: Context,
  code: string,
  message: string,
  statusCode: StatusCode = 500,
  details?: any
) {
  return c.json<ApiResponse>(
    {
      success: false,
      error: {
        code,
        message,
        details
      },
      meta: {
        timestamp: new Date().toISOString()
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