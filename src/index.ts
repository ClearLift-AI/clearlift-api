import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
// User endpoints
import { GetUserProfile, UpdateUserProfile } from "./endpoints/user/profile";

// Organization endpoints
import { ListOrganizations } from "./endpoints/organizations/list";
import { CreateOrganization } from "./endpoints/organizations/create";
import { SwitchOrganization } from "./endpoints/organizations/switch";

// Campaign endpoints
import { ListCampaigns } from "./endpoints/campaigns/list";

// Platform endpoints
import { ListPlatforms } from "./endpoints/platforms/list";
import { SyncPlatform } from "./endpoints/platforms/sync";
import { GetSyncHistory } from "./endpoints/platforms/syncHistory";
import { ConnectGoogleAds, HandleOAuthCallback } from "./endpoints/platforms/connect";

// Event endpoints
import { EventQuery } from "./endpoints/events/eventQuery";
import { GetConversions } from "./endpoints/events/conversions";
import { GetEventInsights } from "./endpoints/events/insights";
import { SyncEvents } from "./endpoints/events/sync";
import { BulkUploadEvents } from "./endpoints/events/bulkUpload";

// Datalake endpoints
import { CreateTable, ListTables, GetTableSchema, DropTable } from "./endpoints/datalake/tables";
import { WriteData, BatchWriteData, QueryData } from "./endpoints/datalake/data";
import { InitializeDatalake, GetStandardSchemas } from "./endpoints/datalake/init";
import { SyncCampaignsToDatalake, SyncEventsToDatalake, GetSyncStatus } from "./endpoints/datalake/sync";
import { HealthCheck } from "./endpoints/health";
import { DebugDatabases, DebugMigrations, DebugTestWrite } from "./endpoints/debug";
import { authMiddleware, requireOrgMiddleware } from "./middleware/auth";
import { ContentfulStatusCode } from "hono/utils/http-status";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ApiException) {
    // If it's a Chanfana ApiException, let Chanfana handle the response
    return c.json(
      { success: false, errors: err.buildResponse() },
      err.status as ContentfulStatusCode,
    );
  }

  console.error("Global error handler caught:", err); // Log the error if it's not known

  // For other errors, return a generic 500 response
  return c.json(
    {
      success: false,
      errors: [{ code: 7000, message: "Internal Server Error" }],
    },
    500,
  );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
  schema: {
    info: {
      title: "ClearLift API",
      version: "1.0.0",
      description: "Production API for ClearLift advertising analytics platform",
    },
  },
});

// Public endpoints (no auth required)
openapi.get("/health", HealthCheck);

// Debug endpoints (require debug token)
openapi.get("/debug/databases", DebugDatabases);
openapi.get("/debug/migrations", DebugMigrations);
openapi.post("/debug/test-write", DebugTestWrite);

// Apply authentication middleware to all API routes
app.use('/api/*', authMiddleware);

// Apply organization context middleware
app.use('/api/campaigns/*', requireOrgMiddleware);
app.use('/api/platforms/*', requireOrgMiddleware);
app.use('/api/events/*', requireOrgMiddleware);
app.use('/api/datalake/*', requireOrgMiddleware);

// User endpoints
openapi.get("/api/user/profile", GetUserProfile);
openapi.put("/api/user/profile", UpdateUserProfile);
openapi.patch("/api/user/profile", UpdateUserProfile); // Support PATCH method

// Organization endpoints
openapi.get("/api/organizations", ListOrganizations);
openapi.post("/api/organizations", CreateOrganization);
openapi.post("/api/organizations/create", CreateOrganization); // Alternative path for client compatibility
openapi.post("/api/organizations/switch", SwitchOrganization);

// Campaign endpoints
openapi.get("/api/campaigns", ListCampaigns);

// Platform endpoints
openapi.get("/api/platforms", ListPlatforms);
openapi.get("/api/platforms/list", ListPlatforms); // Alternative path for client compatibility
openapi.post("/api/platforms/sync", SyncPlatform);
openapi.get("/api/platforms/sync-history", GetSyncHistory);
openapi.post("/api/platforms/connect/google-ads", ConnectGoogleAds);
openapi.get("/api/platforms/connect/callback", HandleOAuthCallback);

// Event endpoints
openapi.post("/api/events/query", EventQuery);
openapi.get("/api/events/conversions", GetConversions);
openapi.get("/api/events/insights", GetEventInsights);
openapi.post("/api/events/sync", SyncEvents);
openapi.post("/api/events/bulk-upload", BulkUploadEvents);

// Datalake endpoints
openapi.post("/api/datalake/tables", CreateTable);
openapi.get("/api/datalake/tables", ListTables);
openapi.get("/api/datalake/tables/:namespace/:table/schema", GetTableSchema);
openapi.delete("/api/datalake/tables/:namespace/:table", DropTable);
openapi.post("/api/datalake/data/write", WriteData);
openapi.post("/api/datalake/data/batch-write", BatchWriteData);
openapi.post("/api/datalake/data/query", QueryData);
openapi.post("/api/datalake/initialize", InitializeDatalake);
openapi.get("/api/datalake/schemas", GetStandardSchemas);
openapi.post("/api/datalake/sync/campaigns", SyncCampaignsToDatalake);
openapi.post("/api/datalake/sync/events", SyncEventsToDatalake);
openapi.get("/api/datalake/sync/status", GetSyncStatus);

// Export the Hono app
export default app;

// Temporary stub class for migration - will be removed after deployment
export class DuckLakeContainer {
  constructor(state: any, env: any) {}
  
  async fetch(request: Request): Promise<Response> {
    return new Response('Deprecated - DuckLake container has been replaced with MotherDuck', { status: 410 });
  }
}
