/**
 * Organization Management Endpoints
 *
 * Handle organization creation, invites, and member management
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { generateInviteCode } from "../../utils/auth";
import { createEmailService } from "../../utils/email";

/**
 * POST /v1/organizations - Create a new organization
 */
export class CreateOrganization extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Create a new organization",
    operationId: "create-organization",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          name: z.string().min(2).max(100),
          slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/).optional()
        })
      )
    },
    responses: {
      "201": {
        description: "Organization created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                organization: z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  created_at: z.string(),
                  subscription_tier: z.string(),
                  org_tag: z.string()
                })
              })
            })
          }
        }
      },
      "400": {
        description: "Invalid request"
      },
      "409": {
        description: "Slug already exists"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { name, slug: requestedSlug } = data.body;

    // Generate slug if not provided
    let slug = requestedSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Ensure unique slug
    let finalSlug = slug;
    let counter = 1;
    while (await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ?").bind(finalSlug).first()) {
      finalSlug = `${slug}-${counter}`;
      counter++;
    }

    const orgId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Generate org_tag from name (first 5 alphanumeric chars, with collision prevention)
    const baseTag = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'org';
    let shortTag = baseTag;
    let tagCounter = 1;
    while (await c.env.DB.prepare("SELECT id FROM org_tag_mappings WHERE short_tag = ?").bind(shortTag).first()) {
      shortTag = `${baseTag}-${tagCounter}`;
      tagCounter++;
    }

    try {
      // Create organization
      await c.env.DB.prepare(`
        INSERT INTO organizations (
          id, name, slug, created_at, updated_at,
          subscription_tier
        )
        VALUES (?, ?, ?, ?, ?, 'free')
      `).bind(orgId, name, finalSlug, now, now).run();

      // Add creator as owner
      await c.env.DB.prepare(`
        INSERT INTO organization_members (organization_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', ?)
      `).bind(orgId, session.user_id, now).run();

      // Create org_tag_mapping for analytics
      const tagMappingId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO org_tag_mappings (id, organization_id, short_tag, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(tagMappingId, orgId, shortTag, now).run();

      // AI recommendations are generated from real synced data via POST /v1/analysis/run

      return c.json({
        success: true,
        data: {
          organization: {
            id: orgId,
            name,
            slug: finalSlug,
            created_at: now,
            subscription_tier: 'free',
            org_tag: shortTag
          }
        }
      }, 201);

    } catch (err) {
      console.error("Organization creation error:", err);
      return error(c, "CREATION_FAILED", "Failed to create organization", 500);
    }
  }
}

/**
 * PATCH /v1/organizations/:org_id - Update organization details
 */
