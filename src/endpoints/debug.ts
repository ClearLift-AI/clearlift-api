import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../types";

export class DebugDatabases extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/debug/databases",
  summary: "Debug database connections",
  description: "Test all database connections and show table information (requires debug token)",
  request: {
    headers: z.object({
      'x-debug-token': z.string().describe("Debug access token")
    })
  },
  responses: {
    200: {
      description: "Database debug information",
      ...contentJson(z.object({
        main_db: z.object({
          connected: z.boolean(),
          tables: z.array(z.object({
            name: z.string(),
            row_count: z.number()
          })),
          error: z.string().optional()
        }),
        ad_data: z.object({
          connected: z.boolean(),
          tables: z.array(z.object({
            name: z.string(),
            row_count: z.number()
          })),
          error: z.string().optional()
        }),
        datalake: z.object({
          available: z.boolean(),
          tables: z.array(z.string()),
          error: z.string().optional()
        })
      }))
    },
    401: {
      description: "Invalid debug token",
      ...contentJson(z.object({
        error: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  // Check debug token
  const debugToken = c.req.header('x-debug-token');
  const expectedToken = c.env.DEBUG_TOKEN || 'debug-2024'; // Should be set in environment
  
  if (debugToken !== expectedToken) {
    return c.json({ error: 'Invalid debug token' }, 401);
  }

  const result = {
    main_db: {
      connected: false,
      tables: [] as { name: string; row_count: number }[],
      error: undefined as string | undefined
    },
    ad_data: {
      connected: false,
      tables: [] as { name: string; row_count: number }[],
      error: undefined as string | undefined
    },
    datalake: {
      available: false,
      tables: [] as string[],
      error: undefined as string | undefined
    }
  };

  // Test main DB
  if (c.env.DB) {
    try {
      // Get all tables
      const tablesResult = await c.env.DB.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        ORDER BY name
      `).all();

      result.main_db.connected = true;

      // Get row counts for each table
      for (const table of tablesResult.results || []) {
        try {
          const countResult = await c.env.DB.prepare(
            `SELECT COUNT(*) as count FROM ${table.name}`
          ).first();
          result.main_db.tables.push({
            name: table.name as string,
            row_count: (countResult?.count as number) || 0
          });
        } catch (e) {
          result.main_db.tables.push({
            name: table.name as string,
            row_count: -1
          });
        }
      }
    } catch (error) {
      result.main_db.connected = false;
      result.main_db.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.main_db.error = 'DB binding not found';
  }

  // Test AD_DATA
  if (c.env.AD_DATA) {
    try {
      // Get all tables
      const tablesResult = await c.env.AD_DATA.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        ORDER BY name
      `).all();

      result.ad_data.connected = true;

      // Get row counts for each table
      for (const table of tablesResult.results || []) {
        try {
          const countResult = await c.env.AD_DATA.prepare(
            `SELECT COUNT(*) as count FROM ${table.name}`
          ).first();
          result.ad_data.tables.push({
            name: table.name as string,
            row_count: (countResult?.count as number) || 0
          });
        } catch (e) {
          result.ad_data.tables.push({
            name: table.name as string,
            row_count: -1
          });
        }
      }
    } catch (error) {
      result.ad_data.connected = false;
      result.ad_data.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.ad_data.error = 'AD_DATA binding not found';
  }

  // Test Datalake (if available)
  if (c.env.DUCKLAKE) {
    try {
      result.datalake.available = true;
      // For now, just indicate it's available
      // In production, you could query for tables
      result.datalake.tables = [];
    } catch (error) {
      result.datalake.available = false;
      result.datalake.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.datalake.error = 'DUCKLAKE binding not found';
  }

  return c.json(result);
  }
}

export class DebugMigrations extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/debug/migrations",
  summary: "Debug migration status",
  description: "Check which migrations have been applied to each database",
  request: {
    headers: z.object({
      'x-debug-token': z.string().describe("Debug access token")
    })
  },
  responses: {
    200: {
      description: "Migration status information",
      ...contentJson(z.object({
        main_db: z.object({
          has_migrations_table: z.boolean(),
          applied_migrations: z.array(z.string()),
          error: z.string().optional()
        }),
        ad_data: z.object({
          has_migrations_table: z.boolean(),
          applied_migrations: z.array(z.string()),
          error: z.string().optional()
        })
      }))
    },
    401: {
      description: "Invalid debug token",
      ...contentJson(z.object({
        error: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  // Check debug token
  const debugToken = c.req.header('x-debug-token');
  const expectedToken = c.env.DEBUG_TOKEN || 'debug-2024';
  
  if (debugToken !== expectedToken) {
    return c.json({ error: 'Invalid debug token' }, 401);
  }

  const result = {
    main_db: {
      has_migrations_table: false,
      applied_migrations: [] as string[],
      error: undefined as string | undefined
    },
    ad_data: {
      has_migrations_table: false,
      applied_migrations: [] as string[],
      error: undefined as string | undefined
    }
  };

  // Check main DB migrations
  if (c.env.DB) {
    try {
      // Check if d1_migrations table exists
      const migTableResult = await c.env.DB.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='d1_migrations'
      `).first();

      if (migTableResult) {
        result.main_db.has_migrations_table = true;
        
        // Get applied migrations
        const migrationsResult = await c.env.DB.prepare(`
          SELECT name FROM d1_migrations 
          ORDER BY id
        `).all();
        
        result.main_db.applied_migrations = migrationsResult.results?.map(
          m => m.name as string
        ) || [];
      }
    } catch (error) {
      result.main_db.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.main_db.error = 'DB binding not found';
  }

  // Check AD_DATA migrations
  if (c.env.AD_DATA) {
    try {
      // Check if d1_migrations table exists
      const migTableResult = await c.env.AD_DATA.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='d1_migrations'
      `).first();

      if (migTableResult) {
        result.ad_data.has_migrations_table = true;
        
        // Get applied migrations
        const migrationsResult = await c.env.AD_DATA.prepare(`
          SELECT name FROM d1_migrations 
          ORDER BY id
        `).all();
        
        result.ad_data.applied_migrations = migrationsResult.results?.map(
          m => m.name as string
        ) || [];
      }
    } catch (error) {
      result.ad_data.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.ad_data.error = 'AD_DATA binding not found';
  }

  return c.json(result);
  }
}

export class DebugTestWrite extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/debug/test-write",
  summary: "Test database write permissions",
  description: "Test write operations on both databases (creates and deletes test records)",
  request: {
    headers: z.object({
      'x-debug-token': z.string().describe("Debug access token")
    })
  },
  responses: {
    200: {
      description: "Write test results",
      ...contentJson(z.object({
        main_db: z.object({
          can_write: z.boolean(),
          test_id: z.string().optional(),
          error: z.string().optional()
        }),
        ad_data: z.object({
          can_write: z.boolean(),
          test_id: z.string().optional(),
          error: z.string().optional()
        })
      }))
    },
    401: {
      description: "Invalid debug token",
      ...contentJson(z.object({
        error: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  // Check debug token
  const debugToken = c.req.header('x-debug-token');
  const expectedToken = c.env.DEBUG_TOKEN || 'debug-2024';
  
  if (debugToken !== expectedToken) {
    return c.json({ error: 'Invalid debug token' }, 401);
  }

  const result = {
    main_db: {
      can_write: false,
      test_id: undefined as string | undefined,
      error: undefined as string | undefined
    },
    ad_data: {
      can_write: false,
      test_id: undefined as string | undefined,
      error: undefined as string | undefined
    }
  };

  // Test main DB write
  if (c.env.DB) {
    const testId = `test-${Date.now()}`;
    try {
      // Try to insert a test user
      await c.env.DB.prepare(`
        INSERT INTO users (id, email, issuer, access_sub, created_at)
        VALUES (?, ?, 'test', 'test', datetime('now'))
      `).bind(testId, `${testId}@test.com`).run();

      // Delete the test user
      await c.env.DB.prepare(`
        DELETE FROM users WHERE id = ?
      `).bind(testId).run();

      result.main_db.can_write = true;
      result.main_db.test_id = testId;
    } catch (error) {
      result.main_db.can_write = false;
      result.main_db.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.main_db.error = 'DB binding not found';
  }

  // Test AD_DATA write
  if (c.env.AD_DATA) {
    const testId = `test-${Date.now()}`;
    try {
      // Try to insert a test campaign
      await c.env.AD_DATA.prepare(`
        INSERT INTO campaigns (id, organization_id, platform, campaign_id, campaign_name, date)
        VALUES (?, 'test-org', 'test', 'test-campaign', 'Test Campaign', date('now'))
      `).bind(testId).run();

      // Delete the test campaign
      await c.env.AD_DATA.prepare(`
        DELETE FROM campaigns WHERE id = ?
      `).bind(testId).run();

      result.ad_data.can_write = true;
      result.ad_data.test_id = testId;
    } catch (error) {
      result.ad_data.can_write = false;
      result.ad_data.error = error instanceof Error ? error.message : 'Unknown error';
    }
  } else {
    result.ad_data.error = 'AD_DATA binding not found';
  }

  return c.json(result);
  }
}