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
    // Parse body manually for debugging
    let body;
    try {
      body = await c.req.json();
    } catch (e) {
      return error(c, "INVALID_JSON", "Invalid JSON in request body", 400);
    }

    // Validate manually for now
    const { email, password, name, organization_name } = body;

    if (!email || !password || !name) {
      return error(c, "MISSING_FIELDS", "Email, password, and name are required", 400);
    }

    if (password.length < 8) {
      return error(c, "WEAK_PASSWORD", "Password must be at least 8 characters", 400);
    }

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
      await c.env.DB.prepare(`
        INSERT INTO users (id, email, name, password_hash, created_at, updated_at, issuer, access_sub, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, 'password', ?, 0)
      `).bind(userId, email, name, passwordHash, now, now, userId).run();

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

        // Create org_tag_mapping for analytics
        const shortTag = crypto.randomUUID().slice(0, 6);
        await c.env.DB.prepare(`
          INSERT INTO org_tag_mappings (organization_id, short_tag, created_at)
          VALUES (?, ?, ?)
        `).bind(orgId, shortTag, now).run();

        organization = {
          id: orgId,
          name: organization_name,
          slug: finalSlug
        };
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
      console.error("Registration error:", err);
      console.error("Error details:", err.message, err.stack);
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
    // Parse body manually
    let body;
    try {
      body = await c.req.json();
    } catch (e) {
      return error(c, "INVALID_JSON", "Invalid JSON in request body", 400);
    }

    const { email, password } = body;

    if (!email || !password) {
      return error(c, "MISSING_FIELDS", "Email and password are required", 400);
    }

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
 * POST /v1/auth/refresh - Refresh session
 */
export class RefreshSession extends OpenAPIRoute {
  public schema = {
    tags: ["Authentication"],
    summary: "Refresh session",
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
      }
    }
  };

  public async handle(c: AppContext) {
    const oldSession = c.get("session");

    // Delete old session
    await c.env.DB.prepare(
      "DELETE FROM sessions WHERE token = ?"
    ).bind(oldSession.token).run();

    // Create new session
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await c.env.DB.prepare(`
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(sessionToken, oldSession.user_id, expiresAt.toISOString(), new Date().toISOString()).run();

    return success(c, {
      session: {
        token: sessionToken,
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
    const body = await c.req.json();
    const {email } = data.body;

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
    const body = await c.req.json();
    const {token, new_password } = data.body;

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
    const body = await c.req.json();
    const { email } = body;

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