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
    const shortTag = crypto.randomUUID().slice(0, 6);
    const now = new Date().toISOString();

    try {
      // Create organization
      await c.env.DB.prepare(`
        INSERT INTO organizations (
          id, name, slug, created_at, updated_at,
          subscription_tier, seats_limit, seats_used
        )
        VALUES (?, ?, ?, ?, ?, 'free', 5, 1)
      `).bind(orgId, name, finalSlug, now, now).run();

      // Add creator as owner
      await c.env.DB.prepare(`
        INSERT INTO organization_members (organization_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', ?)
      `).bind(orgId, session.user_id, now).run();

      // Create org_tag_mapping for analytics
      await c.env.DB.prepare(`
        INSERT INTO org_tag_mappings (organization_id, short_tag, created_at)
        VALUES (?, ?, ?)
      `).bind(orgId, shortTag, now).run();

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
    const { org_id } = c.req.param();
    const data = await this.getValidatedData<typeof this.schema>();
    const { email, role } = data.body;

    // Check if user has permission (must be admin or owner)
    const membership = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, session.user_id).first<{ role: string }>();

    if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
      return error(c, "FORBIDDEN", "You don't have permission to invite users", 403);
    }

    // Check if user is already a member
    const existingUser = await c.env.DB.prepare(`
      SELECT u.id FROM users u
      JOIN organization_members om ON u.id = om.user_id
      WHERE u.email = ? AND om.organization_id = ?
    `).bind(email, org_id).first();

    if (existingUser) {
      return error(c, "USER_EXISTS", "User is already a member of this organization", 409);
    }

    // Check if invitation already exists
    const existingInvite = await c.env.DB.prepare(`
      SELECT id FROM invitations
      WHERE email = ? AND organization_id = ? AND expires_at > datetime('now')
    `).bind(email, org_id).first();

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
      inviteId, org_id, email, role, session.user_id,
      inviteCode, expiresAt.toISOString(), new Date().toISOString()
    ).run();

    // Get inviter's name and organization details
    const inviterDetails = await c.env.DB.prepare(`
      SELECT u.name as inviter_name, o.name as org_name
      FROM users u
      JOIN organizations o ON o.id = ?
      WHERE u.id = ?
    `).bind(org_id, session.user_id).first<{
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

    // Find invitation
    const invitation = await c.env.DB.prepare(`
      SELECT i.*, o.name, o.slug
      FROM invitations i
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.invite_code = ?
        AND i.expires_at > datetime('now')
        AND i.accepted_at IS NULL
        AND (i.email = ? OR i.email IS NULL)
    `).bind(invite_code, session.email).first<{
      id: string;
      organization_id: string;
      role: string;
      name: string;
      slug: string;
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

    // Mark invitation as accepted
    await c.env.DB.prepare(`
      UPDATE invitations SET accepted_at = ? WHERE id = ?
    `).bind(now, invitation.id).run();

    // Update seats used
    await c.env.DB.prepare(`
      UPDATE organizations
      SET seats_used = seats_used + 1, updated_at = ?
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
    const { org_id, user_id } = c.req.param();

    // Check if requester has permission (must be owner)
    const requesterRole = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, session.user_id).first<{ role: string }>();

    if (!requesterRole || requesterRole.role !== 'owner') {
      return error(c, "FORBIDDEN", "Only owners can remove members", 403);
    }

    // Can't remove yourself
    if (user_id === session.user_id) {
      return error(c, "CANNOT_REMOVE_SELF", "You cannot remove yourself from the organization", 400);
    }

    // Check if member exists
    const member = await c.env.DB.prepare(`
      SELECT id FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, user_id).first();

    if (!member) {
      return error(c, "MEMBER_NOT_FOUND", "Member not found in organization", 404);
    }

    // Remove member
    await c.env.DB.prepare(`
      DELETE FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, user_id).run();

    // Update seats used
    await c.env.DB.prepare(`
      UPDATE organizations
      SET seats_used = seats_used - 1, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), org_id).run();

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
    const session = c.get("session");
    const { org_id } = c.req.param();

    // Check if user is a member of the organization
    const membership = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, session.user_id).first<{ role: string }>();

    if (!membership) {
      return error(c, "FORBIDDEN", "You don't have access to this organization", 403);
    }

    // Get all members with user details
    const membersResult = await c.env.DB.prepare(`
      SELECT u.id, u.name, u.email, om.role, om.joined_at
      FROM organization_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.organization_id = ?
      ORDER BY om.joined_at ASC
    `).bind(org_id).all();

    return success(c, {
      members: membersResult.results || []
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
    const session = c.get("session");
    const { org_id } = c.req.param();

    // Check if user has permission (must be admin or owner)
    const membership = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(org_id, session.user_id).first<{ role: string }>();

    if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
      return error(c, "FORBIDDEN", "You don't have permission to view invitations", 403);
    }

    // Get pending invitations (not accepted, not expired)
    const invitationsResult = await c.env.DB.prepare(`
      SELECT
        i.id,
        i.email,
        i.role,
        i.token as invite_code,
        i.expires_at,
        i.created_at,
        u.name as invited_by_name
      FROM invitations i
      LEFT JOIN users u ON i.invited_by = u.id
      WHERE i.organization_id = ?
        AND i.accepted_at IS NULL
        AND i.expires_at > datetime('now')
      ORDER BY i.created_at DESC
    `).bind(org_id).all();

    return success(c, {
      invitations: invitationsResult.results || []
    });
  }
}