export class UpdateOrganization extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Update organization details",
    operationId: "update-organization",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      }),
      body: contentJson(
        z.object({
          name: z.string().min(2).max(100).optional(),
          default_attribution_model: z.enum([
            'first_touch', 'last_touch', 'linear', 'time_decay',
            'position_based', 'markov_chain', 'shapley_value', 'platform'
          ]).optional(),
          attribution_window_days: z.number().int().min(1).max(180).optional(),
          time_decay_half_life_days: z.number().int().min(1).max(90).optional(),
          conversion_source: z.enum(['platform', 'tag', 'hybrid']).optional()
        })
      )
    },
    responses: {
      "200": {
        description: "Organization updated",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                organization: z.object({
                  id: z.string(),
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
      "403": {
        description: "No permission to update"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string; // Set by requireOrg middleware
    const data = await this.getValidatedData<typeof this.schema>();
    const {
      name,
      default_attribution_model,
      attribution_window_days,
      time_decay_half_life_days,
      conversion_source
    } = data.body;

    // Authorization check handled by requireOrgAdmin middleware
    const now = new Date().toISOString();

    // Build dynamic update query
    const updates: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (default_attribution_model !== undefined) {
      updates.push('default_attribution_model = ?');
      values.push(default_attribution_model);
    }
    if (attribution_window_days !== undefined) {
      updates.push('attribution_window_days = ?');
      values.push(attribution_window_days);
    }
    if (time_decay_half_life_days !== undefined) {
      updates.push('time_decay_half_life_days = ?');
      values.push(time_decay_half_life_days);
    }
    if (conversion_source !== undefined) {
      updates.push('conversion_source = ?');
      values.push(conversion_source);
    }

    // Update organization
    values.push(orgId);
    await c.env.DB.prepare(`
      UPDATE organizations
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...values).run();

    // Fetch updated organization
    const org = await c.env.DB.prepare(`
      SELECT id, name, default_attribution_model, attribution_window_days,
             time_decay_half_life_days, conversion_source, updated_at
      FROM organizations WHERE id = ?
    `).bind(orgId).first();

    return success(c, {
      organization: {
        id: org!.id,
        name: org!.name,
        default_attribution_model: org!.default_attribution_model || 'last_touch',
        attribution_window_days: org!.attribution_window_days || 30,
        time_decay_half_life_days: org!.time_decay_half_life_days || 7,
        conversion_source: org!.conversion_source || 'tag',
        updated_at: org!.updated_at
      }
    });
  }
}

/**
 * POST /v1/organizations/:org_id/invite - Invite a user to organization
 */
export class InviteToOrganization extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Invite user to organization",
    operationId: "invite-to-organization",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      }),
      body: contentJson(
        z.object({
          email: z.string().email().toLowerCase(),
          role: z.enum(['viewer', 'admin', 'owner']).default('viewer')
        })
      )
    },
    responses: {
      "201": {
        description: "Invitation sent",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invitation: z.object({
                  id: z.string(),
                  email: z.string(),
                  role: z.string(),
                  invite_code: z.string(),
                  expires_at: z.string()
                })
              })
            })
          }
        }
      },
      "403": {
        description: "No permission to invite"
      },
      "409": {
        description: "User already member or invited"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string; // Set by requireOrg middleware
    const data = await this.getValidatedData<typeof this.schema>();
    const { email, role } = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    // Check if user is already a member
    const existingUser = await c.env.DB.prepare(`
      SELECT u.id FROM users u
      JOIN organization_members om ON u.id = om.user_id
      WHERE u.email = ? AND om.organization_id = ?
    `).bind(email, orgId).first();

    if (existingUser) {
      return error(c, "USER_EXISTS", "User is already a member of this organization", 409);
    }

    // Check if invitation already exists
    const existingInvite = await c.env.DB.prepare(`
      SELECT id FROM invitations
      WHERE email = ? AND organization_id = ? AND expires_at > datetime('now')
    `).bind(email, orgId).first();

    if (existingInvite) {
      return error(c, "INVITE_EXISTS", "An invitation has already been sent to this email", 409);
    }

    // Create invitation
    const inviteId = crypto.randomUUID();
    const inviteCode = generateInviteCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await c.env.DB.prepare(`
      INSERT INTO invitations (
        id, organization_id, email, role, invited_by,
        invite_code, expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      inviteId, orgId, email, role, session.user_id,
      inviteCode, expiresAt.toISOString(), new Date().toISOString()
    ).run();

    // Get inviter's name and organization details
    const inviterDetails = await c.env.DB.prepare(`
      SELECT u.name as inviter_name, o.name as org_name
      FROM users u
      JOIN organizations o ON o.id = ?
      WHERE u.id = ?
    `).bind(orgId, session.user_id).first<{
      inviter_name: string;
      org_name: string;
    }>();

    // Send invitation email
    const emailService = createEmailService(c.env);
    await emailService.sendOrganizationInvite(
      email,
      inviterDetails?.org_name || 'Organization',
      inviterDetails?.inviter_name || 'A team member',
      role,
      inviteCode
    );

    return c.json({
      success: true,
      data: {
        invitation: {
          id: inviteId,
          email,
          role,
          invite_code: inviteCode,
          expires_at: expiresAt.toISOString()
        }
      }
    }, 201);
  }
}

/**
 * POST /v1/organizations/join - Join organization with invite code
 */
export class JoinOrganization extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Join organization with invite code",
    operationId: "join-organization",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          invite_code: z.string().min(6).max(10)
        })
      )
    },
    responses: {
      "200": {
        description: "Joined organization successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                organization: z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  role: z.string()
                })
              })
            })
          }
        }
      },
      "400": {
        description: "Invalid or expired invite code"
      },
      "409": {
        description: "Already a member"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { invite_code } = data.body;

    // Find invitation - handle both regular and shareable invites
    const invitation = await c.env.DB.prepare(`
      SELECT i.*, o.name, o.slug
      FROM invitations i
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.invite_code = ?
        AND i.expires_at > datetime('now')
        AND (
          -- Regular invite: not accepted, email matches
          (i.is_shareable = 0 AND i.accepted_at IS NULL AND i.email = ?)
          OR
          -- Shareable invite: within usage limit
          (i.is_shareable = 1 AND (i.max_uses IS NULL OR i.use_count < i.max_uses))
        )
    `).bind(invite_code, session.email).first<{
      id: string;
      organization_id: string;
      role: string;
      name: string;
      slug: string;
      is_shareable: number;
      max_uses: number | null;
      use_count: number;
    }>();

    if (!invitation) {
      return error(c, "INVALID_CODE", "Invalid or expired invitation code", 400);
    }

    // Check if already a member
    const existingMembership = await c.env.DB.prepare(`
      SELECT id FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(invitation.organization_id, session.user_id).first();

    if (existingMembership) {
      return error(c, "ALREADY_MEMBER", "You are already a member of this organization", 409);
    }

    const now = new Date().toISOString();

    // Add user to organization
    await c.env.DB.prepare(`
      INSERT INTO organization_members (organization_id, user_id, role, joined_at)
      VALUES (?, ?, ?, ?)
    `).bind(invitation.organization_id, session.user_id, invitation.role, now).run();

    // Handle invitation tracking based on type
    if (invitation.is_shareable) {
      // Shareable invite: increment use count
      await c.env.DB.prepare(`
        UPDATE invitations SET use_count = use_count + 1 WHERE id = ?
      `).bind(invitation.id).run();
    } else {
      // Regular invite: mark as accepted
      await c.env.DB.prepare(`
        UPDATE invitations SET accepted_at = ? WHERE id = ?
      `).bind(now, invitation.id).run();
    }

    // Update organization timestamp
    await c.env.DB.prepare(`
      UPDATE organizations
      SET updated_at = ?
      WHERE id = ?
    `).bind(now, invitation.organization_id).run();

    return success(c, {
      organization: {
        id: invitation.organization_id,
        name: invitation.name,
        slug: invitation.slug,
        role: invitation.role
      }
    });
  }
}

/**
 * DELETE /v1/organizations/:org_id/members/:user_id - Remove member from organization
 */
export class RemoveMember extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Remove member from organization",
    operationId: "remove-member",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string(),
        user_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Member removed"
      },
      "403": {
        description: "No permission"
      },
      "404": {
        description: "Member not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string; // Set by requireOrg middleware
    const { user_id } = c.req.param();

    // Authorization check handled by requireOrgOwner middleware

    // Can't remove yourself
    if (user_id === session.user_id) {
      return error(c, "CANNOT_REMOVE_SELF", "You cannot remove yourself from the organization", 400);
    }

    // Check if member exists
    const member = await c.env.DB.prepare(`
      SELECT id FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, user_id).first();

    if (!member) {
      return error(c, "MEMBER_NOT_FOUND", "Member not found in organization", 404);
    }

    // Remove member
    await c.env.DB.prepare(`
      DELETE FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, user_id).run();

    // Update organization timestamp
    await c.env.DB.prepare(`
      UPDATE organizations
      SET updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), orgId).run();

    return success(c, { message: "Member removed successfully" });
  }
}

