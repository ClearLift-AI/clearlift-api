import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Consolidated schema (Feb 2026) — 2 databases, 74 tables
const corePath = path.join(__dirname, "..", "migrations-adbliss-core");
const coreMigrations = await readD1Migrations(corePath);

const analyticsPath = path.join(__dirname, "..", "migrations-adbliss-analytics");
const analyticsMigrations = await readD1Migrations(analyticsPath);

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
            MIGRATIONS: coreMigrations,
            ANALYTICS_MIGRATIONS: analyticsMigrations,
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
