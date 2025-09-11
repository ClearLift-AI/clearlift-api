import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { Container } from "@cloudflare/containers";
import { eventEndpoints } from "./endpoints/events/router";
import { organizationsEndpoints } from "./endpoints/organizations/router";
import { campaignsEndpoints } from "./endpoints/campaigns/router";
import { platformsEndpoints } from "./endpoints/platforms/router";
import { userEndpoints } from "./endpoints/user/router";
import { datalakeEndpoints } from "./endpoints/datalake/router";
import { HealthCheck } from "./endpoints/health";
import { DebugDatabases, DebugMigrations, DebugTestWrite } from "./endpoints/debug";
import { authMiddleware, requireOrgMiddleware } from "./middleware/auth";
import { ContentfulStatusCode } from "hono/utils/http-status";

// DuckLake Container Durable Object
export class DuckLakeContainer extends Container<Env> {
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    
    // Configure environment variables for the container
    let envConfig: Record<string, string> = {};
    
    // Add R2 tokens if available
    if (env.R2_READ_ONLY_TOKEN) {
      envConfig.R2_READ_ONLY_TOKEN = env.R2_READ_ONLY_TOKEN;
    }
    if (env.R2_WRITE_TOKEN) {
      envConfig.R2_WRITE_TOKEN = env.R2_WRITE_TOKEN;
    }
    
    // Add catalog configuration
    if (env.DATALAKE_CATALOG_URI) {
      envConfig.DATALAKE_CATALOG_URI = env.DATALAKE_CATALOG_URI;
    }
    if (env.DATALAKE_WAREHOUSE_NAME) {
      envConfig.DATALAKE_WAREHOUSE_NAME = env.DATALAKE_WAREHOUSE_NAME;
    }
    if (env.R2_S3_API_URL) {
      envConfig.R2_S3_API_URL = env.R2_S3_API_URL;
    }
    if (env.R2_BUCKET) {
      envConfig.R2_BUCKET = env.R2_BUCKET;
    }
    
    // Container configuration
    this.defaultPort = 8080;
    this.sleepAfter = "5m";
    this.envVars = envConfig;
  }
}

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

// Routes that require authentication but not necessarily an organization
// Register user endpoints
userEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/user${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Register organization endpoints
organizationsEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/organizations${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Routes that require both authentication and organization context
app.use('/api/campaigns/*', requireOrgMiddleware);
app.use('/api/platforms/*', requireOrgMiddleware);
app.use('/api/events/*', requireOrgMiddleware);
app.use('/api/datalake/*', requireOrgMiddleware);

// Register campaign endpoints
campaignsEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/campaigns${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Register platform endpoints
platformsEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/platforms${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Register event endpoints
eventEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/events${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Register datalake endpoints
datalakeEndpoints.forEach(EndpointClass => {
  const instance = new EndpointClass();
  const method = instance.schema.method.toLowerCase();
  const path = `/api/datalake${instance.schema.path}`;
  openapi[method](path, EndpointClass);
});

// Export the Hono app
export default app;
