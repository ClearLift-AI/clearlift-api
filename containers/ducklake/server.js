import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import duckdb from 'duckdb';

const app = new Hono();
let db = null;
let conn = null;

// Initialize DuckDB connection
async function initializeDuckDB() {
  return new Promise((resolve, reject) => {
    db = new duckdb.Database(':memory:', (err) => {
      if (err) {
        console.error('Failed to create DuckDB database:', err);
        reject(err);
        return;
      }
      
      conn = db.connect();
      
      // Install and load Iceberg extension
      conn.exec('INSTALL iceberg;', (err) => {
        if (err) {
          console.error('Failed to install iceberg extension:', err);
          reject(err);
          return;
        }
        
        conn.exec('LOAD iceberg;', (err) => {
          if (err) {
            console.error('Failed to load iceberg extension:', err);
            reject(err);
            return;
          }
          
          console.log('DuckDB initialized with Iceberg extension');
          resolve();
        });
      });
    });
  });
}

// Configure R2 Data Catalog connection
async function configureR2Catalog() {
  const readToken = process.env.R2_READ_ONLY_TOKEN;
  const writeToken = process.env.R2_WRITE_TOKEN;
  const catalogUri = process.env.DATALAKE_CATALOG_URI;
  const warehouseName = process.env.DATALAKE_WAREHOUSE_NAME;
  
  if (!catalogUri || !warehouseName) {
    throw new Error('Missing R2 Data Catalog configuration');
  }
  
  // Use write token if available, fallback to read token
  const token = writeToken || readToken;
  
  if (!token) {
    throw new Error('No R2 token available (neither write nor read-only)');
  }
  
  return new Promise((resolve, reject) => {
    // Create secret for R2 authentication
    const secretType = writeToken ? 'r2_write_secret' : 'r2_read_secret';
    const createSecretQuery = `
      CREATE SECRET ${secretType} (
        TYPE ICEBERG,
        TOKEN '${token}'
      );
    `;
    
    conn.exec(createSecretQuery, (err) => {
      if (err && !err.message.includes('already exists')) {
        console.error('Failed to create R2 secret:', err);
        reject(err);
        return;
      }
      
      // Attach R2 Data Catalog
      const attachCatalogQuery = `
        ATTACH '${warehouseName}' AS r2_catalog (
          TYPE ICEBERG,
          ENDPOINT '${catalogUri}'
        );
      `;
      
      conn.exec(attachCatalogQuery, (err) => {
        if (err && !err.message.includes('already attached')) {
          console.error('Failed to attach R2 catalog:', err);
          reject(err);
          return;
        }
        
        const accessMode = writeToken ? 'read-write' : 'read-only';
        console.log(`R2 Data Catalog configured successfully (${accessMode} mode)`);
        resolve();
      });
    });
  });
}

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    service: 'ducklake',
    duckdb: db ? 'connected' : 'disconnected'
  });
});

