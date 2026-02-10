/**
 * Authentication Endpoints
 *
 * Handle user registration, login, and session management
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { hashPassword, verifyPassword, generateSessionToken } from "../../utils/auth";
import { getSecret } from "../../utils/secrets";
import { createEmailService } from "../../utils/email";
import { structuredLog } from "../../utils/structured-logger";

/**
 * POST /v1/auth/register - Register a new user
 */
export class Register extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Register a new user",
    operationId: "register",
    request: {
      body: contentJson(
        z.object({
          email: z.string().email().toLowerCase(),
          password: z.string().min(8).max(128),
          name: z.string().min(1).max(100),
          organization_name: z.string().min(2).max(100).optional()
        })
      )
    },
    responses: {
      "201": {
        description: "User registered successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                user: z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string()
                }),
                session: z.object({
                  token: z.string(),
                  expires_at: z.string()
                }),
                organization: z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string()
                }).optional()
              })
            })
          }
        }
      },
      "400": {
        description: "Invalid request"
      },
      "409": {
        description: "User already exists"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { email, password, name, organization_name } = data.body;

    // Check if user already exists
    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).bind(email).first();

    if (existingUser) {
      return error(c, "USER_EXISTS", "User with this email already exists", 409);
    }

    // Generate user ID and password hash
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    // Start transaction
    try {
      // Create user - include issuer and access_sub with default values, email_verified as 0 (false)
      // Auto-grant admin to @clearlift.ai emails
      const isAdmin = email.toLowerCase().endsWith('@clearlift.ai') ? 1 : 0;
      await c.env.DB.prepare(`
        INSERT INTO users (id, email, name, password_hash, created_at, updated_at, issuer, access_sub, email_verified, is_admin)
        VALUES (?, ?, ?, ?, ?, ?, 'password', ?, 0, ?)
      `).bind(userId, email, name, passwordHash, now, now, userId, isAdmin).run();

      // Generate email verification token
      const verificationToken = crypto.randomUUID();
      const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await c.env.DB.prepare(`
        INSERT INTO email_verification_tokens (user_id, token, expires_at)
        VALUES (?, ?, ?)
      `).bind(userId, verificationToken, verificationExpiry.toISOString()).run();

      // Send verification email
      const emailService = createEmailService(c.env);
      await emailService.sendVerificationEmail(email, name, verificationToken);

      // Create organization if requested
      let organization = null;
      if (organization_name) {
        const orgId = crypto.randomUUID();
        const orgSlug = organization_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Ensure unique slug
        let finalSlug = orgSlug;
        let counter = 1;
        while (await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ?").bind(finalSlug).first()) {
          finalSlug = `${orgSlug}-${counter}`;
          counter++;
        }

        // Create organization
        await c.env.DB.prepare(`
          INSERT INTO organizations (id, name, slug, created_at, updated_at, subscription_tier)
          VALUES (?, ?, ?, ?, ?, 'free')
        `).bind(orgId, organization_name, finalSlug, now, now).run();

        // Add user as owner
        await c.env.DB.prepare(`
          INSERT INTO organization_members (organization_id, user_id, role, joined_at)
          VALUES (?, ?, 'owner', ?)
        `).bind(orgId, userId, now).run();

        // Generate org_tag from name (first 5 alphanumeric chars, with collision prevention)
        const baseTag = organization_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'org';
        let shortTag = baseTag;
        let tagCounter = 1;
        while (await c.env.DB.prepare("SELECT id FROM org_tag_mappings WHERE short_tag = ?").bind(shortTag).first()) {
          shortTag = `${baseTag}-${tagCounter}`;
          tagCounter++;
        }

        // Create org_tag_mapping for analytics
        const tagId = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO org_tag_mappings (id, organization_id, short_tag, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(tagId, orgId, shortTag, now).run();

        organization = {
          id: orgId,
          name: organization_name,
          slug: finalSlug
        };
        // AI recommendations are generated from real synced data via POST /v1/analysis/run
      }

      // Create session
      const sessionToken = generateSessionToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await c.env.DB.prepare(`
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(sessionToken, userId, expiresAt.toISOString(), now).run();

      return c.json({
        success: true,
        data: {
          user: {
            id: userId,
            email,
            name
          },
          session: {
            token: sessionToken,
            expires_at: expiresAt.toISOString()
          },
          organization
        }
      }, 201);

    } catch (err: any) {
      structuredLog('ERROR', 'Registration error', { endpoint: 'auth', step: 'register', error: err instanceof Error ? err.message : String(err), stack: err.stack });
      return error(c, "REGISTRATION_FAILED", `Failed to register user: ${err.message || 'Unknown error'}`, 500);
    }
  }
}

/**
 * POST /v1/auth/login - Login user
 */
export class Login extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Login user",
    operationId: "login",
    request: {
      body: contentJson(
        z.object({
          email: z.string().email().toLowerCase(),
          password: z.string()
        })
      )
    },
    responses: {
      "200": {
        description: "Login successful",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                user: z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string().nullable()
                }),
                session: z.object({
                  token: z.string(),
                  expires_at: z.string()
                }),
                organizations: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  role: z.string()
                }))
              })
            })
          }
        }
      },
      "401": {
        description: "Invalid credentials"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { email, password } = data.body;

    // Get user
    const user = await c.env.DB.prepare(`
      SELECT id, email, name, password_hash
      FROM users
      WHERE email = ?
    `).bind(email).first<{
      id: string;
      email: string;
      name: string | null;
      password_hash: string;
    }>();

    if (!user) {
      return error(c, "INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return error(c, "INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    // Update last login
    await c.env.DB.prepare(`
      UPDATE users SET last_login_at = ? WHERE id = ?
    `).bind(new Date().toISOString(), user.id).run();

    // Create new session
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await c.env.DB.prepare(`
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(sessionToken, user.id, expiresAt.toISOString(), new Date().toISOString()).run();

    // Get user's organizations
    const organizations = await c.env.DB.prepare(`
      SELECT o.id, o.name, o.slug, om.role
      FROM organizations o
      JOIN organization_members om ON o.id = om.organization_id
      WHERE om.user_id = ?
      ORDER BY om.joined_at ASC
    `).bind(user.id).all();

    return success(c, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      session: {
        token: sessionToken,
        expires_at: expiresAt.toISOString()
      },
      organizations: organizations.results || []
    });
  }
}

