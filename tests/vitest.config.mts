import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

const migrationsPath = path.join(__dirname, "..", "migrations");
const migrations = await readD1Migrations(migrationsPath);

const analyticsPath = path.join(__dirname, "..", "migrations-analytics");
const analyticsMigrations = await readD1Migrations(analyticsPath);

const aiPath = path.join(__dirname, "..", "migrations-ai");
const aiMigrations = await readD1Migrations(aiPath);

// V2 consolidated schema (migrations-adbliss-core + migrations-adbliss-analytics)
const coreV2Path = path.join(__dirname, "..", "migrations-adbliss-core");
const coreV2Migrations = await readD1Migrations(coreV2Path);

const analyticsV2Path = path.join(__dirname, "..", "migrations-adbliss-analytics");
const analyticsV2Migrations = await readD1Migrations(analyticsV2Path);

export default defineWorkersConfig({
  esbuild: {
    target: "esnext",
  },
  test: {
    exclude: ["**/api-production.test.ts", "**/node_modules/**"],
    setupFiles: ["./tests/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "../wrangler.jsonc",
        },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            MIGRATIONS: migrations,
            ANALYTICS_MIGRATIONS: analyticsMigrations,
            AI_MIGRATIONS: aiMigrations,
            CORE_V2_MIGRATIONS: coreV2Migrations,
            ANALYTICS_V2_MIGRATIONS: analyticsV2Migrations,
            SENDGRID_API_KEY: "SG.test-key-for-vitest",
          },
          // Stub the CLEARLIFT_CRON service binding so miniflare can start.
          // Tests don't call the cron service — this prevents ERR_RUNTIME_FAILURE.
          serviceBindings: {
            CLEARLIFT_CRON: () => new Response("stub", { status: 200 }),
          },
        },
        isolatedStorage: false,
      },
    },
  },
});
