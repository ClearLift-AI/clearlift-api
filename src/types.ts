import type { Context } from "hono";
import { Session } from "./middleware/auth";

// Interface for Secrets Store bindings
interface SecretsStoreBinding {
  get(): Promise<string>;
}

// Extend the Env interface with our bindings
declare global {
  interface Env {
    DB: D1Database;
    SUPABASE_URL: string;

    // Secrets Store bindings (async access required)
    SUPABASE_SECRET_KEY: SecretsStoreBinding;
    SUPABASE_PUBLISHABLE_KEY: SecretsStoreBinding;
    R2_SQL_TOKEN: SecretsStoreBinding;

    // OAuth Secrets Store bindings
    GOOGLE_CLIENT_ID: SecretsStoreBinding;
    GOOGLE_CLIENT_SECRET: SecretsStoreBinding;
    GOOGLE_ADS_DEVELOPER_TOKEN: SecretsStoreBinding;
    FACEBOOK_APP_ID: SecretsStoreBinding;
    FACEBOOK_APP_SECRET: SecretsStoreBinding;
    SHOPIFY_CLIENT_ID: SecretsStoreBinding;
    SHOPIFY_CLIENT_SECRET: SecretsStoreBinding;

    // Encryption key for field-level encryption
    ENCRYPTION_KEY: SecretsStoreBinding;

    // Regular environment variables
    CLOUDFLARE_ACCOUNT_ID: string;
    R2_BUCKET_NAME: string;

    // Queue binding
    SYNC_QUEUE: Queue<any>;
  }
}

// Define context variables that can be set/get
type Variables = {
  session: Session;
  org_id?: string;
};

export type AppContext = Context<{
  Bindings: Env;
  Variables: Variables;
}>;

export type HandleArgs = [AppContext];