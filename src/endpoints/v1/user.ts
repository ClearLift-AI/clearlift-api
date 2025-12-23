import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { Session } from "../../middleware/auth";
import { D1Adapter } from "../../adapters/d1";
import { success, error } from "../../utils/response";

/**
 * GET /v1/user/me - Get current user profile
 */
export class GetUserProfile extends OpenAPIRoute {
  public schema = {
    tags: ["User"],
    summary: "Get current user profile",
    operationId: "get-user-profile",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "User profile",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                user: z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string().nullable(),
                  created_at: z.string(),
                  last_login_at: z.string().nullable(),
                  avatar_url: z.string().nullable(),
                  is_admin: z.boolean()
                })
              })
            })
          }
        }
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user) {
      return error(c, "USER_NOT_FOUND", "User not found", 404);
    }

    // Convert is_admin from integer (0/1) to boolean
    return success(c, {
      user: {
        ...user,
        is_admin: Boolean(user.is_admin)
      }
    });
  }
}

/**
 * PATCH /v1/user/me - Update current user profile
 */
export class UpdateUserProfile extends OpenAPIRoute {
  public schema = {
    tags: ["User"],
    summary: "Update current user profile",
    operationId: "update-user-profile",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          name: z.string().min(1).max(100)
        })
      )
    },
    responses: {
      "200": {
        description: "Updated user profile",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                user: z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string(),
                  updated_at: z.string()
                })
              })
            })
          }
        }
      },
      "400": {
        description: "Invalid request"
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { name } = data.body;

    const d1 = new D1Adapter(c.env.DB);

    const updated = await d1.updateUser(session.user_id, {
      name,
      updated_at: new Date().toISOString()
    });

    if (!updated) {
      return error(c, "UPDATE_FAILED", "Failed to update user profile", 500);
    }

    return success(c, {
      user: {
        id: session.user_id,
        email: session.email,
        name,
        updated_at: new Date().toISOString()
      }
    });
  }
}

/**
 * GET /v1/user/organizations - Get user's organizations
 */
export class GetUserOrganizations extends OpenAPIRoute {
  public schema = {
    tags: ["User"],
    summary: "Get user's organizations",
    operationId: "get-user-organizations",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "User's organizations",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                organizations: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    slug: z.string(),
                    role: z.string(),
                    joined_at: z.string(),
                    created_at: z.string(),
                    updated_at: z.string(),
                    subscription_tier: z.string(),
                    org_tag: z.string().nullable(),
                    members_count: z.number(),
                    platforms_count: z.number()
                  })
                )
              })
            })
          }
        }
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    const d1 = new D1Adapter(c.env.DB);

    // Check if user is admin - if so, return ALL organizations
    const user = await d1.getUser(session.user_id);
    const organizations = user?.is_admin
      ? await d1.getAllOrganizations()
      : await d1.getUserOrganizations(session.user_id);

    return success(c, {
      organizations
    });
  }
}