import type { Context } from "hono";
import type { Session, User, Organization } from "./services/auth";

export interface Variables {
  session?: Session;
  user?: User;
  organizationId?: string | null;
  organization?: Organization | null;
}

export type AppContext = Context<{ 
  Bindings: Env;
  Variables: Variables;
}>;

export type HandleArgs = [AppContext];
