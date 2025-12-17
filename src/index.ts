import { fromHono } from "chanfana";
import { Hono } from "hono";

// Middleware
import { corsMiddleware } from "./middleware/cors";
import { auth, requireOrg, requireOrgAdmin, requireOrgOwner } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { auditMiddleware, authAuditMiddleware } from "./middleware/audit";
import { rateLimitMiddleware, authRateLimit, analyticsRateLimit } from "./middleware/rateLimit";
import { securityHeaders, validateContentType, sanitizeInput } from "./middleware/security";

// V1 Endpoints
import { HealthEndpoint } from "./endpoints/v1/health";
import {
  GetUserProfile,
  UpdateUserProfile,
  GetUserOrganizations
} from "./endpoints/v1/user";
import { GetEvents } from "./endpoints/v1/analytics/events";
import { GetConversions } from "./endpoints/v1/analytics/conversions";
import { GetStripeAnalytics, GetStripeDailyAggregates } from "./endpoints/v1/analytics/stripe";
import { GetUnifiedPlatformData } from "./endpoints/v1/analytics/platforms";
import { GetAttribution, GetAttributionComparison } from "./endpoints/v1/analytics/attribution";
import { GetUtmCampaigns, GetUtmTimeSeries } from "./endpoints/v1/analytics/utm-campaigns";
import { GetClickAttribution } from "./endpoints/v1/analytics/click-attribution";
import { PostIdentify, PostIdentityMerge, GetIdentityByAnonymousId } from "./endpoints/v1/analytics/identify";
import { GetUserJourney, GetJourneysOverview } from "./endpoints/v1/analytics/journey";
import {
  GetFacebookCampaigns,
  GetFacebookAdSets,
  GetFacebookCreatives,
  GetFacebookAds,
  GetFacebookMetrics,
  UpdateFacebookCampaignStatus,
  UpdateFacebookAdSetStatus,
  UpdateFacebookAdStatus,
  UpdateFacebookCampaignBudget,
  UpdateFacebookAdSetBudget,
  UpdateFacebookAdSetTargeting
} from "./endpoints/v1/analytics/facebook";
import {
  GetGoogleCampaigns,
  GetGoogleAdGroups,
  GetGoogleAds,
  GetGoogleMetrics,
  UpdateGoogleCampaignStatus,
  UpdateGoogleAdGroupStatus,
  UpdateGoogleCampaignBudget
} from "./endpoints/v1/analytics/google";
import {
  GetTikTokCampaigns,
  GetTikTokAdGroups,
  GetTikTokAds,
  GetTikTokMetrics,
  UpdateTikTokCampaignStatus,
  UpdateTikTokAdGroupStatus,
  UpdateTikTokCampaignBudget,
  UpdateTikTokAdGroupBudget,
  UpdateTikTokAdGroupTargeting
} from "./endpoints/v1/analytics/tiktok";
import {
  GetOnboardingStatus,
  StartOnboarding,
  CompleteOnboardingStep,
  ResetOnboarding
} from "./endpoints/v1/onboarding";
import {
  Register,
  Login,
  Logout,
  RefreshSession,
  RequestPasswordReset,
  ResetPassword,
  VerifyEmail,
  ResendVerification,
  DeleteAccount
} from "./endpoints/v1/auth";
import {
  CreateOrganization,
  UpdateOrganization,
  InviteToOrganization,
  JoinOrganization,
  RemoveMember,
  GetOrganizationMembers,
  GetPendingInvitations,
  GetOrganizationTag,
  CreateShareableInviteLink,
  GetShareableInviteLink,
  RevokeShareableInviteLink,
  LookupOrganization,
  GetTrackingDomains,
  AddTrackingDomain,
  RemoveTrackingDomain,
  ResyncTrackingDomain
} from "./endpoints/v1/organizations";
import {
  ListConnectors,
  ListConnectedPlatforms,
  InitiateOAuthFlow,
  HandleOAuthCallback,
  MockOAuthCallback,
  GetOAuthAccounts,
  GetChildAccounts,
  FinalizeOAuthConnection,
  GetConnectorSettings,
  UpdateConnectorSettings,
  TriggerResync,
  ListGoogleAdsAccounts,
  UpdateGoogleAdsSettings,
  DisconnectPlatform
} from "./endpoints/v1/connectors";
import { GetSyncStatus } from "./endpoints/v1/connectors/syncStatus";
import {
  ConnectStripe,
  UpdateStripeConfig,
  TriggerStripeSync,
  TestStripeConnection
} from "./endpoints/v1/connectors/stripe";
import {
  ConnectAttentive,
  UpdateAttentiveConfig,
  TriggerAttentiveSync,
  TestAttentiveConnection
} from "./endpoints/v1/connectors/attentive";
import {
  CreateFilterRule,
  ListFilterRules,
  UpdateFilterRule,
  DeleteFilterRule,
  TestFilterRule,
  DiscoverMetadataKeys
} from "./endpoints/v1/connectors/filters";
import {
  GetWorkersHealth,
  GetQueueStatus,
  GetDeadLetterQueue,
  TestConnectionToken,
  TriggerSync
} from "./endpoints/v1/workers";
import {
  JoinWaitlist,
  GetWaitlistStats
} from "./endpoints/v1/waitlist";
import {
  GetMatrixSettings,
  UpdateMatrixSettings,
  GetAIDecisions,
  AcceptAIDecision,
  RejectAIDecision
} from "./endpoints/v1/settings";
import {
  ListConversionGoals,
  CreateConversionGoal,
  UpdateConversionGoal,
  DeleteConversionGoal,
  ListEventFilters,
  CreateEventFilter,
  UpdateEventFilter,
  DeleteEventFilter
} from "./endpoints/v1/goals";
import {
  GetGoalMetrics,
  GetGoalConversions
} from "./endpoints/v1/goal-metrics";
import {
  RunAnalysis,
  GetAnalysisStatus,
  GetLatestAnalysis,
  GetEntityAnalysis
} from "./endpoints/v1/analysis";
import {
  GetTagConfig,
  GetTrackingConfig,
  UpdateTrackingConfig,
  GenerateTrackingSnippet
} from "./endpoints/v1/tracking-config";

