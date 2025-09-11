import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { DatalakeManagementService, STANDARD_SCHEMAS } from "../../services/datalakeManagement";

export const InitializeDatalake = new OpenAPIRoute({
  method: "POST",
  path: "/init",
  security: "session",
  summary: "Initialize standard datalake tables",
  description: "Create all standard Iceberg tables for the platform",
  responses: {
    200: {
      description: "Initialization completed",
      body: z.object({
        success: z.boolean(),
        created: z.array(z.string()),
        existing: z.array(z.string()),
        failed: z.array(z.object({
          table: z.string(),
          error: z.string()
        }))
      })
    }
  }
}).handle(async (c: AppContext) => {
  const organizationId = c.get('organizationId');
  const user = c.get('user');
  const organization = c.get('organization');
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  // Check if user has admin role
  if (organization?.role !== 'admin' && organization?.role !== 'owner') {
    return c.json({ 
      error: 'Only admins can initialize datalake tables'
    }, 403);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const result = await datalakeService.initializeStandardTables();
    
    return c.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Initialize datalake error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to initialize datalake'
    }, 500);
  }
});

export const GetStandardSchemas = new OpenAPIRoute({
  method: "GET",
  path: "/schemas",
  summary: "Get standard table schemas",
  description: "Retrieve the predefined schemas for standard platform tables",
  responses: {
    200: {
      description: "Schemas retrieved successfully",
      body: z.object({
        schemas: z.record(z.record(z.string()))
      })
    }
  }
}).handle(async (c: AppContext) => {
  return c.json({
    schemas: STANDARD_SCHEMAS
  });
});