/**
 * POST /v1/auth/logout - Logout user
 */
export class Logout extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Logout user",
    operationId: "logout",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Logged out successfully"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    // Delete session
    await c.env.DB.prepare(
      "DELETE FROM sessions WHERE token = ?"
    ).bind(session.token).run();

    return success(c, { message: "Logged out successfully" });
  }
}

/**
 * POST /v1/auth/refresh - Refresh session token
 *
 * Security: Rotates session tokens to reduce the window for stolen tokens.
 * Only refreshes if the current session is more than 1 day old to prevent spam.
 * New sessions expire after 7 days (shorter window than initial 30-day login).
 */
export class RefreshSession extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Refresh session token",
    operationId: "refresh-session",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Session refreshed",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                session: z.object({
                  token: z.string(),
                  expires_at: z.string()
                })
              })
            })
          }
        }
      },
      "429": {
        description: "Session is too new to refresh (less than 1 day old)"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    // Look up the current session to check created_at
    const currentSession = await c.env.DB.prepare(
      "SELECT token, user_id, created_at, expires_at FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    ).bind(session.token).first<{
      token: string;
      user_id: string;
      created_at: string;
      expires_at: string;
    }>();

    if (!currentSession) {
      return error(c, "INVALID_SESSION", "Session not found or expired", 401);
    }

    // Only refresh if the session is more than 1 day old (prevent refresh spam)
    const sessionAge = Date.now() - new Date(currentSession.created_at).getTime();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (sessionAge < ONE_DAY_MS) {
      return success(c, {
        session: {
          token: currentSession.token,
          expires_at: currentSession.expires_at
        }
      });
    }

    // Generate new token and invalidate the old one
    const newToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const now = new Date().toISOString();

    // Delete old session
    await c.env.DB.prepare(
      "DELETE FROM sessions WHERE token = ?"
    ).bind(currentSession.token).run();

    // Create new session
    await c.env.DB.prepare(`
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(newToken, currentSession.user_id, expiresAt.toISOString(), now).run();

    return success(c, {
      session: {
        token: newToken,
        expires_at: expiresAt.toISOString()
      }
    });
  }
}

/**
 * POST /v1/auth/password-reset-request - Request password reset
 */
export class RequestPasswordReset extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Request password reset",
    operationId: "request-password-reset",
    request: {
      body: contentJson(
        z.object({
          email: z.string().email().toLowerCase()
        })
      )
    },
    responses: {
      "200": {
        description: "Password reset email sent (if user exists)"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { email } = data.body;

    // Always return success to prevent user enumeration
    // In production, this would send an email
    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).bind(email).first();

    if (user) {
      // Generate reset token
      const resetToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await c.env.DB.prepare(`
        INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(resetToken, user.id, expiresAt.toISOString(), new Date().toISOString()).run();

      // Get user name for email
      const userDetails = await c.env.DB.prepare(
        "SELECT name FROM users WHERE id = ?"
      ).bind(user.id).first<{ name: string }>();

      // Send password reset email
      const emailService = createEmailService(c.env);
      await emailService.sendPasswordResetEmail(
        email,
        userDetails?.name || 'User',
        resetToken
      );
    }

    return success(c, {
      message: "If an account exists with this email, a password reset link has been sent."
    });
  }
}