/**
 * GET /v1/organizations/:org_id/members - Get organization members
 */
export class GetOrganizationMembers extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Get organization members",
    operationId: "get-organization-members",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "List of organization members",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                members: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                  email: z.string(),
                  role: z.string(),
                  joined_at: z.string()
                }))
              })
            })
          }
        }
      },
      "403": {
        description: "No permission"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string; // Set by requireOrg middleware

    // Access check handled by requireOrg middleware

    // Get all members with user details
    const membersResult = await c.env.DB.prepare(`
      SELECT u.id, u.name, u.email, om.role, om.joined_at
      FROM organization_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.organization_id = ?
      ORDER BY om.joined_at ASC
    `).bind(orgId).all();

    return success(c, {
      members: membersResult.results || []
    });
  }
}

/**
 * GET /v1/organizations/:org_id/tag - Get organization tracking tag
 */
export class GetOrganizationTag extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Get organization tracking tag",
    description: "Returns the organization's unique tracking tag for JavaScript pixel integration",
    operationId: "get-organization-tag",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Organization tracking tag",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                org_tag: z.string()
              })
            })
          }
        }
      },
      "403": {
        description: "No permission"
      },
      "404": {
        description: "Organization or tag not found"
      }
    }
  };

  public async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;

    // Access check already handled by requireOrg middleware

    // Get org tag from org_tag_mappings
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag
      FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return error(c, "TAG_NOT_FOUND", "Organization tracking tag not found", 404);
    }

    return success(c, {
      org_tag: tagMapping.short_tag
    });
  }
}

