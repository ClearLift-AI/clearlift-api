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

// Helper function to register endpoints  
function registerEndpoints(endpoints: any[], basePath: string) {
  if (!endpoints || !Array.isArray(endpoints)) return;
  
  endpoints.forEach(EndpointClass => {
    if (!EndpointClass) return;
    
    try {
      // Create a temporary instance to get the schema
      const tempInstance = new EndpointClass({} as any);
      const schema = tempInstance.schema;
      
      if (!schema || !schema.method || !schema.path) return;
      
      const method = schema.method.toLowerCase();
      const path = `${basePath}${schema.path}`;
      
      // Register the endpoint class (not the instance)
      switch(method) {
        case 'get':
          openapi.get(path, EndpointClass);
          break;
        case 'post':
          openapi.post(path, EndpointClass);
          break;
        case 'put':
          openapi.put(path, EndpointClass);
          break;
        case 'delete':
          openapi.delete(path, EndpointClass);
          break;
        case 'patch':
          openapi.patch(path, EndpointClass);
          break;
      }
    } catch (err) {
      // Silently skip registration errors in production
    }
  });
}

// Routes that require authentication but not necessarily an organization
registerEndpoints(userEndpoints, '/api/user');
registerEndpoints(organizationsEndpoints, '/api/organizations');

// Routes that require both authentication and organization context
app.use('/api/campaigns/*', requireOrgMiddleware);
app.use('/api/platforms/*', requireOrgMiddleware);
app.use('/api/events/*', requireOrgMiddleware);
app.use('/api/datalake/*', requireOrgMiddleware);

// Register endpoints that require organization context
registerEndpoints(campaignsEndpoints, '/api/campaigns');
registerEndpoints(platformsEndpoints, '/api/platforms');
registerEndpoints(eventEndpoints, '/api/events');
registerEndpoints(datalakeEndpoints, '/api/datalake');

// Export the Hono app
export default app;
