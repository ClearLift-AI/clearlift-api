import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { DatalakeManagementService, STANDARD_SCHEMAS } from "../../services/datalakeManagement";

export class CreateTable extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/tables",
  security: "session",
  summary: "Create a new table in the datalake",
  description: "Create a new Iceberg table in the R2 Data Catalog",
  request: {
    body: z.object({
      table_name: z.string().describe("Name of the table to create"),
      schema: z.record(z.string()).describe("Table schema as column_name: data_type pairs"),
      namespace: z.string().optional().default('default').describe("Namespace for the table")
    })
  },
  responses: {
    200: {
      description: "Table created successfully",
      body: z.object({
        success: z.boolean(),
        message: z.string(),
        table: z.string().optional()
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
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  const { table_name, schema, namespace } = await c.req.json();

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const result = await datalakeService.createTable(table_name, schema, namespace);
    
    return c.json(result);
  } catch (error) {
    console.error('Create table error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create table'
    }, 500);
  }
  }
}

export class ListTables extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/tables",
  security: "session",
  summary: "List all tables in the datalake",
  description: "Get a list of all Iceberg tables in the R2 Data Catalog",
  responses: {
    200: {
      description: "Tables retrieved successfully",
      body: z.object({
        tables: z.array(z.object({
          catalog: z.string(),
          schema: z.string(),
          name: z.string()
        }))
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ tables: [] });
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const tables = await datalakeService.listTables();
    
    return c.json({ tables });
  } catch (error) {
    console.error('List tables error:', error);
    return c.json({ tables: [] });
  }
  }
}

export class GetTableSchema extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/tables/:table/schema",
  security: "session",
  summary: "Get table schema",
  description: "Retrieve the schema of a specific table",
  request: {
    params: z.object({
      table: z.string().describe("Table name")
    }),
    query: z.object({
      namespace: z.string().optional().default('default').describe("Table namespace")
    })
  },
  responses: {
    200: {
      description: "Schema retrieved successfully",
      body: z.object({
        table: z.string(),
        schema: z.array(z.object({
          column_name: z.string(),
          data_type: z.string(),
          is_nullable: z.string()
        }))
      })
    },
    404: {
      description: "Table not found",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { table } = c.req.param();
  const { namespace } = c.req.query();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const schema = await datalakeService.getTableSchema(table, namespace || 'default');
    
    if (!schema || schema.length === 0) {
      return c.json({ 
        error: `Table ${namespace || 'default'}.${table} not found`
      }, 404);
    }
    
    return c.json({ 
      table: `${namespace || 'default'}.${table}`,
      schema 
    });
  } catch (error) {
    console.error('Get schema error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to get table schema'
    }, 500);
  }
  }
}

export class DropTable extends OpenAPIRoute {
  schema = {
  method: "DELETE",
  path: "/tables/:table",
  security: "session",
  summary: "Drop a table from the datalake",
  description: "Delete an Iceberg table from the R2 Data Catalog (requires confirmation)",
  request: {
    params: z.object({
      table: z.string().describe("Table name")
    }),
    body: z.object({
      namespace: z.string().optional().default('default').describe("Table namespace"),
      confirm: z.boolean().describe("Confirmation flag to drop the table")
    })
  },
  responses: {
    200: {
      description: "Table dropped successfully",
      body: z.object({
        success: z.boolean(),
        message: z.string()
      })
    },
    400: {
      description: "Invalid request or confirmation required",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { table } = c.req.param();
  const { namespace, confirm } = await c.req.json();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!confirm) {
    return c.json({ 
      error: 'Table drop requires confirmation. Set confirm: true in request body'
    }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const result = await datalakeService.dropTable(table, namespace || 'default', confirm);
    
    return c.json(result);
  } catch (error) {
    console.error('Drop table error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to drop table'
    }, 500);
  }
  }
}