/**
 * GET /v1/organizations/:org_id/invitations - Get pending invitations
 */
export class GetPendingInvitations extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Get pending invitations",
    operationId: "get-pending-invitations",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "List of pending invitations",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invitations: z.array(z.object({
                  id: z.string(),
                  email: z.string(),
                  role: z.string(),
                  invited_by_name: z.string().optional(),
                  invite_code: z.string(),
                  expires_at: z.string(),
                  created_at: z.string()
                }))
              })
            })
          }
        }
      },
      "403": {
        description: "No permission"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string; // Set by requireOrg middleware

    // Authorization check handled by requireOrgAdmin middleware

    // Get pending invitations (not accepted, not expired)
    const invitationsResult = await c.env.DB.prepare(`
      SELECT
        i.id,
        i.email,
        i.role,
        i.invite_code,
        i.expires_at,
        i.created_at,
        i.is_shareable,
        i.max_uses,
        i.use_count,
        u.name as invited_by_name
      FROM invitations i
      LEFT JOIN users u ON i.invited_by = u.id
      WHERE i.organization_id = ?
        AND i.accepted_at IS NULL
        AND i.expires_at > datetime('now')
      ORDER BY i.created_at DESC
    `).bind(orgId).all();

    return success(c, {
      invitations: invitationsResult.results || []
    });
  }
}

/**
 * POST /v1/organizations/:org_id/invite-link - Create shareable invite link
 */
export class CreateShareableInviteLink extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Create a shareable invite link for the organization",
    operationId: "create-shareable-invite-link",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      }),
      body: contentJson(
        z.object({
          role: z.enum(['viewer', 'admin']).default('viewer'),
          max_uses: z.number().int().positive().optional(),
          expires_in_days: z.number().int().min(1).max(90).default(30)
        })
      )
    },
    responses: {
      "201": {
        description: "Shareable invite link created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invite_link: z.object({
                  id: z.string(),
                  invite_code: z.string(),
                  role: z.string(),
                  max_uses: z.number().nullable(),
                  expires_at: z.string(),
                  join_url: z.string()
                })
              })
            })
          }
        }
      },
      "403": {
        description: "No permission to create invite links"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { role, max_uses, expires_in_days } = data.body;

    // Create shareable invitation
    const inviteId = crypto.randomUUID();
    const inviteCode = generateInviteCode();
    const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);

    await c.env.DB.prepare(`
      INSERT INTO invitations (
        id, organization_id, email, role, invited_by,
        invite_code, expires_at, created_at, is_shareable, max_uses, use_count
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, 0)
    `).bind(
      inviteId, orgId, role, session.user_id,
      inviteCode, expiresAt.toISOString(), new Date().toISOString(),
      max_uses || null
    ).run();

    const joinUrl = `https://app.clearlift.ai/join?code=${inviteCode}`;

    return c.json({
      success: true,
      data: {
        invite_link: {
          id: inviteId,
          invite_code: inviteCode,
          role,
          max_uses: max_uses || null,
          expires_at: expiresAt.toISOString(),
          join_url: joinUrl
        }
      }
    }, 201);
  }
}

/**
 * GET /v1/organizations/:org_id/invite-link - Get existing shareable invite link
 */
