import { fromHono } from "chanfana";
import { Hono } from "hono";

// Middleware
import { corsMiddleware } from "./middleware/cors";
import { auth, requireOrg } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";

// V1 Endpoints
import { HealthEndpoint } from "./endpoints/v1/health";
import {
  GetUserProfile,
  UpdateUserProfile,
  GetUserOrganizations
} from "./endpoints/v1/user";
import {
  GetFacebookCampaigns,
  GetFacebookCampaign,
  GetFacebookAds,
  GetFacebookMetrics
} from "./endpoints/v1/platform/fb";
import {
  GetConversions,
  GetAnalyticsStats,
  GetConversionFunnel
} from "./endpoints/v1/analytics/conversions";
import { GetEventSchema } from "./endpoints/v1/analytics/schema";

// Import types
import { Session } from "./middleware/auth";

// Define Variables type
type Variables = {
  session: Session;
};

// Start a Hono app with proper types
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global error handler
app.onError(errorHandler);

// Apply CORS to all routes
app.use("*", corsMiddleware);

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
  schema: {
    info: {
      title: "ClearLift API",
      version: "1.0.0",
      description: "Production API for ClearLift analytics platform",
    },
    servers: [
      {
        url: "https://api.clearlift.ai",
        description: "Production"
      },
      {
        url: "http://localhost:8787",
        description: "Development"
      }
    ],
    security: [
      {
        bearerAuth: []
      }
    ]
  }
});

// Create V1 router
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();

// Health check (no auth)
openapi.get("/v1/health", HealthEndpoint);

// User endpoints (session auth only)
openapi.get("/v1/user/me", auth, GetUserProfile);
openapi.patch("/v1/user/me", auth, UpdateUserProfile);
openapi.get("/v1/user/organizations", auth, GetUserOrganizations);

// Platform endpoints (session + org auth)
openapi.get("/v1/platform/fb/campaigns", auth, requireOrg, GetFacebookCampaigns);
openapi.get("/v1/platform/fb/campaigns/:campaignId", auth, requireOrg, GetFacebookCampaign);
openapi.get("/v1/platform/fb/ads", auth, requireOrg, GetFacebookAds);
openapi.get("/v1/platform/fb/metrics", auth, requireOrg, GetFacebookMetrics);

// Analytics endpoints (session + org auth)
openapi.get("/v1/analytics/conversions", auth, requireOrg, GetConversions);
openapi.get("/v1/analytics/stats", auth, requireOrg, GetAnalyticsStats);
openapi.get("/v1/analytics/funnel", auth, requireOrg, GetConversionFunnel);
openapi.get("/v1/analytics/schema", GetEventSchema);

// Export the Hono app
export default app;