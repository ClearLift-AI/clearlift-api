import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside isolated storage, and may be run multiple times.
// `applyD1Migrations()` only applies migrations that haven't already been
// applied, therefore it is safe to call this function here.

// Core database (users, sessions, orgs, connections, AI engine — 41 tables)
await applyD1Migrations(env.DB, env.MIGRATIONS);

// Analytics database (connectors, ad platforms, events, conversions — 33 tables)
if (env.ANALYTICS_DB && env.ANALYTICS_MIGRATIONS) {
  await applyD1Migrations(env.ANALYTICS_DB, env.ANALYTICS_MIGRATIONS);
}
