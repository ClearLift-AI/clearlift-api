import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";

export const GetUserProfile = new OpenAPIRoute({
  method: "GET",
  path: "/profile",
  security: "session",
  summary: "Get user profile",
  description: "Get the authenticated user's profile information",
  responses: {
    200: {
      description: "User profile retrieved successfully",
      body: z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          name: z.string().nullable(),
          created_at: z.string(),
          last_login_at: z.string().nullable()
        }),
        organization: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          role: z.string(),
          subscription_tier: z.string()
        }).nullable(),
        organizations: z.array(z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          role: z.string()
        }))
      })
    }
  }
}).handle(async (c: AppContext) => {
  const session = c.get('session');
  const user = c.get('user');
  const organization = c.get('organization');
  
  if (!session || !user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    // Get all organizations for the user
    const organizationsResult = await c.env.DB.prepare(`
      SELECT o.id, o.name, o.slug, om.role
      FROM organizations o
      JOIN organization_members om ON o.id = om.organization_id
      WHERE om.user_id = ?
      ORDER BY o.created_at DESC
    `).bind(user.id).all();

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        last_login_at: user.last_login_at
      },
      organization: organization ? {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: organization.role || 'member',
        subscription_tier: organization.subscription_tier
      } : null,
      organizations: organizationsResult.results || []
    });

  } catch (error) {
    console.error('Get user profile error:', error);
    return c.json({ 
      error: 'Failed to retrieve user profile',
      message: error instanceof Error ? error.message : 'Database error'
    }, 500);
  }
});

export const UpdateUserProfile = new OpenAPIRoute({
  method: "PUT",
  path: "/profile",
  security: "session",
  summary: "Update user profile",
  description: "Update the authenticated user's profile information",
  request: {
    body: z.object({
      name: z.string().optional().describe("User's display name"),
      avatar_url: z.string().optional().describe("User's avatar URL")
    })
  },
  responses: {
    200: {
      description: "Profile updated successfully",
      body: z.object({
        success: z.boolean(),
        user: z.object({
          id: z.string(),
          email: z.string(),
          name: z.string().nullable(),
          avatar_url: z.string().nullable(),
          updated_at: z.string()
        })
      })
    }
  }
}).handle(async (c: AppContext) => {
  const user = c.get('user');
  
  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const { name, avatar_url } = await c.req.json();

  try {
    // Update user profile
    const updateFields = [];
    const updateValues = [];
    
    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }
    
    if (avatar_url !== undefined) {
      updateFields.push('avatar_url = ?');
      updateValues.push(avatar_url);
    }
    
    if (updateFields.length > 0) {
      updateFields.push('updated_at = datetime("now")');
      updateValues.push(user.id);
      
      await c.env.DB.prepare(`
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `).bind(...updateValues).run();
    }

    // Get updated user data
    const updatedUser = await c.env.DB.prepare(`
      SELECT id, email, name, avatar_url, updated_at
      FROM users
      WHERE id = ?
    `).bind(user.id).first();

    return c.json({
      success: true,
      user: updatedUser as any
    });

  } catch (error) {
    console.error('Update user profile error:', error);
    return c.json({ 
      error: 'Failed to update user profile',
      message: error instanceof Error ? error.message : 'Database error'
    }, 500);
  }
});