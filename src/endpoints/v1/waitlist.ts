/**
 * Waitlist Endpoint
 *
 * Handles waitlist signups from the marketing site
 */

import { OpenAPIRoute, Query, Str } from 'chanfana';
import { Context } from 'hono';
import { z } from 'zod';
import { createEmailService } from '../../utils/email';
import { createSuccessResponse, createErrorResponse } from '../../utils/response';

// SHA-256 hash utility for IP addresses
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Request schema
const WaitlistSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().optional(),
  phone: z.string().optional(),
  source: z.string().optional(),
  utm: z.record(z.string()).optional(),
  ref: z.string().optional(), // Referrer ID
});

export class JoinWaitlist extends OpenAPIRoute {
  schema = {
    tags: ['Waitlist'],
    summary: 'Join the waitlist',
    description: 'Add an email to the pre-launch waitlist',
    request: {
      body: {
        content: {
          'application/json': {
            schema: WaitlistSchema,
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Successfully joined waitlist',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              message: z.string(),
              data: z.object({
                id: z.string(),
                email: z.string(),
              }),
            }),
          },
        },
      },
      '400': {
        description: 'Invalid input',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              error: z.string(),
            }),
          },
        },
      },
      '500': {
        description: 'Server error',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              error: z.string(),
            }),
          },
        },
      },
    },
  };

  async handle(c: Context) {
    try {
      // Parse and validate request body
      const body = await this.getValidatedData<typeof WaitlistSchema>();

      const { email, name, phone, source, utm, ref } = body.data;

      // Get metadata
      const ip = c.req.header('CF-Connecting-IP');
      const userAgent = c.req.header('User-Agent') || '';
      const origin = c.req.header('Origin') || '';

      // Generate ID and timestamps
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      // Hash IP for privacy
      const ipHash = ip ? await sha256(ip) : null;

      // Prepare database insert
      const stmt = `
        INSERT INTO waitlist
          (id, email, name, phone, source, utm, referrer_id, ip_hash, user_agent, status, created_at, updated_at)
        VALUES
          (?1, LOWER(?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)
        ON CONFLICT(email) DO UPDATE SET
          name = COALESCE(excluded.name, waitlist.name),
          phone = COALESCE(excluded.phone, waitlist.phone),
          source = COALESCE(excluded.source, waitlist.source),
          utm = COALESCE(excluded.utm, waitlist.utm),
          referrer_id = COALESCE(excluded.referrer_id, waitlist.referrer_id),
          ip_hash = COALESCE(excluded.ip_hash, waitlist.ip_hash),
          user_agent = COALESCE(excluded.user_agent, waitlist.user_agent),
          updated_at = excluded.updated_at
        RETURNING id, email, created_at
      `;

      // Insert into database
      const result = await c.env.DB.prepare(stmt)
        .bind(
          id,
          email,
          name || null,
          phone || null,
          source || origin || null,
          utm ? JSON.stringify(utm) : null,
          ref || null,
          ipHash,
          userAgent,
          now
        )
        .first();

      if (!result) {
        throw new Error('Failed to insert into database');
      }

      // Send welcome email (don't wait for it, fire and forget to improve response time)
      const emailService = createEmailService(c.env);
      emailService.sendWaitlistWelcome(email, name).catch(err => {
        console.error('Failed to send waitlist welcome email:', err);
        // Don't fail the request if email fails
      });

      return createSuccessResponse(
        {
          id: result.id,
          email: result.email,
        },
        'Successfully joined the waitlist!'
      );

    } catch (error: any) {
      console.error('Waitlist signup error:', error);

      if (error.message?.includes('validation')) {
        return createErrorResponse(error.message, 400);
      }

      return createErrorResponse(
        'Failed to join waitlist. Please try again.',
        500
      );
    }
  }
}

export class GetWaitlistStats extends OpenAPIRoute {
  schema = {
    tags: ['Waitlist'],
    summary: 'Get waitlist statistics',
    description: 'Get basic statistics about the waitlist (public endpoint)',
    responses: {
      '200': {
        description: 'Waitlist statistics',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                total: z.number(),
                thisWeek: z.number(),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: Context) {
    try {
      // Get total count
      const totalResult = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM waitlist'
      ).first<{ count: number }>();

      // Get count from last 7 days
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const weekResult = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM waitlist WHERE created_at > ?'
      ).bind(weekAgo).first<{ count: number }>();

      return createSuccessResponse({
        total: totalResult?.count || 0,
        thisWeek: weekResult?.count || 0,
      });

    } catch (error: any) {
      console.error('Waitlist stats error:', error);
      return createErrorResponse('Failed to get waitlist stats', 500);
    }
  }
}