// Query endpoint
app.post('/query', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const expectedToken = process.env.API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const { query } = await c.req.json();
    
    if (!query) {
      return c.json({ error: 'Query is required' }, 400);
    }
    
    // Execute query
    return new Promise((resolve) => {
      conn.all(query, (err, result) => {
        if (err) {
          console.error('Query error:', err);
          resolve(c.json({ error: err.message }, 500));
        } else {
          resolve(c.json({ data: result }));
        }
      });
    });
  } catch (error) {
    console.error('Request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Streaming query endpoint for large results
app.post('/streaming-query', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const expectedToken = process.env.API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const { query } = await c.req.json();
    
    if (!query) {
      return c.json({ error: 'Query is required' }, 400);
    }
    
    // For now, return same as regular query
    // In production, this would stream results in Apache Arrow format
    return new Promise((resolve) => {
      conn.all(query, (err, result) => {
        if (err) {
          console.error('Query error:', err);
          resolve(c.json({ error: err.message }, 500));
        } else {
          resolve(c.json({ data: result }));
        }
      });
    });
  } catch (error) {
    console.error('Request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Conversion events query endpoint
app.post('/events/conversions', async (c) => {
  try {
    const { organization_id, start_date, end_date, group_by = 'day' } = await c.req.json();
    
    if (!organization_id) {
      return c.json({ error: 'organization_id is required' }, 400);
    }
    
    // Build query for conversion events
    const query = `
      SELECT 
        DATE_TRUNC('${group_by}', timestamp) as period,
        event_type,
        COUNT(*) as event_count,
        SUM(event_value) as total_value,
        AVG(event_value) as avg_value,
        COUNT(DISTINCT user_id) as unique_users
      FROM r2_catalog.default.conversion_events
      WHERE organization_id = '${organization_id}'
        ${start_date ? `AND timestamp >= '${start_date}'` : ''}
        ${end_date ? `AND timestamp <= '${end_date}'` : ''}
      GROUP BY period, event_type
      ORDER BY period DESC
    `;
    
    return new Promise((resolve) => {
      conn.all(query, (err, result) => {
        if (err) {
          // If table doesn't exist yet, return empty result
          if (err.message.includes('does not exist')) {
            resolve(c.json({ data: [] }));
          } else {
            console.error('Query error:', err);
            resolve(c.json({ error: err.message }, 500));
          }
        } else {
          resolve(c.json({ data: result }));
        }
      });
    });
  } catch (error) {
    console.error('Request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Table management endpoints
app.post('/tables/create', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const expectedToken = process.env.API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const { table_name, schema, namespace = 'default' } = await c.req.json();
    
    if (!table_name || !schema) {
      return c.json({ error: 'table_name and schema are required' }, 400);
    }
    
    // Build CREATE TABLE query
    const columns = Object.entries(schema).map(([name, type]) => {
      return `${name} ${type}`;
    }).join(', ');
    
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS r2_catalog.${namespace}.${table_name} (
        ${columns}
      )
    `;
    
    return new Promise((resolve) => {
      conn.exec(createTableQuery, (err) => {
        if (err) {
          console.error('Create table error:', err);
          resolve(c.json({ error: err.message }, 500));
        } else {
          resolve(c.json({ 
            success: true,
            message: `Table ${namespace}.${table_name} created successfully`,
            table: `r2_catalog.${namespace}.${table_name}`
          }));
        }
      });
    });
  } catch (error) {
    console.error('Create table request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// List tables endpoint
app.get('/tables/list', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const expectedToken = process.env.API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const listTablesQuery = `
      SELECT table_catalog, table_schema, table_name
      FROM information_schema.tables
      WHERE table_catalog = 'r2_catalog'
      ORDER BY table_schema, table_name
    `;
    
    return new Promise((resolve) => {
      conn.all(listTablesQuery, (err, result) => {
        if (err) {
          // If catalog not attached, return empty list
          if (err.message.includes('r2_catalog')) {
            resolve(c.json({ tables: [] }));
          } else {
            console.error('List tables error:', err);
            resolve(c.json({ error: err.message }, 500));
          }
        } else {
          resolve(c.json({ tables: result || [] }));
        }
      });
    });
  } catch (error) {
    console.error('List tables request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Table schema endpoint
app.get('/tables/:namespace/:table/schema', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const expectedToken = process.env.API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const { namespace, table } = c.req.param();
    
    const schemaQuery = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_catalog = 'r2_catalog'
        AND table_schema = '${namespace}'
        AND table_name = '${table}'
      ORDER BY ordinal_position
    `;
    
    return new Promise((resolve) => {
      conn.all(schemaQuery, (err, result) => {
        if (err) {
          console.error('Schema query error:', err);
          resolve(c.json({ error: err.message }, 500));
        } else {
          resolve(c.json({ 
            table: `${namespace}.${table}`,
            schema: result || []
          }));
        }
      });
    });
  } catch (error) {
    console.error('Schema request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Initialize server
async function startServer() {
  try {
    await initializeDuckDB();
    
    // Try to configure R2 catalog if credentials are available
    try {
      await configureR2Catalog();
    } catch (error) {
      console.warn('R2 Data Catalog not configured:', error.message);
      console.log('Running without R2 connection - queries will be limited');
    }
    
    const port = process.env.PORT || 8080;
    
    serve({
      fetch: app.fetch,
      port: port
    });
    
    console.log(`DuckLake server running on port ${port}`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();