// Import types
import { Session } from "./middleware/auth";

// Define Variables type
type Variables = {
  session: Session;
};

// Start a Hono app with proper types
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global error handler
app.onError(errorHandler);

// Apply security headers to all routes (SOC 2 requirement)
app.use("*", securityHeaders());

// Production Supabase warning for local development
// Only logs once per worker instance to avoid spam
let hasLoggedSupabaseWarning = false;
app.use("*", async (c, next) => {
  if (!hasLoggedSupabaseWarning && c.env.SUPABASE_URL?.includes('supabase.co')) {
    hasLoggedSupabaseWarning = true;
    console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.warn('⚠️  PRODUCTION SUPABASE URL DETECTED');
    console.warn('   This worker will query PRODUCTION Supabase data!');
    console.warn('   URL: ' + c.env.SUPABASE_URL);
    console.warn('');
    console.warn('   For true local development:');
    console.warn('   1. Start local Supabase: cd ../clearlift-cron && supabase start');
    console.warn('   2. Comment out SUPABASE_URL in .dev.vars');
    console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
  return next();
});

// Apply CORS to all routes
app.use("*", corsMiddleware);

// Input sanitization for all routes (SOC 2 requirement)
app.use("*", sanitizeInput());

// Content type validation for routes with body
app.use("*", validateContentType());

// Global rate limiting (SOC 2 requirement)
// Skip rate limiting for status polling endpoints (lightweight reads)
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Exempt status polling endpoints from global rate limit
  const isExempt = path.includes('sync-status') || path === '/v1/health';

  if (isExempt) {
    return next();
  }

  // Apply standard rate limit to other endpoints
  return rateLimitMiddleware({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100 // 100 requests per minute per IP/user
  })(c, next);
});

// Audit logging for all authenticated routes (SOC 2 requirement)
app.use("*", auditMiddleware);

// Add direct Hono route for Stripe connect BEFORE fromHono to bypass Chanfana validation
// Stripe connect endpoint now uses proper OpenAPI validation (registered below with other routes)

