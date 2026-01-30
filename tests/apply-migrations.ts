import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside isolated storage, and may be run multiple times.
// `applyD1Migrations()` only applies migrations that haven't already been
// applied, therefore it is safe to call this function here.

// Main database (users, sessions, orgs, connections)
await applyD1Migrations(env.DB, env.MIGRATIONS);

// Analytics database (ad_campaigns, ad_groups, ads, ad_metrics, conversions, etc.)
if (env.ANALYTICS_DB && env.ANALYTICS_MIGRATIONS) {
  await applyD1Migrations(env.ANALYTICS_DB, env.ANALYTICS_MIGRATIONS);
}

// AI database (ai_decisions, analysis_logs, etc.)
if (env.AI_DB && env.AI_MIGRATIONS) {
  await applyD1Migrations(env.AI_DB, env.AI_MIGRATIONS);
}
