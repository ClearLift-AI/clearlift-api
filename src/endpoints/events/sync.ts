import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { EventAnalyticsService, ConversionEvent } from "../../services/eventAnalytics";
import { EventValidator } from "../../utils/eventValidator";

export class SyncEvents extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/sync",
  security: "session",
  summary: "Sync events to R2 Data Catalog",
  description: "Write conversion events to R2 as Iceberg tables via DuckLake",
  request: {
    body: contentJson(z.object({
      events: z.array(z.object({
        id: z.string(),
        organization_id: z.string(),
        event_id: z.string(),
        timestamp: z.string(),
        event_type: z.string(),
        event_value: z.number(),
        currency: z.string(),
        user_id: z.string(),
        session_id: z.string(),
        utm_source: z.string().optional(),
        utm_medium: z.string().optional(),
        utm_campaign: z.string().optional(),
        device_type: z.string().optional(),
        browser: z.string().optional(),
        country: z.string().optional(),
        attribution_path: z.string().optional()
      })).describe("Array of conversion events to sync"),
      organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)")
    }))
  },
  responses: {
    200: {
      description: "Events synced successfully",
      ...contentJson(z.object({
        success: z.boolean(),
        events_synced: z.number(),
        message: z.string()
      }))
    },
    400: {
      description: "Invalid request",
      ...contentJson(z.object({
        error: z.string()
      }))
    },
    503: {
      description: "Service unavailable",
      ...contentJson(z.object({
        error: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  try {
    const body = await c.req.json();
    const { events, organization_id, validate_only = false } = body;
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    if (!events || events.length === 0) {
      return c.json({ error: 'No events provided' }, 400);
    }
    
    // Validate and normalize events
    const validation = EventValidator.validateEvents(events, orgId);
    
    if (!validation.valid) {
      return c.json({
        error: 'Some events failed validation',
        details: {
          valid_events: validation.validEvents.length,
          invalid_events: validation.invalidEvents.length,
          errors: validation.errors.slice(0, 10) // Limit errors returned
        }
      }, 400);
    }
    
    // If validate only mode, return validation results
    if (validate_only) {
      return c.json({
        success: true,
        valid_events: validation.validEvents.length,
        message: 'Events validated successfully'
      });
    }
    
    // Check if DUCKLAKE container binding exists
    if (!c.env.DUCKLAKE) {
      return c.json({ 
        error: 'DuckLake container not configured. Cannot sync events to R2 Data Catalog.' 
      }, 503);
    }
    
    const analyticsService = new EventAnalyticsService(c.env.DUCKLAKE, orgId);
    
    // Write validated events to R2 via DuckLake
    await analyticsService.writeConversionEvents(validation.validEvents);
    
    return c.json({
      success: true,
      events_synced: validation.validEvents.length,
      message: `Successfully synced ${validation.validEvents.length} events to R2 Data Catalog`
    });
  } catch (error) {
    console.error('Sync events error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to sync events' 
    }, 500);
  }
  }
}