import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { eventsRouter } from "./endpoints/events/router";
import { organizationsRouter } from "./endpoints/organizations/router";
import { campaignsRouter } from "./endpoints/campaigns/router";
import { platformsRouter } from "./endpoints/platforms/router";
import { userRouter } from "./endpoints/user/router";
import { datalakeRouter } from "./endpoints/datalake/router";
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

// Routes that require authentication but not necessarily an organization
openapi.route("/api/user", userRouter);
openapi.route("/api/organizations", organizationsRouter);

// Routes that require both authentication and organization context
app.use('/api/campaigns/*', requireOrgMiddleware);
app.use('/api/platforms/*', requireOrgMiddleware);
app.use('/api/events/*', requireOrgMiddleware);
app.use('/api/datalake/*', requireOrgMiddleware);

// Register routers
openapi.route("/api/campaigns", campaignsRouter);
openapi.route("/api/platforms", platformsRouter);
openapi.route("/api/events", eventsRouter);
openapi.route("/api/datalake", datalakeRouter);

// Export the Hono app
export default app;
