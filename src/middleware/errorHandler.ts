import { Context } from "hono";

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

/**
 * Standard error response format
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    request_id?: string;
  };
}

/**
 * Standard success response format
 */
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  meta?: {
    timestamp: string;
    count?: number;
    page?: number;
    total?: number;
    request_id?: string;
  };
}

/**
 * Global error handler
 */
export function errorHandler(error: Error, c: Context): Response {
  console.error("Error:", error);

  const requestId = c.req.header("X-Request-Id") || crypto.randomUUID();

  // Handle known API errors
  if (error instanceof ApiError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, error.statusCode);
  }

  // Handle validation errors from Zod
  if (error.name === "ZodError") {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: (error as any).errors,
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, 400);
  }

  // Handle database errors
  if (error.message?.includes("D1_") || error.message?.includes("SQLITE")) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: "DATABASE_ERROR",
        message: "Database operation failed",
        timestamp: new Date().toISOString(),
        request_id: requestId
      }
    };

    return c.json(response, 500);
  }

  // Default error response
  const response: ErrorResponse = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
      timestamp: new Date().toISOString(),
      request_id: requestId
    }
  };

  return c.json(response, 500);
}

/**
 * Helper to create success responses
 */
export function successResponse<T>(data: T, meta?: any): SuccessResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
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