export class GetShareableInviteLink extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Get active shareable invite link for the organization",
    operationId: "get-shareable-invite-link",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Active shareable invite link",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invite_link: z.object({
                  id: z.string(),
                  invite_code: z.string(),
                  role: z.string(),
                  max_uses: z.number().nullable(),
                  use_count: z.number(),
                  expires_at: z.string(),
                  join_url: z.string()
                }).nullable()
              })
            })
          }
        }
      },
      "403": {
        description: "No permission"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;

    // Get active shareable invite link
    const inviteLink = await c.env.DB.prepare(`
      SELECT id, invite_code, role, max_uses, use_count, expires_at
      FROM invitations
      WHERE organization_id = ?
        AND is_shareable = 1
        AND expires_at > datetime('now')
        AND (max_uses IS NULL OR use_count < max_uses)
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(orgId).first<{
      id: string;
      invite_code: string;
      role: string;
      max_uses: number | null;
      use_count: number;
      expires_at: string;
    }>();

    if (!inviteLink) {
      return success(c, { invite_link: null });
    }

    return success(c, {
      invite_link: {
        ...inviteLink,
        join_url: `https://app.clearlift.ai/join?code=${inviteLink.invite_code}`
      }
    });
  }
}

/**
 * DELETE /v1/organizations/:org_id/invite-link - Revoke shareable invite link
 */
export class RevokeShareableInviteLink extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Revoke a shareable invite link",
    operationId: "revoke-shareable-invite-link",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Invite link revoked"
      },
      "403": {
        description: "No permission"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;

    // Expire all shareable invites for this org
    await c.env.DB.prepare(`
      UPDATE invitations
      SET expires_at = datetime('now')
      WHERE organization_id = ?
        AND is_shareable = 1
        AND expires_at > datetime('now')
    `).bind(orgId).run();

    return success(c, { message: "Shareable invite links revoked" });
  }
}

/**
 * GET /v1/organizations/lookup - Lookup organization by ID or slug
 */
export class LookupOrganization extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Lookup organization by ID or slug (public info only)",
    operationId: "lookup-organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        id: z.string().optional(),
        slug: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Organization found",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                organization: z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  has_open_invite: z.boolean()
                }).nullable()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { id, slug } = data.query;

    if (!id && !slug) {
      return error(c, "MISSING_PARAM", "Either id or slug is required", 400);
    }

    // Look up organization
    let org;
    if (id) {
      org = await c.env.DB.prepare(`
        SELECT id, name, slug FROM organizations WHERE id = ?
      `).bind(id).first<{ id: string; name: string; slug: string }>();
    } else {
      org = await c.env.DB.prepare(`
        SELECT id, name, slug FROM organizations WHERE slug = ?
      `).bind(slug).first<{ id: string; name: string; slug: string }>();
    }

    if (!org) {
      return success(c, { organization: null });
    }

    // Check if org has an open invite
    const openInvite = await c.env.DB.prepare(`
      SELECT 1 FROM invitations
      WHERE organization_id = ?
        AND is_shareable = 1
        AND expires_at > datetime('now')
        AND (max_uses IS NULL OR use_count < max_uses)
      LIMIT 1
    `).bind(org.id).first();

    return success(c, {
      organization: {
        ...org,
        has_open_invite: !!openInvite
      }
    });
  }
}

/**
 * GET /v1/organizations/:org_id/tracking-domains - List tracking domains
 */
