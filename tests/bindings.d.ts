import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/bindings";

export type Env = AppEnv & {
  MIGRATIONS: D1Migration[];
  ANALYTICS_MIGRATIONS: D1Migration[];
  AI_MIGRATIONS: D1Migration[];
  ADBLISS_CORE_MIGRATIONS: D1Migration[];
  ADBLISS_ANALYTICS_MIGRATIONS: D1Migration[];
  ADBLISS_DB: D1Database;
  ADBLISS_ANALYTICS_DB: D1Database;
};

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
