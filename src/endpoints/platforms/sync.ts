import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";

export class SyncPlatform extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/sync",
  security: "session",
  summary: "Trigger platform data sync",
  description: "Initiate data synchronization for a specific platform",
  request: {
    body: contentJson(z.object({
      platform: z.enum(['google-ads', 'meta-ads', 'tiktok-ads']).describe("Platform to sync"),
      date_from: z.string().optional().describe("Start date for sync (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date for sync (YYYY-MM-DD)"),
      sync_type: z.enum(['full', 'incremental']).optional().default('incremental')
    }))
  },
  responses: {
    200: {
      description: "Sync initiated successfully",
      ...contentJson(z.object({
        success: z.boolean(),
        sync_id: z.number(),
        message: z.string()
      }))
    },
    404: {
      description: "Platform not connected",
      ...contentJson(z.object({
        error: z.string(),
        message: z.string()
      }))
    },
    409: {
      description: "Sync already in progress",
      ...contentJson(z.object({
        error: z.string(),
        message: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ 
      error: 'No organization selected',
      message: 'Please select an organization first' 
    }, 400);
  }

  const { platform, date_from, date_to, sync_type } = await c.req.json();

  try {
    // Check if platform is connected
    const platformAccount = await c.env.AD_DATA.prepare(`
      SELECT id, account_id, sync_status 
      FROM platform_accounts
      WHERE organization_id = ? AND platform = ?
    `).bind(organizationId, platform).first();

    if (!platformAccount) {
      return c.json({
        error: 'Platform not connected',
        message: `${platform} is not connected to this organization. Please connect your advertising account first.`
      }, 404);
    }

    // Check if there's already a sync in progress
    const activeSync = await c.env.AD_DATA.prepare(`
      SELECT id, started_at 
      FROM sync_history
      WHERE organization_id = ? 
        AND platform = ? 
        AND status = 'running'
        AND started_at > datetime('now', '-1 hour')
    `).bind(organizationId, platform).first();

    if (activeSync) {
      return c.json({
        error: 'Sync already in progress',
        message: `A sync for ${platform} is already running. Please wait for it to complete.`
      }, 409);
    }

    // Create sync history record
    const syncResult = await c.env.AD_DATA.prepare(`
      INSERT INTO sync_history (
        organization_id,
        platform,
        sync_type,
        status,
        date_from,
        date_to,
        started_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))
    `).bind(
      organizationId,
      platform,
      sync_type,
      date_from || null,
      date_to || null
    ).run();

    const syncId = syncResult.meta.last_row_id;

    // In production, this would trigger an actual sync job
    // For now, we just record the sync request
    
    // Update platform last sync attempt
    await c.env.AD_DATA.prepare(`
      UPDATE platform_accounts
      SET last_synced_at = datetime('now')
      WHERE organization_id = ? AND platform = ?
    `).bind(organizationId, platform).run();

    return c.json({
      success: true,
      sync_id: syncId as number,
      message: `Sync initiated for ${platform}. Check sync history for status.`
    });

  } catch (error) {
    console.error('Platform sync error:', error);
    return c.json({ 
      error: 'Sync initiation failed',
      message: error instanceof Error ? error.message : 'Failed to initiate platform sync'
    }, 500);
  }
  }
}