/**
 * POST /v1/auth/password-reset - Reset password with token
 */
export class ResetPassword extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Reset password",
    operationId: "reset-password",
    request: {
      body: contentJson(
        z.object({
          token: z.string().uuid(),
          new_password: z.string().min(8).max(128)
        })
      )
    },
    responses: {
      "200": {
        description: "Password reset successfully"
      },
      "400": {
        description: "Invalid or expired token"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { token, new_password } = data.body;

    // Verify token
    const resetToken = await c.env.DB.prepare(`
      SELECT user_id FROM password_reset_tokens
      WHERE token = ? AND expires_at > datetime('now') AND used = 0
    `).bind(token).first<{ user_id: string }>();

    if (!resetToken) {
      return error(c, "INVALID_TOKEN", "Invalid or expired reset token", 400);
    }

    // Hash new password
    const passwordHash = await hashPassword(new_password);

    // Update password
    await c.env.DB.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `).bind(passwordHash, new Date().toISOString(), resetToken.user_id).run();

    // Mark token as used
    await c.env.DB.prepare(`
      UPDATE password_reset_tokens SET used = 1, used_at = ?
      WHERE token = ?
    `).bind(new Date().toISOString(), token).run();

    // Delete all sessions for security
    await c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?"
    ).bind(resetToken.user_id).run();

    // Get user details for confirmation email
    const userDetails = await c.env.DB.prepare(
      "SELECT email, name FROM users WHERE id = ?"
    ).bind(resetToken.user_id).first<{ email: string; name: string }>();

    // Send confirmation email
    if (userDetails) {
      const emailService = createEmailService(c.env);
      await emailService.sendPasswordResetConfirmation(
        userDetails.email,
        userDetails.name || 'User'
      );
    }

    return success(c, { message: "Password reset successfully. Please login with your new password." });
  }
}

/**
 * POST /v1/auth/verify-email - Verify email with token
 */
export class VerifyEmail extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Verify email address",
    operationId: "verify-email",
    request: {
      body: contentJson(
        z.object({
          token: z.string().uuid()
        })
      )
    },
    responses: {
      "200": {
        description: "Email verified successfully"
      },
      "400": {
        description: "Invalid or expired token"
      }
    }
  };

  public async handle(c: AppContext) {
    const body = await c.req.json();
    const { token } = body;

    if (!token) {
      return error(c, "MISSING_TOKEN", "Verification token is required", 400);
    }

    // Verify token and get user
    const verificationToken = await c.env.DB.prepare(`
      SELECT vt.user_id, vt.expires_at, vt.used, u.email, u.name
      FROM email_verification_tokens vt
      JOIN users u ON vt.user_id = u.id
      WHERE vt.token = ?
    `).bind(token).first<{
      user_id: string;
      expires_at: string;
      used: number;
      email: string;
      name: string;
    }>();

    if (!verificationToken) {
      return error(c, "INVALID_TOKEN", "Invalid verification token", 400);
    }

    if (verificationToken.used) {
      return error(c, "TOKEN_USED", "This verification token has already been used", 400);
    }

    if (new Date(verificationToken.expires_at) < new Date()) {
      return error(c, "TOKEN_EXPIRED", "This verification token has expired", 400);
    }

    const now = new Date().toISOString();

    // Mark email as verified
    await c.env.DB.prepare(`
      UPDATE users
      SET email_verified = 1, email_verified_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(now, now, verificationToken.user_id).run();

    // Mark token as used
    await c.env.DB.prepare(`
      UPDATE email_verification_tokens
      SET used = 1, used_at = ?
      WHERE token = ?
    `).bind(now, token).run();

    return success(c, {
      message: "Email verified successfully",
      user: {
        email: verificationToken.email,
        name: verificationToken.name
      }
    });
  }
}

