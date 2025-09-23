import type { Context } from "hono";
import { Session } from "./middleware/auth";

// Extend the Env interface with our bindings
declare global {
  interface Env {
    DB: D1Database;
    SUPABASE_URL: string;
    SUPABASE_SECRET_KEY: string;
  }
}

// Define context variables that can be set/get
type Variables = {
  session: Session;
};

export type AppContext = Context<{
  Bindings: Env;
  Variables: Variables;
}>;

export type HandleArgs = [AppContext];