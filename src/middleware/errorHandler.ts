import { Context } from "hono";
import type { ApiErrorResponse, ApiSuccessResponse } from "../types/response";
import { getRequestId } from "../utils/response";
import { structuredLog } from "../utils/structured-logger";

type StatusCode = number;

export class ApiError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: StatusCode = 500,
    public details?: any
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Re-export canonical types for backward compatibility
// NOTE: ErrorResponse and SuccessResponse are now deprecated.
// Use ApiErrorResponse and ApiSuccessResponse from ../types/response instead.
export type { ApiErrorResponse as ErrorResponse } from "../types/response";
export type { ApiSuccessResponse as SuccessResponse } from "../types/response";

/**
 * Global error handler
 *
 * Uses canonical ApiErrorResponse from types/response.ts.
 * Consistent meta structure with request_id for tracing.
 */
export function errorHandler(error: Error, c: Context): Response {
  structuredLog('ERROR', 'Unhandled error', { service: 'error-handler', error: error instanceof Error ? error.message : String(error) });

  const requestId = getRequestId(c);

  // Handle known API errors
  if (error instanceof ApiError) {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      },
      meta: {
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, error.statusCode as any);
  }

  // Handle validation errors from Zod
  if (error.name === "ZodError") {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: (error as any).errors
      },
      meta: {
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, 400 as any);
  }

  // Handle database errors
  if (error.message?.includes("D1_") || error.message?.includes("SQLITE")) {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: "DATABASE_ERROR",
        message: "Database operation failed"
      },
      meta: {
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, 500 as any);
  }

  // Default error response
  const response: ApiErrorResponse = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    },
    meta: {
      timestamp: new Date().toISOString(),
      request_id: requestId
    }
  };

  return c.json(response, 500 as any);
}

/**
 * Helper to create success responses
 * @deprecated Use success() from utils/response.ts which includes request_id
 */
export function successResponse<T>(data: T, meta?: any): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      request_id: '', // Caller should provide via context
      ...meta
    }
  };
}

/**
 * Helper to create error responses
 */
export function errorResponse(
  code: string,
  message: string,
  statusCode: StatusCode = 500,
  details?: any
): Response {
  throw new ApiError(code, message, statusCode, details);
}