/**
 * DELETE /v1/user/me - Delete user account and all associated data
 */
export class DeleteAccount extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Delete user account and all associated data",
    operationId: "delete-account",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          confirmation: z.literal("DELETE").describe("Must be the string 'DELETE' to confirm")
        })
      )
    },
    responses: {
      "200": {
        description: "Account deleted successfully"
      },
      "400": {
        description: "Invalid confirmation"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { confirmation } = data.body;

    if (confirmation !== "DELETE") {
      return error(c, "INVALID_CONFIRMATION", "You must type 'DELETE' to confirm account deletion", 400);
    }

    const session = c.get("session");
    const userId = session.user_id;

    try {
      // OPTIMIZED: Single query gets memberships with member counts using window function
      // This replaces N+1 queries with a single query
      const memberships = await c.env.DB.prepare(`
        SELECT
          om.organization_id,
          COUNT(*) OVER (PARTITION BY om.organization_id) as member_count
        FROM organization_members om
        WHERE om.user_id = ?
      `).bind(userId).all<{ organization_id: string; member_count: number }>();

      const orgsToDelete: string[] = [];
      const orgsToLeave: string[] = [];

      for (const membership of memberships.results || []) {
        if (membership.member_count <= 1) {
          orgsToDelete.push(membership.organization_id);
        } else {
          orgsToLeave.push(membership.organization_id);
        }
      }

      // OPTIMIZED: Batch delete org data using IN clauses and db.batch()
      if (orgsToDelete.length > 0) {
        const orgPlaceholders = orgsToDelete.map(() => '?').join(', ');

        // Get all connection IDs for all orgs to delete in one query
        const connections = await c.env.DB.prepare(`
          SELECT id FROM platform_connections WHERE organization_id IN (${orgPlaceholders})
        `).bind(...orgsToDelete).all<{ id: string }>();

        const batchStatements: D1PreparedStatement[] = [];

        // Delete connector_filter_rules for all connections at once
        if (connections.results && connections.results.length > 0) {
          const connPlaceholders = connections.results.map(() => '?').join(', ');
          batchStatements.push(
            c.env.DB.prepare(`
              DELETE FROM connector_filter_rules WHERE connection_id IN (${connPlaceholders})
            `).bind(...connections.results.map(c => c.id))
          );
        }

        // Delete from all org tables using IN clause
        const orgTables = [
          'platform_connections',
          'sync_jobs',
          'org_tag_mappings',
          'org_tracking_configs',
          'consent_configurations',
          'ai_optimization_settings',
          'conversion_goals',
          'tracking_domains',
          'identity_mappings',
          'identity_merges',
          'onboarding_progress',
          // Note: onboarding_steps is a global reference table with no organization_id
          'invitations',
          'organization_members',
        ];

        for (const table of orgTables) {
          batchStatements.push(
            c.env.DB.prepare(`
              DELETE FROM ${table} WHERE organization_id IN (${orgPlaceholders})
            `).bind(...orgsToDelete)
          );
        }

        // Delete the organizations themselves
        batchStatements.push(
          c.env.DB.prepare(`
            DELETE FROM organizations WHERE id IN (${orgPlaceholders})
          `).bind(...orgsToDelete)
        );

        // Execute all org deletions in a single batch
        await c.env.DB.batch(batchStatements);
      }

      // OPTIMIZED: Batch leave multiple orgs
      if (orgsToLeave.length > 0) {
        const leavePlaceholders = orgsToLeave.map(() => '?').join(', ');
        await c.env.DB.prepare(`
          DELETE FROM organization_members WHERE organization_id IN (${leavePlaceholders}) AND user_id = ?
        `).bind(...orgsToLeave, userId).run();
      }

      // OPTIMIZED: Batch delete user data with single db.batch() call
      const userBatchStatements: D1PreparedStatement[] = [
        c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        c.env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').bind(userId),
        c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(userId),
        c.env.DB.prepare('DELETE FROM oauth_states WHERE user_id = ?').bind(userId),
        c.env.DB.prepare('DELETE FROM onboarding_progress WHERE user_id = ?').bind(userId),
        c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      ];

      await c.env.DB.batch(userBatchStatements);

      // Note: Synced data (campaigns, metrics in D1) becomes orphaned
      // but will be cleaned up by a separate maintenance job

      return success(c, {
        message: "Account deleted successfully",
        deleted: {
          organizations_deleted: orgsToDelete.length,
          organizations_left: orgsToLeave.length
        }
      });

    } catch (err: any) {
      structuredLog('ERROR', 'Account deletion error', { endpoint: 'auth', step: 'delete_account', error: err instanceof Error ? err.message : String(err) });
      return error(c, "DELETION_FAILED", `Failed to delete account: ${err.message || 'Unknown error'}`, 500);
    }
  }
}

