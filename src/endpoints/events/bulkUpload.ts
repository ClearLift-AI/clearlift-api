import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { MotherDuckService } from "../../services/motherDuckService";
import { EventParser } from "../../utils/eventParser";
import { EventValidator } from "../../utils/eventValidator";

export class BulkUploadEvents extends OpenAPIRoute {
  schema = {
    method: "POST",
    path: "/bulk-upload",
    security: "session",
    summary: "Bulk upload events from file",
    description: "Upload CSV, JSON, or JSONL file containing conversion events",
    request: {
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.any().describe("File containing events (CSV, JSON, or JSONL)"),
              organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)"),
              format: z.enum(['auto', 'csv', 'json', 'jsonl']).optional().default('auto').describe("File format"),
              validate_only: z.boolean().optional().default(false).describe("Only validate without uploading"),
              batch_size: z.number().optional().default(1000).describe("Batch size for processing")
            })
          }
        }
      }
    },
    responses: {
      200: {
        description: "Upload successful",
        ...contentJson(z.object({
          success: z.boolean(),
          total_events: z.number(),
          valid_events: z.number(),
          invalid_events: z.number(),
          batches_processed: z.number(),
          errors: z.array(z.string()).optional(),
          validation_errors: z.array(z.object({
            event: z.any(),
            error: z.string()
          })).optional()
        }))
      },
      400: {
        description: "Invalid request",
        ...contentJson(z.object({
          error: z.string(),
          details: z.any().optional()
        }))
      },
      413: {
        description: "File too large",
        ...contentJson(z.object({
          error: z.string(),
          max_size: z.string()
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
      // Parse multipart form data
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      const organizationId = formData.get('organization_id') as string || c.get('organizationId');
      const format = (formData.get('format') as string) || 'auto';
      const validateOnly = formData.get('validate_only') === 'true';
      const batchSize = parseInt(formData.get('batch_size') as string) || 1000;

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      if (!organizationId) {
        return c.json({ error: 'Organization ID is required' }, 400);
      }

      // Check file size (max 10MB)
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        return c.json({
          error: 'File too large',
          max_size: '10MB'
        }, 413);
      }

      // Read file content
      const content = await file.text();

      // Parse events based on format
      const events = EventParser.parse(content, {
        organizationId,
        format: format as any,
        batchSize
      });

      if (events.length === 0) {
        return c.json({ error: 'No valid events found in file' }, 400);
      }

      // Validate events
      const validation = EventValidator.validateBatch(events, organizationId, batchSize);

      // If validate only, return validation results
      if (validateOnly) {
        return c.json({
          success: validation.errors.length === 0,
          total_events: events.length,
          valid_events: validation.batches.reduce((sum, batch) => sum + batch.length, 0),
          invalid_events: validation.errors.length,
          batches_processed: 0,
          errors: validation.errors.slice(0, 100), // Limit errors returned
        });
      }

      // Check if MotherDuck token exists
      if (!c.env.MOTHERDUCK_TOKEN) {
        return c.json({
          error: 'MotherDuck not configured. Cannot upload events.'
        }, 503);
      }

      // Process batches
      const motherDuckService = new MotherDuckService({
        token: c.env.MOTHERDUCK_TOKEN
      });
      let batchesProcessed = 0;
      const processingErrors: string[] = [];

      for (const batch of validation.batches) {
        try {
          await motherDuckService.writeConversionEvents(batch);
          batchesProcessed++;
        } catch (error) {
          processingErrors.push(`Batch ${batchesProcessed + 1}: ${error.message}`);
          // Continue processing other batches
        }
      }

      // Return results
      return c.json({
        success: processingErrors.length === 0,
        total_events: events.length,
        valid_events: validation.batches.reduce((sum, batch) => sum + batch.length, 0),
        invalid_events: validation.errors.length,
        batches_processed: batchesProcessed,
        errors: [...validation.errors.slice(0, 50), ...processingErrors.slice(0, 50)],
      });

    } catch (error) {
      console.error('Bulk upload error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to process upload',
        details: error
      }, 500);
    }
  }
}