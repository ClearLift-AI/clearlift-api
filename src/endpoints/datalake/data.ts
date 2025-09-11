import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { DatalakeManagementService } from "../../services/datalakeManagement";

export class WriteData extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/tables/:table/data",
  security: "session",
  summary: "Write data to a table",
  description: "Insert data into an Iceberg table in the R2 Data Catalog",
  request: {
    params: z.object({
      table: z.string().describe("Table name")
    }),
    body: z.object({
      data: z.array(z.record(z.any())).describe("Array of records to insert"),
      namespace: z.string().optional().default('default').describe("Table namespace")
    })
  },
  responses: {
    200: {
      description: "Data written successfully",
      body: z.object({
        success: z.boolean(),
        rowsInserted: z.number()
      })
    },
    400: {
      description: "Invalid request",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { table } = c.req.param();
  const { data, namespace } = await c.req.json();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!data || !Array.isArray(data)) {
    return c.json({ error: 'Data must be an array of records' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    
    // Add organization_id to all records if not present
    const dataWithOrgId = data.map(record => ({
      ...record,
      organization_id: record.organization_id || organizationId
    }));
    
    const result = await datalakeService.writeData(table, dataWithOrgId, namespace || 'default');
    
    return c.json(result);
  } catch (error) {
    console.error('Write data error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to write data'
    }, 500);
  }
  }
}

export class BatchWriteData extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/tables/:table/batch",
  security: "session",
  summary: "Batch write data to a table",
  description: "Insert large datasets in batches to an Iceberg table",
  request: {
    params: z.object({
      table: z.string().describe("Table name")
    }),
    body: z.object({
      data: z.array(z.record(z.any())).describe("Array of records to insert"),
      batch_size: z.number().optional().default(1000).describe("Number of records per batch"),
      namespace: z.string().optional().default('default').describe("Table namespace")
    })
  },
  responses: {
    200: {
      description: "Data written successfully",
      body: z.object({
        success: z.boolean(),
        totalRowsInserted: z.number(),
        batches: z.number()
      })
    },
    400: {
      description: "Invalid request",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { table } = c.req.param();
  const { data, batch_size, namespace } = await c.req.json();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!data || !Array.isArray(data)) {
    return c.json({ error: 'Data must be an array of records' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    
    // Add organization_id to all records if not present
    const dataWithOrgId = data.map(record => ({
      ...record,
      organization_id: record.organization_id || organizationId
    }));
    
    const result = await datalakeService.batchWrite(
      table, 
      dataWithOrgId, 
      batch_size || 1000,
      namespace || 'default'
    );
    
    return c.json(result);
  } catch (error) {
    console.error('Batch write error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to batch write data'
    }, 500);
  }
  }
}

export class QueryData extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/query",
  security: "session",
  summary: "Execute a custom query",
  description: "Run a custom DuckDB SQL query on the datalake",
  request: {
    body: z.object({
      query: z.string().describe("SQL query to execute")
    })
  },
  responses: {
    200: {
      description: "Query executed successfully",
      body: z.object({
        data: z.any(),
        rowCount: z.number().optional()
      })
    },
    400: {
      description: "Invalid query",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { query } = await c.req.json();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!query) {
    return c.json({ error: 'Query is required' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const data = await datalakeService.executeQuery(query);
    
    return c.json({
      data,
      rowCount: Array.isArray(data) ? data.length : undefined
    });
  } catch (error) {
    console.error('Query execution error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Query execution failed'
    }, 500);
  }
  }
}