/**
 * POST /v1/auth/resend-verification - Resend verification email
 */
export class ResendVerification extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Resend verification email",
    operationId: "resend-verification",
    request: {
      body: contentJson(
        z.object({
          email: z.string().email().toLowerCase()
        })
      )
    },
    responses: {
      "200": {
        description: "Verification email sent (if account exists)"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { email } = data.body;

    // Always return success to prevent user enumeration
    const user = await c.env.DB.prepare(`
      SELECT id, name, email_verified
      FROM users
      WHERE email = ?
    `).bind(email).first<{
      id: string;
      name: string;
      email_verified: number;
    }>();

    if (user && !user.email_verified) {
      // Check if there's an existing valid token
      const existingToken = await c.env.DB.prepare(`
        SELECT token FROM email_verification_tokens
        WHERE user_id = ? AND expires_at > datetime('now') AND used = 0
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(user.id).first<{ token: string }>();

      let verificationToken: string;

      if (existingToken) {
        // Reuse existing token
        verificationToken = existingToken.token;
      } else {
        // Generate new token
        verificationToken = crypto.randomUUID();
        const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await c.env.DB.prepare(`
          INSERT INTO email_verification_tokens (user_id, token, expires_at)
          VALUES (?, ?, ?)
        `).bind(user.id, verificationToken, verificationExpiry.toISOString()).run();
      }

      // Send verification email
      const emailService = createEmailService(c.env);
      await emailService.sendVerificationEmail(email, user.name, verificationToken);
    }

    return success(c, {
      message: "If an unverified account exists with this email, a verification email has been sent."
    });
  }
}