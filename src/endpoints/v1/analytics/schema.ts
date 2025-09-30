import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success } from "../../../utils/response";

/**
 * Event schema definition - 60 fields from R2 Data Catalog
 */
const EVENT_SCHEMA = {
  namespace: "clearlift",
  table: "events",
  fields: [
    // Core identification
    {
      name: "org_tag",
      type: "string",
      required: true,
      description: "Organization identifier for multi-tenant partitioning"
    },
    {
      name: "timestamp",
      type: "timestamp",
      required: true,
      description: "Event timestamp (ISO 8601)"
    },
    {
      name: "sessionId",
      type: "string",
      required: true,
      description: "User session identifier"
    },
    {
      name: "userId",
      type: "string",
      required: false,
      description: "User identifier (if authenticated)"
    },
    {
      name: "eventType",
      type: "string",
      required: true,
      description: "Type of event (page_view, click, form_submit, conversion, etc.)"
    },

    // Event data
    {
      name: "eventData",
      type: "json",
      required: false,
      description: "Event-specific structured data"
    },
    {
      name: "eventValue",
      type: "number",
      required: false,
      description: "Monetary value associated with event"
    },
    {
      name: "eventCurrency",
      type: "string",
      required: false,
      description: "Currency code (USD, EUR, etc.)"
    },

    // Page context
    {
      name: "pageUrl",
      type: "string",
      required: false,
      description: "Full page URL"
    },
    {
      name: "pageTitle",
      type: "string",
      required: false,
      description: "Page title"
    },
    {
      name: "pagePath",
      type: "string",
      required: false,
      description: "URL path component"
    },
    {
      name: "pageHostname",
      type: "string",
      required: false,
      description: "Page hostname"
    },
    {
      name: "pageReferrer",
      type: "string",
      required: false,
      description: "Referrer URL"
    },

    // Device/Browser info
    {
      name: "deviceBrowser",
      type: "string",
      required: false,
      description: "Browser name (Chrome, Firefox, Safari, etc.)"
    },
    {
      name: "deviceBrowserVersion",
      type: "string",
      required: false,
      description: "Browser version"
    },
    {
      name: "deviceType",
      type: "string",
      required: false,
      description: "Device type (desktop, mobile, tablet)"
    },
    {
      name: "deviceOs",
      type: "string",
      required: false,
      description: "Operating system"
    },
    {
      name: "deviceOsVersion",
      type: "string",
      required: false,
      description: "OS version"
    },
    {
      name: "deviceViewport",
      type: "string",
      required: false,
      description: "Viewport dimensions (e.g., 1920x1080)"
    },
    {
      name: "deviceLanguage",
      type: "string",
      required: false,
      description: "Browser language code"
    },
    {
      name: "deviceTimezone",
      type: "string",
      required: false,
      description: "Timezone identifier"
    },

    // UTM parameters
    {
      name: "utmSource",
      type: "string",
      required: false,
      description: "UTM source parameter"
    },
    {
      name: "utmMedium",
      type: "string",
      required: false,
      description: "UTM medium parameter"
    },
    {
      name: "utmCampaign",
      type: "string",
      required: false,
      description: "UTM campaign parameter"
    },
    {
      name: "utmTerm",
      type: "string",
      required: false,
      description: "UTM term parameter"
    },
    {
      name: "utmContent",
      type: "string",
      required: false,
      description: "UTM content parameter"
    },

    // Geographic data
    {
      name: "geoCountry",
      type: "string",
      required: false,
      description: "Country code (ISO 3166-1 alpha-2)"
    },
    {
      name: "geoRegion",
      type: "string",
      required: false,
      description: "Region/state"
    },
    {
      name: "geoCity",
      type: "string",
      required: false,
      description: "City name"
    },
    {
      name: "geoLatitude",
      type: "number",
      required: false,
      description: "Latitude coordinate"
    },
    {
      name: "geoLongitude",
      type: "number",
      required: false,
      description: "Longitude coordinate"
    },

    // Network data
    {
      name: "ipAddress",
      type: "string",
      required: false,
      description: "IP address (anonymized)"
    },
    {
      name: "userAgent",
      type: "string",
      required: false,
      description: "Raw user agent string"
    },

    // Element interaction data
    {
      name: "elementId",
      type: "string",
      required: false,
      description: "HTML element ID (for click events)"
    },
    {
      name: "elementClass",
      type: "string",
      required: false,
      description: "HTML element class names"
    },
    {
      name: "elementText",
      type: "string",
      required: false,
      description: "Element text content"
    },
    {
      name: "elementTag",
      type: "string",
      required: false,
      description: "HTML tag name (div, button, a, etc.)"
    },

    // Form data
    {
      name: "formId",
      type: "string",
      required: false,
      description: "Form element ID"
    },
    {
      name: "formName",
      type: "string",
      required: false,
      description: "Form name attribute"
    },
    {
      name: "formFields",
      type: "json",
      required: false,
      description: "Form field names (no PII values)"
    },

    // E-commerce data
    {
      name: "transactionId",
      type: "string",
      required: false,
      description: "Transaction/order identifier"
    },
    {
      name: "transactionRevenue",
      type: "number",
      required: false,
      description: "Transaction revenue"
    },
    {
      name: "transactionTax",
      type: "number",
      required: false,
      description: "Transaction tax amount"
    },
    {
      name: "transactionShipping",
      type: "number",
      required: false,
      description: "Shipping cost"
    },
    {
      name: "productSku",
      type: "string",
      required: false,
      description: "Product SKU"
    },
    {
      name: "productName",
      type: "string",
      required: false,
      description: "Product name"
    },
    {
      name: "productCategory",
      type: "string",
      required: false,
      description: "Product category"
    },
    {
      name: "productQuantity",
      type: "number",
      required: false,
      description: "Product quantity"
    },
    {
      name: "productPrice",
      type: "number",
      required: false,
      description: "Product unit price"
    },

    // Attribution
    {
      name: "firstTouchSource",
      type: "string",
      required: false,
      description: "First touch attribution source"
    },
    {
      name: "firstTouchMedium",
      type: "string",
      required: false,
      description: "First touch attribution medium"
    },
    {
      name: "firstTouchCampaign",
      type: "string",
      required: false,
      description: "First touch attribution campaign"
    },
    {
      name: "lastTouchSource",
      type: "string",
      required: false,
      description: "Last touch attribution source"
    },
    {
      name: "lastTouchMedium",
      type: "string",
      required: false,
      description: "Last touch attribution medium"
    },
    {
      name: "lastTouchCampaign",
      type: "string",
      required: false,
      description: "Last touch attribution campaign"
    },

    // Performance metrics
    {
      name: "pageLoadTime",
      type: "number",
      required: false,
      description: "Page load time in milliseconds"
    },
    {
      name: "domContentLoaded",
      type: "number",
      required: false,
      description: "DOM content loaded time in milliseconds"
    },
    {
      name: "timeOnPage",
      type: "number",
      required: false,
      description: "Time spent on page in seconds"
    },
    {
      name: "scrollDepth",
      type: "number",
      required: false,
      description: "Scroll depth percentage (0-100)"
    }
  ]
};

/**
 * GET /v1/analytics/schema - Get event schema
 */
export class GetEventSchema extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get event schema",
    description: "Returns the complete 60-field schema for events in R2 Data Catalog",
    operationId: "get-event-schema",
    responses: {
      "200": {
        description: "Event schema definition",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                namespace: z.string(),
                table: z.string(),
                fields: z.array(z.object({
                  name: z.string(),
                  type: z.string(),
                  required: z.boolean(),
                  description: z.string()
                }))
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    return success(c, EVENT_SCHEMA);
  }
}