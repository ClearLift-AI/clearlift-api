import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { EventGenerator } from "../../utils/eventGenerator";
import { EventParser } from "../../utils/eventParser";
import { EventAnalyticsService } from "../../services/eventAnalytics";

export class GenerateEvents extends OpenAPIRoute {
  schema = {
    method: "POST",
    path: "/generate",
    security: "session",
    summary: "Generate sample event data",
    description: "Generate realistic conversion event data for testing",
    request: {
      body: contentJson(z.object({
        count: z.number().min(1).max(10000).default(100).describe("Number of events to generate"),
        organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)"),
        days: z.number().min(1).max(365).default(30).describe("Number of days of data to generate"),
        event_types: z.array(z.string()).optional().describe("Event types to include"),
        include_journeys: z.boolean().default(false).describe("Generate realistic user journeys"),
        format: z.enum(['json', 'csv', 'jsonl']).default('json').describe("Output format"),
        auto_upload: z.boolean().default(false).describe("Automatically upload generated data"),
        seed: z.number().optional().describe("Random seed for reproducible data")
      }))
    },
    responses: {
      200: {
        description: "Events generated successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              count: z.number(),
              format: z.string(),
              uploaded: z.boolean(),
              data: z.any().optional().describe("Generated events (if not auto-uploaded)"),
              download_url: z.string().optional().describe("URL to download the data")
            })
          },
          "text/csv": {
            schema: z.string().describe("CSV formatted events")
          },
          "application/x-ndjson": {
            schema: z.string().describe("JSONL formatted events")
          }
        }
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
      const {
        count = 100,
        organization_id,
        days = 30,
        event_types,
        include_journeys = false,
        format = 'json',
        auto_upload = false,
        seed
      } = body;

      // Get organization ID from session if not provided
      const orgId = organization_id || c.get('organizationId');
      
      if (!orgId) {
        return c.json({ error: 'Organization ID is required' }, 400);
      }

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Generate events
      const events = EventGenerator.generateSampleData({
        organizationId: orgId,
        count,
        startDate,
        endDate,
        eventTypes: event_types,
        includeJourneys: include_journeys,
        seed
      });

      // If auto-upload is enabled, upload to R2
      if (auto_upload) {
        if (!c.env.DUCKLAKE) {
          return c.json({
            error: 'DuckLake container not configured. Cannot auto-upload events.'
          }, 503);
        }

        try {
          const analyticsService = new EventAnalyticsService(c.env.DUCKLAKE, orgId);
          await analyticsService.writeConversionEvents(events);

          return c.json({
            success: true,
            count: events.length,
            format,
            uploaded: true,
            message: `Successfully generated and uploaded ${events.length} events`
          });
        } catch (error) {
          return c.json({
            error: `Failed to upload generated events: ${error.message}`
          }, 500);
        }
      }

      // Format the response based on requested format
      let responseData: string;
      let contentType: string;

      switch (format) {
        case 'csv':
          responseData = EventParser.toCSV(events);
          contentType = 'text/csv';
          break;
        case 'jsonl':
          responseData = EventParser.toJSONL(events);
          contentType = 'application/x-ndjson';
          break;
        case 'json':
        default:
          // For JSON, return structured response with data
          return c.json({
            success: true,
            count: events.length,
            format: 'json',
            uploaded: false,
            data: events
          });
      }

      // For CSV and JSONL, return raw data with appropriate content type
      return new Response(responseData, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="generated_events_${Date.now()}.${format}"`
        }
      });

    } catch (error) {
      console.error('Generate events error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to generate events'
      }, 500);
    }
  }
}

export class GenerateEventsSimple extends OpenAPIRoute {
  schema = {
    method: "GET",
    path: "/generate",
    security: "session",
    summary: "Generate sample events (simple)",
    description: "Simple GET endpoint to generate sample events with query parameters",
    request: {
      query: z.object({
        count: z.string().optional().describe("Number of events (default: 100)"),
        days: z.string().optional().describe("Number of days (default: 30)"),
        format: z.enum(['json', 'csv', 'jsonl']).optional().describe("Output format (default: json)"),
        journeys: z.string().optional().describe("Include journeys (true/false)"),
        organization_id: z.string().optional().describe("Organization ID")
      })
    },
    responses: {
      200: {
        description: "Events generated",
        content: {
          "application/json": {
            schema: z.any()
          },
          "text/csv": {
            schema: z.string()
          }
        }
      }
    }
  }

  async handle(c: AppContext) {
    try {
      const query = c.req.query();
      const count = parseInt(query.count || '100');
      const days = parseInt(query.days || '30');
      const format = query.format || 'json';
      const includeJourneys = query.journeys === 'true';
      const orgId = query.organization_id || c.get('organizationId');

      if (!orgId) {
        return c.json({ error: 'Organization ID is required' }, 400);
      }

      const endDate = new Date();
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const events = EventGenerator.generateSampleData({
        organizationId: orgId,
        count,
        startDate,
        endDate,
        includeJourneys
      });

      switch (format) {
        case 'csv':
          return new Response(EventParser.toCSV(events), {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="events.csv"`
            }
          });
        case 'jsonl':
          return new Response(EventParser.toJSONL(events), {
            headers: {
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': `attachment; filename="events.jsonl"`
            }
          });
        default:
          return c.json(events);
      }
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  }
}