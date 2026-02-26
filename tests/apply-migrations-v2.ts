import { applyD1Migrations, env } from "cloudflare:test";

// Adbliss consolidated schema setup — only applies new migrations.
// Used by vitest-v2.config.mts for schema validation tests.

// Core database (users, sessions, orgs, connections, AI engine)
if (env.ADBLISS_DB && env.ADBLISS_CORE_MIGRATIONS) {
  await applyD1Migrations(env.ADBLISS_DB, env.ADBLISS_CORE_MIGRATIONS);
}

// Analytics database (connector_events, ad_metrics, conversions, identity, journeys)
if (env.ADBLISS_ANALYTICS_DB && env.ADBLISS_ANALYTICS_MIGRATIONS) {
  await applyD1Migrations(env.ADBLISS_ANALYTICS_DB, env.ADBLISS_ANALYTICS_MIGRATIONS);
}
