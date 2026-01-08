/**
 * Admin endpoints for managing D1 data routing rollout
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { Context } from "hono";
import { DataSourceRouter } from "../../../services/data-source-router";
import { ShardRouter, getShards } from "../../../services/shard-router";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

// Helper to check admin status
async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const session = c.get("session" as never) as { user_id: string } | undefined;
  if (!session?.user_id) return false;

  const user = await c.env.DB
    .prepare("SELECT is_admin FROM users WHERE id = ?")
    .bind(session.user_id)
    .first<{ is_admin: number }>();

  return user?.is_admin === 1;
}

// Helper to create router
async function createDataRouter(c: Context<{ Bindings: Env }>): Promise<DataSourceRouter> {
  const secretKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
  if (!secretKey) {
    throw new Error("Supabase secret key not configured");
  }
  const supabase = new SupabaseClient({
    url: c.env.SUPABASE_URL,
    secretKey,
  });
  const shardRouter = new ShardRouter(c.env.DB, getShards(c.env));
  return new DataSourceRouter(c.env.DB, supabase, shardRouter);
}

/**
 * Get rollout statistics
 */
export class GetRolloutStats extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Get D1 rollout statistics",
    responses: {
      200: {
        description: "Rollout statistics",
        content: {
          "application/json": {
            schema: z.object({
              total: z.number(),
              readingFromD1: z.number(),
              dualWrite: z.number(),
              d1Only: z.number(),
              supabaseOnly: z.number(),
            }),
          },
        },
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const router = await createDataRouter(c);
    const stats = await router.getRolloutStats();
    return c.json(stats);
  }
}

/**
 * Get routing config for an organization
 */
export class GetOrgRoutingConfig extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Get routing config for an organization",
    request: {
      params: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Organization routing config",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { org_id } = c.req.param() as { org_id: string };
    const router = await createDataRouter(c);
    const config = await router.getRoutingConfig(org_id);
    return c.json(config);
  }
}

/**
 * Enable dual-write for an organization
 */
export class EnableDualWrite extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Enable dual-write (Supabase + D1) for an organization",
    request: {
      params: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Dual-write enabled",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { org_id } = c.req.param() as { org_id: string };
    const router = await createDataRouter(c);

    await router.enableDualWrite(org_id);

    return c.json({
      success: true,
      message: `Dual-write enabled for org ${org_id}`,
      next_step: "New syncs will write to both Supabase and D1. Run backfill to migrate historical data.",
    });
  }
}

/**
 * Enable D1 reads for an organization
 */
export class EnableD1Reads extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Switch an organization to read from D1",
    request: {
      params: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "D1 reads enabled",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { org_id } = c.req.param() as { org_id: string };
    const router = await createDataRouter(c);

    try {
      await router.enableD1Reads(org_id);

      return c.json({
        success: true,
        message: `D1 reads enabled for org ${org_id}`,
        next_step: "Verify data is correct, then enable D1-only writes.",
      });
    } catch (e) {
      return c.json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }, 400);
    }
  }
}

/**
 * Enable D1-only mode (fully migrated)
 */
export class EnableD1Only extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Switch an organization to D1-only (disable Supabase writes)",
    request: {
      params: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "D1-only mode enabled",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { org_id } = c.req.param() as { org_id: string };
    const router = await createDataRouter(c);

    try {
      await router.enableD1Only(org_id);

      return c.json({
        success: true,
        message: `D1-only mode enabled for org ${org_id}`,
        note: "Supabase writes are now disabled for this org.",
      });
    } catch (e) {
      return c.json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }, 400);
    }
  }
}

/**
 * Rollback to Supabase (emergency)
 */
export class RollbackToSupabase extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Emergency rollback to Supabase for an organization",
    request: {
      params: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Rolled back to Supabase",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { org_id } = c.req.param() as { org_id: string };
    const router = await createDataRouter(c);

    await router.rollbackToSupabase(org_id);

    return c.json({
      success: true,
      message: `Rolled back to Supabase for org ${org_id}`,
      warning: "Both reads and writes now go to Supabase only.",
    });
  }
}

/**
 * List organizations by routing status
 */
export class ListOrgsByRoutingStatus extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "List organizations by routing status",
    request: {
      query: z.object({
        read_source: z.enum(["supabase", "d1"]).optional(),
        write_mode: z.enum(["supabase", "dual", "d1"]).optional(),
        limit: z.coerce.number().default(100),
      }),
    },
    responses: {
      200: {
        description: "List of organizations",
      },
    },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    if (!(await requireAdmin(c))) {
      return c.json({ error: "Admin access required" }, 403);
    }

    const { read_source, write_mode, limit } = c.req.query() as {
      read_source?: "supabase" | "d1";
      write_mode?: "supabase" | "dual" | "d1";
      limit?: number;
    };

    const router = await createDataRouter(c);
    const orgs = await router.listOrgsByStatus(
      read_source,
      write_mode,
      limit || 100
    );

    return c.json({ orgs, count: orgs.length });
  }
}