export class GetTrackingDomains extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "List tracking domains for the organization",
    operationId: "get-tracking-domains",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Tracking domains retrieved",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                domains: z.array(z.object({
                  id: z.string(),
                  domain: z.string(),
                  is_verified: z.boolean(),
                  is_primary: z.boolean(),
                  created_at: z.string(),
                  backfill_status: z.enum(['pending', 'syncing', 'completed', 'failed']).optional(),
                  backfill_events_count: z.number().optional(),
                  backfill_completed_at: z.string().nullable().optional()
                }))
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id: orgId } = data.params;

    const domains = await c.env.DB.prepare(`
      SELECT id, domain, is_verified, is_primary, created_at
      FROM tracking_domains
      WHERE organization_id = ?
      ORDER BY is_primary DESC, created_at DESC
    `).bind(orgId).all();

    // Enrich domains with backfill status from Supabase
    let enrichedDomains = domains.results || [];

    if (enrichedDomains.length > 0 && c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY) {
      try {
        const { getSecret } = await import("../../utils/secrets");
        const { SupabaseClient } = await import("../../services/supabase");
        const { EventsBackfillService } = await import("../../services/events-backfill");

        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const backfillService = new EventsBackfillService(supabase);

          enrichedDomains = await Promise.all(
            enrichedDomains.map(async (d: any) => {
              const backfillStatus = await backfillService.getDomainBackfillStatus(d.domain);
              return {
                ...d,
                backfill_status: backfillStatus?.status || 'pending',
                backfill_events_count: backfillStatus?.events_count || 0,
                backfill_completed_at: backfillStatus?.completed_at || null
              };
            })
          );
        }
      } catch (backfillError) {
        // Log but continue - domains are still useful without backfill status
        console.error('Failed to fetch backfill status:', backfillError);
      }
    }

    return success(c, {
      domains: enrichedDomains
    });
  }
}

/**
 * POST /v1/organizations/:org_id/tracking-domains - Add tracking domain
 */
export class AddTrackingDomain extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Add a tracking domain to the organization",
    operationId: "add-tracking-domain",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string()
      }),
      body: contentJson(
        z.object({
          domain: z.string().min(3).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/),
          is_primary: z.boolean().optional().default(false)
        })
      )
    },
    responses: {
      "201": {
        description: "Tracking domain added",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                domain: z.object({
                  id: z.string(),
                  domain: z.string(),
                  is_verified: z.boolean(),
                  is_primary: z.boolean(),
                  created_at: z.string()
                }),
                backfill: z.object({
                  events_found: z.number(),
                  claim_id: z.string()
                }).optional()
              })
            })
          }
        }
      },
      "409": {
        description: "Domain already exists"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id: orgId } = data.params;
    const { domain, is_primary } = data.body;

    // Normalize domain to lowercase
    const normalizedDomain = domain.toLowerCase();

    // Check if domain already exists (globally - a domain can only belong to one org)
    const existingDomain = await c.env.DB.prepare(`
      SELECT id, organization_id FROM tracking_domains WHERE domain = ?
    `).bind(normalizedDomain).first<{ id: string; organization_id: string }>();

    if (existingDomain) {
      if (existingDomain.organization_id === orgId) {
        return error(c, "DOMAIN_EXISTS", "This domain is already registered to your organization", 409);
      }
      return error(c, "DOMAIN_TAKEN", "This domain is already registered to another organization", 409);
    }

    const domainId = crypto.randomUUID();
    const now = new Date().toISOString();

    // If setting as primary, unset other primary domains first
    if (is_primary) {
      await c.env.DB.prepare(`
        UPDATE tracking_domains SET is_primary = FALSE WHERE organization_id = ?
      `).bind(orgId).run();
    }

    // Insert into D1 tracking_domains
    await c.env.DB.prepare(`
      INSERT INTO tracking_domains (id, organization_id, domain, is_verified, is_primary, created_at)
      VALUES (?, ?, ?, FALSE, ?, ?)
    `).bind(domainId, orgId, normalizedDomain, is_primary, now).run();

    // Get org_tag for Supabase backfill
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ short_tag: string }>();

    // Trigger Supabase events backfill (claims domain for historical event resolution)
    let backfillResult: { events_found: number; claim_id: string } | undefined;
    if (tagMapping && c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY) {
      try {
        const { getSecret } = await import("../../utils/secrets");
        const { SupabaseClient } = await import("../../services/supabase");
        const { EventsBackfillService } = await import("../../services/events-backfill");

        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const backfillService = new EventsBackfillService(supabase);

          const result = await backfillService.claimDomain(normalizedDomain, tagMapping.short_tag);
          backfillResult = {
            events_found: result.events_updated,
            claim_id: result.claim_id
          };
        }
      } catch (backfillError) {
        // Log but don't fail - D1 domain was already added successfully
        console.error('Events backfill failed:', backfillError);
      }
    }

    return success(c, {
      domain: {
        id: domainId,
        domain: normalizedDomain,
        is_verified: false,
        is_primary: is_primary,
        created_at: now
      },
      backfill: backfillResult
    }, undefined, 201);
  }
}

