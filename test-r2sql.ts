/**
 * R2 SQL Test Script
 *
 * Tests different table name formats to find the correct one for the new R2 Data Catalog setup.
 *
 * Run with: npx tsx test-r2sql.ts
 */

// Configuration from environment
const ACCOUNT_ID = "133c285e1182ce57a619c802eaf56fb0";
const BUCKET_NAME = "clearlift-db";
const WAREHOUSE_NAME = "133c285e1182ce57a619c802eaf56fb0_clearlift-db";
const R2_SQL_TOKEN = process.env.R2_SQL_TOKEN || "pAvoSiTRZzXdeZrgZwrBlmXrRp_7c6j1-hLYL-8s";

// R2 SQL API endpoint
const R2_SQL_URL = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT_ID}/r2-sql/query/${BUCKET_NAME}`;

// Test different table name formats with correct table name: event_stream
const TABLE_NAME_FORMATS = [
  {
    name: "Simple table name (default namespace)",
    sql: "SELECT * FROM event_stream LIMIT 1"
  },
  {
    name: "Default.event_stream (explicit default namespace)",
    sql: "SELECT * FROM default.event_stream LIMIT 1"
  },
  {
    name: "Catalog URI based table name",
    sql: `SELECT * FROM clearlift_db.event_stream LIMIT 1`
  },
  {
    name: "Bucket.table format",
    sql: "SELECT * FROM \"clearlift-db\".event_stream LIMIT 1"
  },
  {
    name: "Warehouse.table format (quoted)",
    sql: `SELECT * FROM "${WAREHOUSE_NAME}".event_stream LIMIT 1`
  },
  {
    name: "List all tables in default namespace",
    sql: "SELECT * FROM default.__tables__ LIMIT 10"
  },
  {
    name: "List catalogs",
    sql: "SELECT * FROM __catalogs__ LIMIT 10"
  }
];

interface R2SQLResponse {
  result?: {
    rows: any[];
    schema?: Array<{
      name: string;
      type: string;
    }>;
    meta?: {
      rows_read?: number;
      rows_written?: number;
      bytes_read?: number;
    };
  };
  success?: boolean;
  errors?: Array<{
    message: string;
    code?: number;
  }>;
  messages?: string[];
}

async function executeQuery(sql: string): Promise<R2SQLResponse> {
  try {
    console.log(`\n🔍 Executing query: ${sql}`);

    const response = await fetch(R2_SQL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${R2_SQL_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: sql })
    });

    const data = await response.json() as R2SQLResponse;

    console.log(`Status: ${response.status} ${response.ok ? '✅' : '❌'}`);

    if (!response.ok) {
      console.error("❌ Query failed:");
      console.error("Response:", JSON.stringify(data, null, 2));
      return data;
    }

    if (data.errors && data.errors.length > 0) {
      console.error("❌ Query errors:");
      data.errors.forEach(err => {
        console.error(`  - ${err.message} (code: ${err.code})`);
      });
      return data;
    }

    console.log("✅ Query succeeded!");
    if (data.result) {
      console.log(`📊 Rows returned: ${data.result.rows?.length || 0}`);
      if (data.result.schema) {
        console.log(`📋 Schema: ${data.result.schema.map(s => `${s.name}:${s.type}`).join(', ')}`);
      }
      if (data.result.rows && data.result.rows.length > 0) {
        console.log(`📄 First row:`, JSON.stringify(data.result.rows[0], null, 2));
      }
      if (data.result.meta) {
        console.log(`📈 Meta: ${JSON.stringify(data.result.meta)}`);
      }
    }

    return data;
  } catch (error) {
    console.error("💥 Exception:", error instanceof Error ? error.message : error);
    return {
      success: false,
      errors: [{ message: error instanceof Error ? error.message : "Unknown error" }]
    };
  }
}

async function testAllFormats() {
  console.log("🚀 Starting R2 SQL Table Name Format Tests");
  console.log("==========================================");
  console.log(`Account ID: ${ACCOUNT_ID}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Warehouse: ${WAREHOUSE_NAME}`);
  console.log(`API URL: ${R2_SQL_URL}`);
  console.log("==========================================\n");

  let successfulFormat: string | null = null;

  for (const format of TABLE_NAME_FORMATS) {
    console.log(`\n📝 Testing: ${format.name}`);
    console.log("─".repeat(50));

    const result = await executeQuery(format.sql);

    if (result.success && result.result?.rows && result.result.rows.length > 0) {
      console.log(`\n🎉 SUCCESS! This format works: ${format.name}`);
      console.log(`   SQL: ${format.sql}`);
      successfulFormat = format.sql;
      break; // Found the working format
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("\n==========================================");
  console.log("📊 Test Results Summary");
  console.log("==========================================");

  if (successfulFormat) {
    console.log(`\n✅ Found working table format!`);
    console.log(`   Use this SQL pattern: ${successfulFormat}`);
    console.log(`\n💡 Update src/adapters/platforms/r2sql.ts:`);
    console.log(`   Change the buildQuery() method to use the correct table name.`);
  } else {
    console.log(`\n❌ No working format found.`);
    console.log(`\n🔍 Troubleshooting steps:`);
    console.log(`   1. Verify R2 Data Catalog is properly configured`);
    console.log(`   2. Check that events table exists in the catalog`);
    console.log(`   3. Verify R2_SQL_TOKEN has correct permissions`);
    console.log(`   4. Check bucket name is correct: ${BUCKET_NAME}`);
    console.log(`   5. Try running queries directly in Cloudflare dashboard`);
  }
}

// Simple test to check if we can connect to the API
async function testConnection() {
  console.log("\n🔌 Testing R2 SQL API Connection");
  console.log("─".repeat(50));

  const simpleQuery = "SELECT 1 as test";
  const result = await executeQuery(simpleQuery);

  if (result.success) {
    console.log("✅ R2 SQL API is reachable and authentication works!");
    return true;
  } else {
    console.log("❌ Cannot connect to R2 SQL API");
    console.log("   Check your R2_SQL_TOKEN and CLOUDFLARE_ACCOUNT_ID");
    return false;
  }
}

// Run tests
async function main() {
  console.clear();

  // Note: R2 SQL requires a table in FROM clause, so we skip simple connection test
  console.log("ℹ️  R2 SQL requires tables in queries, proceeding directly to table format tests...\n");

  // Test table name formats
  await testAllFormats();
}

main().catch(error => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
