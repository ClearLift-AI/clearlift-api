import { Context, Next } from "hono";
import { cors as honoCors } from "hono/cors";

/**
 * CORS configuration for the API
 * Allows requests from adbliss.io (production), clearlift.ai (staging/local), and localhost for development
 */
export const corsMiddleware = honoCors({
  origin: (origin) => {
    // Allow specific origins
    const allowedOrigins = [
      // Production (adbliss.io)
      "https://app.adbliss.io",
      "https://adbliss.io",
      "https://www.adbliss.io",
      // Staging (clearlift.ai)
      "https://app.clearlift.ai",
      "https://dashboard.clearlift.ai",
      "https://clearlift.ai",
      "https://www.clearlift.ai",
      "https://app-dev.clearlift.ai",
      "https://dev.clearlift.ai",
      // Local dev
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:5173",
      "https://local.clearlift.ai",
      "https://app-local.clearlift.ai"
    ];

    // Allow if origin is in the list or if no origin (same-origin requests)
    return allowedOrigins.includes(origin) || !origin ? origin || "*" : null;
  },
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-Org-Id"
  ],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length", "X-Request-Id"],
  maxAge: 86400, // 24 hours
  credentials: true
});

/**
 * Simple CORS headers for OPTIONS preflight
 */
export async function handleOptions(c: Context) {
  return c.text("", 204 as any, {
    "Access-Control-Allow-Origin": c.req.header("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Org-Id",
    "Access-Control-Max-Age": "86400"
  });
}