// Setup OpenAPI registry
// Note: Using 'any' type cast to work around chanfana type incompatibility with middleware
// See: https://github.com/cloudflare/chanfana/issues/70
// The routes work correctly at runtime - this is purely a TypeScript type issue
const openapi = fromHono(app, {
  docs_url: "/",
  schema: {
    info: {
      title: "ClearLift API",
      version: "1.0.0",
      description: "Production API for ClearLift analytics platform",
    },
    servers: [
      {
        url: "https://api.clearlift.ai",
        description: "Production"
      },
      {
        url: "http://localhost:8787",
        description: "Development"
      }
    ],
    security: [
      {
        bearerAuth: []
      }
    ]
  }
}) as any;

// Create V1 router
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();

// Health check (no auth)
openapi.get("/v1/health", HealthEndpoint);

// Waitlist endpoints (no auth - public endpoints for marketing site)
openapi.post("/v1/waitlist", JoinWaitlist);
openapi.get("/v1/waitlist/stats", GetWaitlistStats);

// Debug SendGrid endpoint removed for production security

// Diagnostic endpoint to test Secrets Store access
app.get("/v1/debug/secrets", async (c) => {
  const { getSecret } = await import("./utils/secrets");

  try {
    const googleClientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
    const googleClientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
    const googleDevToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);

    return c.json({
      success: true,
      secrets: {
        GOOGLE_CLIENT_ID: {
          exists: !!googleClientId,
          length: googleClientId?.length || 0,
          preview: googleClientId?.substring(0, 10) + "..."
        },
        GOOGLE_CLIENT_SECRET: {
          exists: !!googleClientSecret,
          length: googleClientSecret?.length || 0,
          preview: "***REDACTED***"
        },
        GOOGLE_ADS_DEVELOPER_TOKEN: {
          exists: !!googleDevToken,
          length: googleDevToken?.length || 0,
          preview: "***REDACTED***"
        }
      }
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

// Authentication endpoints (no auth required)
openapi.post("/v1/auth/register", Register);
openapi.post("/v1/auth/login", Login);
openapi.post("/v1/auth/logout", auth, Logout);
openapi.post("/v1/auth/refresh", auth, RefreshSession);
openapi.post("/v1/auth/password-reset-request", RequestPasswordReset);
openapi.post("/v1/auth/password-reset", ResetPassword);
openapi.post("/v1/auth/verify-email", VerifyEmail);
openapi.post("/v1/auth/resend-verification", ResendVerification);

// User endpoints (session auth only)
openapi.get("/v1/user/me", auth, GetUserProfile);
openapi.patch("/v1/user/me", auth, UpdateUserProfile);
openapi.delete("/v1/user/me", auth, DeleteAccount);
openapi.get("/v1/user/organizations", auth, GetUserOrganizations);

// Organization management endpoints
openapi.post("/v1/organizations", auth, CreateOrganization);
openapi.patch("/v1/organizations/:org_id", auth, requireOrg, requireOrgAdmin, UpdateOrganization);
openapi.post("/v1/organizations/:org_id/invite", auth, requireOrg, requireOrgAdmin, InviteToOrganization);
openapi.post("/v1/organizations/join", auth, JoinOrganization);
openapi.get("/v1/organizations/:org_id/members", auth, requireOrg, GetOrganizationMembers);
openapi.get("/v1/organizations/:org_id/invitations", auth, requireOrg, requireOrgAdmin, GetPendingInvitations);
openapi.get("/v1/organizations/:org_id/tag", auth, requireOrg, GetOrganizationTag);
openapi.delete("/v1/organizations/:org_id/members/:user_id", auth, requireOrg, requireOrgOwner, RemoveMember);

// Shareable invite link endpoints
openapi.post("/v1/organizations/:org_id/invite-link", auth, requireOrg, requireOrgAdmin, CreateShareableInviteLink);
openapi.get("/v1/organizations/:org_id/invite-link", auth, requireOrg, GetShareableInviteLink);
openapi.delete("/v1/organizations/:org_id/invite-link", auth, requireOrg, requireOrgAdmin, RevokeShareableInviteLink);
openapi.get("/v1/organizations/lookup", auth, LookupOrganization);

// Tracking domains endpoints (for domain-based org auto-detection)
openapi.get("/v1/organizations/:org_id/tracking-domains", auth, requireOrg, GetTrackingDomains);
openapi.post("/v1/organizations/:org_id/tracking-domains", auth, requireOrg, requireOrgAdmin, AddTrackingDomain);
openapi.delete("/v1/organizations/:org_id/tracking-domains/:domain_id", auth, requireOrg, requireOrgAdmin, RemoveTrackingDomain);
openapi.post("/v1/organizations/:org_id/tracking-domains/:domain_id/resync", auth, requireOrg, requireOrgAdmin, ResyncTrackingDomain);

// Analytics endpoints
openapi.get("/v1/analytics/events", auth, requireOrg, GetEvents);
openapi.get("/v1/analytics/conversions", auth, requireOrg, GetConversions);
openapi.get("/v1/analytics/attribution", auth, requireOrg, GetAttribution);
openapi.get("/v1/analytics/attribution/compare", auth, requireOrg, GetAttributionComparison);
openapi.get("/v1/analytics/stripe", auth, requireOrg, GetStripeAnalytics);
openapi.get("/v1/analytics/stripe/daily-aggregates", auth, requireOrg, GetStripeDailyAggregates);
openapi.get("/v1/analytics/platforms/unified", auth, requireOrg, GetUnifiedPlatformData);
openapi.get("/v1/analytics/utm-campaigns", auth, requireOrg, GetUtmCampaigns);
openapi.get("/v1/analytics/utm-campaigns/time-series", auth, requireOrg, GetUtmTimeSeries);
openapi.get("/v1/analytics/click-attribution", auth, requireOrg, GetClickAttribution);

// Identity resolution endpoints
openapi.post("/v1/analytics/identify", PostIdentify); // Internal - uses service binding or API key auth
openapi.post("/v1/analytics/identify/merge", PostIdentityMerge); // Internal
openapi.get("/v1/analytics/identity/:anonymousId", auth, requireOrg, GetIdentityByAnonymousId);

// User journey endpoints
openapi.get("/v1/analytics/users/:userId/journey", auth, requireOrg, GetUserJourney);
openapi.get("/v1/analytics/journeys/overview", auth, requireOrg, GetJourneysOverview);

// Facebook Ads endpoints
openapi.get("/v1/analytics/facebook/campaigns", auth, requireOrg, GetFacebookCampaigns);
openapi.get("/v1/analytics/facebook/ad-sets", auth, requireOrg, GetFacebookAdSets);
openapi.get("/v1/analytics/facebook/creatives", auth, requireOrg, GetFacebookCreatives);
openapi.get("/v1/analytics/facebook/ads", auth, requireOrg, GetFacebookAds);
openapi.get("/v1/analytics/facebook/metrics/daily", auth, requireOrg, GetFacebookMetrics);
openapi.patch("/v1/analytics/facebook/campaigns/:campaign_id/status", auth, requireOrg, requireOrgAdmin, UpdateFacebookCampaignStatus);
openapi.patch("/v1/analytics/facebook/ad-sets/:ad_set_id/status", auth, requireOrg, requireOrgAdmin, UpdateFacebookAdSetStatus);
openapi.patch("/v1/analytics/facebook/ads/:ad_id/status", auth, requireOrg, requireOrgAdmin, UpdateFacebookAdStatus);
openapi.patch("/v1/analytics/facebook/campaigns/:campaign_id/budget", auth, requireOrg, requireOrgAdmin, UpdateFacebookCampaignBudget);
openapi.patch("/v1/analytics/facebook/ad-sets/:ad_set_id/budget", auth, requireOrg, requireOrgAdmin, UpdateFacebookAdSetBudget);
openapi.patch("/v1/analytics/facebook/ad-sets/:ad_set_id/targeting", auth, requireOrg, requireOrgAdmin, UpdateFacebookAdSetTargeting);

// Google Ads endpoints
openapi.get("/v1/analytics/google/campaigns", auth, requireOrg, GetGoogleCampaigns);
openapi.get("/v1/analytics/google/ad-groups", auth, requireOrg, GetGoogleAdGroups);
openapi.get("/v1/analytics/google/ads", auth, requireOrg, GetGoogleAds);
openapi.get("/v1/analytics/google/metrics/daily", auth, requireOrg, GetGoogleMetrics);
// Google write endpoints (AI_PLAN.md tools: set_active, set_budget)
openapi.patch("/v1/analytics/google/campaigns/:campaign_id/status", auth, requireOrg, UpdateGoogleCampaignStatus);
openapi.patch("/v1/analytics/google/ad-groups/:ad_group_id/status", auth, requireOrg, UpdateGoogleAdGroupStatus);
openapi.patch("/v1/analytics/google/campaigns/:campaign_id/budget", auth, requireOrg, UpdateGoogleCampaignBudget);

// TikTok Ads endpoints
openapi.get("/v1/analytics/tiktok/campaigns", auth, requireOrg, GetTikTokCampaigns);
openapi.get("/v1/analytics/tiktok/ad-groups", auth, requireOrg, GetTikTokAdGroups);
openapi.get("/v1/analytics/tiktok/ads", auth, requireOrg, GetTikTokAds);
openapi.get("/v1/analytics/tiktok/metrics/daily", auth, requireOrg, GetTikTokMetrics);
// TikTok write endpoints (AI_PLAN.md tools: set_active, set_budget, set_audience)
openapi.patch("/v1/analytics/tiktok/campaigns/:campaign_id/status", auth, requireOrg, UpdateTikTokCampaignStatus);
openapi.patch("/v1/analytics/tiktok/ad-groups/:ad_group_id/status", auth, requireOrg, UpdateTikTokAdGroupStatus);
openapi.patch("/v1/analytics/tiktok/campaigns/:campaign_id/budget", auth, requireOrg, UpdateTikTokCampaignBudget);
openapi.patch("/v1/analytics/tiktok/ad-groups/:ad_group_id/budget", auth, requireOrg, UpdateTikTokAdGroupBudget);
openapi.patch("/v1/analytics/tiktok/ad-groups/:ad_group_id/targeting", auth, requireOrg, UpdateTikTokAdGroupTargeting);

// Onboarding endpoints
openapi.get("/v1/onboarding/status", auth, GetOnboardingStatus);
openapi.post("/v1/onboarding/start", auth, StartOnboarding);
openapi.post("/v1/onboarding/complete-step", auth, CompleteOnboardingStep);
openapi.post("/v1/onboarding/reset", auth, ResetOnboarding);

// Connector endpoints
openapi.get("/v1/connectors", auth, ListConnectors);
openapi.get("/v1/connectors/connected", auth, ListConnectedPlatforms);

// Stripe-specific connector endpoints (MUST be before generic :provider routes)
openapi.post("/v1/connectors/stripe/connect", auth, ConnectStripe);
openapi.put("/v1/connectors/stripe/:connection_id/config", auth, UpdateStripeConfig);
openapi.post("/v1/connectors/stripe/:connection_id/sync", auth, TriggerStripeSync);
openapi.post("/v1/connectors/stripe/:connection_id/test", auth, TestStripeConnection);

// Attentive-specific connector endpoints
openapi.post("/v1/connectors/attentive/connect", auth, ConnectAttentive);
openapi.put("/v1/connectors/attentive/:connection_id/config", auth, UpdateAttentiveConfig);
openapi.post("/v1/connectors/attentive/:connection_id/sync", auth, TriggerAttentiveSync);
openapi.post("/v1/connectors/attentive/:connection_id/test", auth, TestAttentiveConnection);

// Generic OAuth provider endpoints (after platform-specific routes)
openapi.post("/v1/connectors/:provider/connect", auth, InitiateOAuthFlow);
openapi.get("/v1/connectors/:provider/callback", HandleOAuthCallback); // No auth - OAuth callback
openapi.get("/v1/connectors/:provider/mock-callback", MockOAuthCallback); // No auth - Mock OAuth for local dev
openapi.get("/v1/connectors/:provider/accounts", GetOAuthAccounts); // No auth - called from callback page
openapi.get("/v1/connectors/:provider/accounts/:account_id/children", GetChildAccounts); // No auth - called from callback page
openapi.post("/v1/connectors/:provider/finalize", FinalizeOAuthConnection); // No auth - called from callback page
openapi.delete("/v1/connectors/:connection_id", auth, DisconnectPlatform);
openapi.get("/v1/connectors/:connection_id/sync-status", auth, GetSyncStatus);

// General connector settings endpoints
openapi.get("/v1/connectors/:connection_id/settings", auth, GetConnectorSettings);
openapi.patch("/v1/connectors/:connection_id/settings", auth, UpdateConnectorSettings);
openapi.post("/v1/connectors/:connection_id/resync", auth, TriggerResync);

// Google Ads-specific connector endpoints (deprecated - use general settings endpoints instead)
openapi.get("/v1/connectors/:connection_id/google-ads/accounts", auth, ListGoogleAdsAccounts);
openapi.put("/v1/connectors/:connection_id/google-ads/settings", auth, UpdateGoogleAdsSettings);

// Filter management endpoints
openapi.post("/v1/connectors/:connection_id/filters", auth, CreateFilterRule);
openapi.get("/v1/connectors/:connection_id/filters", auth, ListFilterRules);
openapi.put("/v1/connectors/:connection_id/filters/:filter_id", auth, UpdateFilterRule);
openapi.delete("/v1/connectors/:connection_id/filters/:filter_id", auth, DeleteFilterRule);
openapi.post("/v1/connectors/:connection_id/filters/test", auth, TestFilterRule);
openapi.get("/v1/connectors/:connection_id/filters/discover", auth, DiscoverMetadataKeys);

// Worker monitoring endpoints
openapi.get("/v1/workers/health", auth, GetWorkersHealth);
openapi.get("/v1/workers/queue/status", auth, GetQueueStatus);
openapi.get("/v1/workers/dlq", auth, GetDeadLetterQueue);
openapi.get("/v1/workers/test-token/:connection_id", auth, TestConnectionToken);
openapi.post("/v1/workers/sync/trigger", auth, TriggerSync);

// Settings endpoints
openapi.get("/v1/settings/matrix", auth, requireOrg, GetMatrixSettings);
openapi.post("/v1/settings/matrix", auth, requireOrg, requireOrgAdmin, UpdateMatrixSettings);

// Tracking config endpoints
openapi.get("/v1/config", GetTagConfig); // Public endpoint for tracking tag
openapi.get("/v1/tracking-config", auth, GetTrackingConfig);
openapi.put("/v1/tracking-config", auth, UpdateTrackingConfig);
openapi.post("/v1/tracking-config/snippet", auth, GenerateTrackingSnippet);

// AI Decisions endpoints
openapi.get("/v1/settings/ai-decisions", auth, requireOrg, GetAIDecisions);
openapi.post("/v1/settings/ai-decisions/:decision_id/accept", auth, requireOrg, requireOrgAdmin, AcceptAIDecision);
openapi.post("/v1/settings/ai-decisions/:decision_id/reject", auth, requireOrg, requireOrgAdmin, RejectAIDecision);

// Conversion Goals endpoints
openapi.get("/v1/goals", auth, requireOrg, ListConversionGoals);
openapi.post("/v1/goals", auth, requireOrg, requireOrgAdmin, CreateConversionGoal);
openapi.put("/v1/goals/:id", auth, requireOrg, requireOrgAdmin, UpdateConversionGoal);
openapi.delete("/v1/goals/:id", auth, requireOrg, requireOrgAdmin, DeleteConversionGoal);

// Goal Metrics endpoints (Supabase data)
openapi.get("/v1/goals/:id/metrics", auth, requireOrg, GetGoalMetrics);
openapi.get("/v1/goals/:id/conversions", auth, requireOrg, GetGoalConversions);

// Event Filters endpoints
openapi.get("/v1/event-filters", auth, requireOrg, ListEventFilters);
openapi.post("/v1/event-filters", auth, requireOrg, requireOrgAdmin, CreateEventFilter);
openapi.put("/v1/event-filters/:id", auth, requireOrg, requireOrgAdmin, UpdateEventFilter);
openapi.delete("/v1/event-filters/:id", auth, requireOrg, requireOrgAdmin, DeleteEventFilter);

// AI Analysis endpoints (hierarchical insights)
openapi.post("/v1/analysis/run", auth, requireOrg, RunAnalysis);
openapi.get("/v1/analysis/status/:job_id", auth, requireOrg, GetAnalysisStatus);
openapi.get("/v1/analysis/latest", auth, requireOrg, GetLatestAnalysis);
openapi.get("/v1/analysis/entity/:level/:entity_id", auth, requireOrg, GetEntityAnalysis);


// Export the Hono app
export default app;