/**
 * DELETE /v1/organizations/:org_id/tracking-domains/:domain_id - Remove tracking domain
 */
export class RemoveTrackingDomain extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Remove a tracking domain from the organization",
    operationId: "remove-tracking-domain",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string(),
        domain_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Tracking domain removed",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                message: z.string(),
                domain_claim_released: z.boolean().optional()
              })
            })
          }
        }
      },
      "404": {
        description: "Domain not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id: orgId, domain_id: domainId } = data.params;

    // Verify domain belongs to this org and get domain string
    const domainRecord = await c.env.DB.prepare(`
      SELECT id, domain FROM tracking_domains WHERE id = ? AND organization_id = ?
    `).bind(domainId, orgId).first<{ id: string; domain: string }>();

    if (!domainRecord) {
      return error(c, "NOT_FOUND", "Domain not found", 404);
    }

    // Delete from D1
    await c.env.DB.prepare(`
      DELETE FROM tracking_domains WHERE id = ?
    `).bind(domainId).run();

    // Release domain claim in Supabase
    let domainClaimReleased = false;
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (tagMapping && c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY) {
      try {
        const { getSecret } = await import("../../utils/secrets");
        const { SupabaseClient } = await import("../../services/supabase");
        const { EventsBackfillService } = await import("../../services/events-backfill");

        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const backfillService = new EventsBackfillService(supabase);

          domainClaimReleased = await backfillService.releaseDomain(
            domainRecord.domain,
            tagMapping.short_tag
          );
        }
      } catch (releaseError) {
        // Log but don't fail - D1 domain was already deleted successfully
        console.error('Domain claim release failed:', releaseError);
      }
    }

    return success(c, {
      message: "Domain removed successfully",
      domain_claim_released: domainClaimReleased
    });
  }
}

/**
 * POST /v1/organizations/:org_id/tracking-domains/:domain_id/resync - Resync a tracking domain
 */
export class ResyncTrackingDomain extends OpenAPIRoute {
  public schema = {
    tags: ["Organizations"],
    summary: "Resync historical events for a tracking domain",
    operationId: "resync-tracking-domain",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        org_id: z.string(),
        domain_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Domain resync started",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                message: z.string(),
                events_found: z.number(),
                backfill_status: z.enum(['pending', 'syncing', 'completed', 'failed'])
              })
            })
          }
        }
      },
      "404": {
        description: "Domain not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id: orgId, domain_id: domainId } = data.params;

    // Verify domain belongs to this org and get domain string
    const domainRecord = await c.env.DB.prepare(`
      SELECT id, domain FROM tracking_domains WHERE id = ? AND organization_id = ?
    `).bind(domainId, orgId).first<{ id: string; domain: string }>();

    if (!domainRecord) {
      return error(c, "NOT_FOUND", "Domain not found", 404);
    }

    // Get org_tag for backfill
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return error(c, "NO_ORG_TAG", "Organization has no active org_tag mapping", 400);
    }

    // Trigger resync
    let eventsFound = 0;
    let backfillStatus: 'pending' | 'syncing' | 'completed' | 'failed' = 'pending';

    if (c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY) {
      try {
        const { getSecret } = await import("../../utils/secrets");
        const { SupabaseClient } = await import("../../services/supabase");
        const { EventsBackfillService } = await import("../../services/events-backfill");

        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const backfillService = new EventsBackfillService(supabase);

          const result = await backfillService.resyncDomain(
            domainRecord.domain,
            tagMapping.short_tag
          );
          eventsFound = result.events_updated;
          backfillStatus = 'completed';
        }
      } catch (resyncError) {
        console.error('Domain resync failed:', resyncError);
        backfillStatus = 'failed';
        return error(c, "RESYNC_FAILED", resyncError instanceof Error ? resyncError.message : "Failed to resync domain", 500);
      }
    } else {
      return error(c, "NO_SUPABASE", "Supabase not configured", 500);
    }

    return success(c, {
      message: "Domain resync completed",
      events_found: eventsFound,
      backfill_status: backfillStatus
    });
  }
}