import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Adbliss consolidated schema migrations
const corePath = path.join(__dirname, "..", "migrations-core");
const coreMigrations = await readD1Migrations(corePath);

const analyticsPath = path.join(__dirname, "..", "migrations-analytics-v2");
const analyticsMigrations = await readD1Migrations(analyticsPath);

export default defineWorkersConfig({
  esbuild: {
    target: "esnext",
  },
  test: {
    include: ["**/analysis-schema-v2.test.ts"],
    setupFiles: ["./tests/apply-migrations-v2.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "../tests/wrangler-v2-test.jsonc",
        },
        miniflare: {
          compatibilityFlags: ["experimental", "nodejs_compat"],
          bindings: {
            ADBLISS_CORE_MIGRATIONS: coreMigrations,
            ADBLISS_ANALYTICS_MIGRATIONS: analyticsMigrations,
          },
        },
        isolatedStorage: false,
      },
    },
  },
});
