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
import { GetEventsHistorical } from "./endpoints/v1/analytics/events-historical";
import { GetEventsD1 } from "./endpoints/v1/analytics/events-d1";
import { GetConversions } from "./endpoints/v1/analytics/conversions";
import { GetStripeAnalytics, GetStripeDailyAggregates } from "./endpoints/v1/analytics/stripe";
import { GetJobberRevenue, GetJobberInvoices } from "./endpoints/v1/analytics/jobber";
import { GetUnifiedPlatformData } from "./endpoints/v1/analytics/platforms";
import {
  GetAttribution,
  GetAttributionComparison,
  RunAttributionAnalysis,
  GetAttributionJobStatus,
  GetComputedAttribution,
  GetBlendedAttribution,
  RunProbabilisticAttribution,
  GetProbabilisticAttributionStatus,
  GetJourneyAnalytics
} from "./endpoints/v1/analytics/attribution";
import { GetUtmCampaigns, GetUtmTimeSeries } from "./endpoints/v1/analytics/utm-campaigns";
import { GetClickAttribution } from "./endpoints/v1/analytics/click-attribution";
import { RunClickExtraction, GetClickExtractionStats } from "./endpoints/v1/analytics/click-extraction";
import { GetSmartAttribution } from "./endpoints/v1/analytics/smart-attribution";
import { GetTrackingLinkPerformance } from "./endpoints/v1/analytics/tracking-links";
import { PostIdentify, PostIdentityMerge, GetIdentityByAnonymousId } from "./endpoints/v1/analytics/identify";
import { GetUserJourney, GetJourneysOverview } from "./endpoints/v1/analytics/journey";
import { GetFlowMetrics, GetStageTransitions } from "./endpoints/v1/analytics/flow-metrics";
import { GetEventsSyncStatus } from "./endpoints/v1/analytics/events-sync";
import {
  GetD1MetricsSummary,
  GetD1DailyMetrics,
  GetD1HourlyMetrics,
  GetD1UTMPerformance,
  GetD1Attribution,
  GetD1Journeys,
  GetD1ChannelTransitions
} from "./endpoints/v1/analytics/d1-metrics";
import {
  GetRealtimeSummary,
  GetRealtimeTimeSeries,
  GetRealtimeBreakdown,
  GetRealtimeEvents,
  GetRealtimeEventTypes,
  GetRealtimeStripe,
  GetRealtimeGoals,
  GetRealtimeGoalTimeSeries
} from "./endpoints/v1/analytics/realtime";
import {
  GetCACTimeline,
  GenerateCACPredictions,
  BackfillCACHistory,
  ComputeCACBaselines
} from "./endpoints/v1/analytics/cac-timeline";
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
  UpdateFacebookAdSetTargeting,
  GetFacebookPages,
  GetFacebookPageInsights,
  GetFacebookAudienceInsights
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
  GetConnectionsNeedingReauth,
  InitiateOAuthFlow,
  HandleOAuthCallback,
  MockOAuthCallback,
  GetOAuthAccounts,
  GetChildAccounts,
  FinalizeOAuthConnection,
  GetConnectorSettings,
  UpdateConnectorSettings,
  TriggerResync,
  DisconnectPlatform
} from "./endpoints/v1/connectors";
import { GetSyncStatus, GetSyncJobStatus } from "./endpoints/v1/connectors/syncStatus";
import {
  ListConnectorRegistry,
  GetConnectorFromRegistry,
  GetConnectorEvents,
  GetPlatformIds,
  AdminCreateConnector,
  AdminUpdateConnector
} from "./endpoints/v1/connectors/registry";
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
  ConnectLemonSqueezy,
  TestLemonSqueezyConnection
} from "./endpoints/v1/connectors/lemon-squeezy";
import {
  ConnectPaddle,
  TestPaddleConnection
} from "./endpoints/v1/connectors/paddle";
import {
  ConnectChargebee,
  TestChargebeeConnection
} from "./endpoints/v1/connectors/chargebee";
import {
  ConnectRecurly,
  TestRecurlyConnection
} from "./endpoints/v1/connectors/recurly";
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
  TriggerSync,
  TriggerEventsSync,
  GetD1Stats
} from "./endpoints/v1/workers";
import {
  JoinWaitlist,
  GetWaitlistStats
} from "./endpoints/v1/waitlist";
import {
  SendAdminInvite,
  ListAdminInvites,
  AdminGetEventsSyncStatus,
  AdminTriggerEventsSync,
  AdminGetWaitlist,
  AdminUpdateWaitlistStatus
} from "./endpoints/v1/admin";
import {
  AdminListOrganizations,
  AdminGetOrganization,
  AdminUpdateOrganization,
  AdminForceSync,
  AdminResetConnection,
  AdminDisconnect,
  AdminListSyncJobs,
  AdminRetrySyncJob
} from "./endpoints/v1/admin/crm";
import {
  AdminListTasks,
  AdminCreateTask,
  AdminUpdateTask,
  AdminDeleteTask,
  AdminListTaskComments,
  AdminAddTaskComment,
  AdminStartImpersonation,
  AdminEndImpersonation
} from "./endpoints/v1/admin/tasks";
import {
  GetMatrixSettings,
  UpdateMatrixSettings,
  GetAIDecisions,
  AcceptAIDecision,
  RejectAIDecision,
  RateAIDecision
} from "./endpoints/v1/settings";
import {
  AcceptTerms,
  GetTermsStatus
} from "./endpoints/v1/terms";
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
  GetGoalHierarchy,
  CreateGoalRelationship,
  DeleteGoalRelationship,
  ComputeGoalValue,
  RecomputeAllGoalValues,
  GetGoalTemplates,
  CreateGoalsFromTemplates,
  GetGoalConversionStats
} from "./endpoints/v1/goals/hierarchy";
import {
  GetGoalConfig,
  GoalConfigOptions
} from "./endpoints/v1/goals/config";
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
import {
  ListTrackingLinks,
  CreateTrackingLink,
  DeleteTrackingLink,
  GetTrackingLink
} from "./endpoints/v1/tracking-links";

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

  // Exempt status polling endpoints from global rate limit (lightweight reads)
  const isExempt = path.includes('sync-status') ||
                   path.includes('/analysis/status') ||
                   path === '/v1/health';

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

// Admin endpoints (requires auth + is_admin check in handler)
openapi.post("/v1/admin/invites", auth, SendAdminInvite);
openapi.get("/v1/admin/invites", auth, ListAdminInvites);
openapi.get("/v1/admin/events-sync/status", auth, AdminGetEventsSyncStatus);
openapi.post("/v1/admin/events-sync/trigger", auth, AdminTriggerEventsSync);
openapi.get("/v1/admin/waitlist", auth, AdminGetWaitlist);
openapi.patch("/v1/admin/waitlist/:id/status", auth, AdminUpdateWaitlistStatus);

// Admin CRM endpoints
openapi.get("/v1/admin/organizations", auth, AdminListOrganizations);
openapi.get("/v1/admin/organizations/:id", auth, AdminGetOrganization);
openapi.patch("/v1/admin/organizations/:id", auth, AdminUpdateOrganization);
openapi.post("/v1/admin/connections/:id/sync", auth, AdminForceSync);
openapi.post("/v1/admin/connections/:id/reset", auth, AdminResetConnection);
openapi.delete("/v1/admin/connections/:id", auth, AdminDisconnect);
openapi.get("/v1/admin/sync-jobs", auth, AdminListSyncJobs);
openapi.post("/v1/admin/sync-jobs/:id/retry", auth, AdminRetrySyncJob);

// Admin Tasks endpoints
openapi.get("/v1/admin/tasks", auth, AdminListTasks);
openapi.post("/v1/admin/tasks", auth, AdminCreateTask);
openapi.patch("/v1/admin/tasks/:id", auth, AdminUpdateTask);
openapi.delete("/v1/admin/tasks/:id", auth, AdminDeleteTask);
openapi.get("/v1/admin/tasks/:id/comments", auth, AdminListTaskComments);
openapi.post("/v1/admin/tasks/:id/comments", auth, AdminAddTaskComment);

// Admin impersonation endpoints
openapi.post("/v1/admin/impersonate", auth, AdminStartImpersonation);
openapi.post("/v1/admin/end-impersonation", auth, AdminEndImpersonation);

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
openapi.get("/v1/analytics/events/d1", auth, requireOrg, GetEventsD1);
openapi.get("/v1/analytics/events/sync-status", auth, requireOrg, GetEventsSyncStatus);
openapi.get("/v1/analytics/events/historical", auth, requireOrg, GetEventsHistorical);
openapi.get("/v1/analytics/conversions", auth, requireOrg, GetConversions);
openapi.get("/v1/analytics/attribution", auth, requireOrg, GetAttribution);
openapi.get("/v1/analytics/attribution/compare", auth, requireOrg, GetAttributionComparison);
openapi.post("/v1/analytics/attribution/run", auth, requireOrg, RunAttributionAnalysis);
openapi.get("/v1/analytics/attribution/status/:job_id", auth, requireOrg, GetAttributionJobStatus);
openapi.post("/v1/analytics/attribution/probabilistic/run", auth, requireOrg, RunProbabilisticAttribution);
openapi.get("/v1/analytics/attribution/probabilistic/status/:job_id", auth, requireOrg, GetProbabilisticAttributionStatus);
openapi.get("/v1/analytics/attribution/journey-analytics", auth, requireOrg, GetJourneyAnalytics);
openapi.get("/v1/analytics/attribution/computed", auth, requireOrg, GetComputedAttribution);
openapi.get("/v1/analytics/attribution/blended", auth, requireOrg, GetBlendedAttribution);
openapi.get("/v1/analytics/smart-attribution", auth, requireOrg, GetSmartAttribution);
openapi.get("/v1/analytics/stripe", auth, requireOrg, GetStripeAnalytics);
openapi.get("/v1/analytics/stripe/daily-aggregates", auth, requireOrg, GetStripeDailyAggregates);
openapi.get("/v1/analytics/jobber/revenue", auth, requireOrg, GetJobberRevenue);
openapi.get("/v1/analytics/jobber/invoices", auth, requireOrg, GetJobberInvoices);
openapi.get("/v1/analytics/platforms/unified", auth, requireOrg, GetUnifiedPlatformData);
openapi.get("/v1/analytics/utm-campaigns", auth, requireOrg, GetUtmCampaigns);
openapi.get("/v1/analytics/utm-campaigns/time-series", auth, requireOrg, GetUtmTimeSeries);
openapi.get("/v1/analytics/click-attribution", auth, requireOrg, GetClickAttribution);
openapi.post("/v1/analytics/click-extraction/run", auth, requireOrg, RunClickExtraction);
openapi.get("/v1/analytics/click-extraction/stats", auth, requireOrg, GetClickExtractionStats);
openapi.get("/v1/analytics/tracking-links", auth, requireOrg, GetTrackingLinkPerformance);

// Identity resolution endpoints
openapi.post("/v1/analytics/identify", PostIdentify); // Internal - uses service binding or API key auth
openapi.post("/v1/analytics/identify/merge", PostIdentityMerge); // Internal
openapi.get("/v1/analytics/identity/:anonymousId", auth, requireOrg, GetIdentityByAnonymousId);

// User journey endpoints
openapi.get("/v1/analytics/users/:userId/journey", auth, requireOrg, GetUserJourney);
openapi.get("/v1/analytics/journeys/overview", auth, requireOrg, GetJourneysOverview);

// Flow Builder analytics endpoints
openapi.get("/v1/analytics/flow/metrics", auth, requireOrg, GetFlowMetrics);
openapi.get("/v1/analytics/flow/stage/:stageId/transitions", auth, requireOrg, GetStageTransitions);

// D1 Analytics endpoints (dev environment - pure Cloudflare)
openapi.get("/v1/analytics/metrics/summary", auth, requireOrg, GetD1MetricsSummary);
openapi.get("/v1/analytics/metrics/daily", auth, requireOrg, GetD1DailyMetrics);
openapi.get("/v1/analytics/metrics/hourly", auth, requireOrg, GetD1HourlyMetrics);
openapi.get("/v1/analytics/metrics/utm", auth, requireOrg, GetD1UTMPerformance);
openapi.get("/v1/analytics/metrics/attribution", auth, requireOrg, GetD1Attribution);
openapi.get("/v1/analytics/metrics/journeys", auth, requireOrg, GetD1Journeys);
openapi.get("/v1/analytics/metrics/transitions", auth, requireOrg, GetD1ChannelTransitions);

// Real-time Analytics Engine endpoints (sub-second latency)
openapi.get("/v1/analytics/realtime/summary", auth, requireOrg, GetRealtimeSummary);
openapi.get("/v1/analytics/realtime/timeseries", auth, requireOrg, GetRealtimeTimeSeries);
openapi.get("/v1/analytics/realtime/breakdown", auth, requireOrg, GetRealtimeBreakdown);
openapi.get("/v1/analytics/realtime/events", auth, requireOrg, GetRealtimeEvents);
openapi.get("/v1/analytics/realtime/event-types", auth, requireOrg, GetRealtimeEventTypes);
openapi.get("/v1/analytics/realtime/stripe", auth, requireOrg, GetRealtimeStripe);
openapi.get("/v1/analytics/realtime/goals", auth, requireOrg, GetRealtimeGoals);
openapi.get("/v1/analytics/realtime/goals/:id/timeseries", auth, requireOrg, GetRealtimeGoalTimeSeries);

// CAC Timeline endpoints (truthful predictions based on simulation data)
openapi.get("/v1/analytics/cac/timeline", auth, requireOrg, GetCACTimeline);
openapi.post("/v1/analytics/cac/generate", auth, requireOrg, GenerateCACPredictions);
openapi.post("/v1/analytics/cac/backfill", auth, requireOrg, BackfillCACHistory);
openapi.post("/v1/analytics/cac/compute-baselines", auth, requireOrg, ComputeCACBaselines);

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
// Facebook Pages endpoints (pages_show_list + pages_read_engagement permissions)
openapi.get("/v1/analytics/facebook/pages", auth, requireOrg, GetFacebookPages);
openapi.get("/v1/analytics/facebook/pages/:page_id/insights", auth, requireOrg, GetFacebookPageInsights);
// Facebook Audience Insights (read_insights permission - for Meta App Review)
openapi.get("/v1/analytics/facebook/audience-insights", auth, requireOrg, GetFacebookAudienceInsights);

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

// Connector Registry endpoints (public - no auth required for reading)
openapi.get("/v1/connectors/registry", ListConnectorRegistry);
openapi.get("/v1/connectors/registry/types/:type/platform-ids", GetPlatformIds);
openapi.get("/v1/connectors/registry/:provider", GetConnectorFromRegistry);
openapi.get("/v1/connectors/registry/:provider/events", GetConnectorEvents);

// Admin Connector Registry endpoints
openapi.post("/v1/admin/connectors/registry", auth, AdminCreateConnector);
openapi.patch("/v1/admin/connectors/registry/:provider", auth, AdminUpdateConnector);

// Connector endpoints
openapi.get("/v1/connectors", auth, ListConnectors);
openapi.get("/v1/connectors/connected", auth, ListConnectedPlatforms);
openapi.get("/v1/connectors/needs-reauth", auth, GetConnectionsNeedingReauth);

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

// Lemon Squeezy-specific connector endpoints
openapi.post("/v1/connectors/lemon-squeezy/connect", auth, ConnectLemonSqueezy);
openapi.post("/v1/connectors/lemon-squeezy/:connection_id/test", auth, TestLemonSqueezyConnection);

// Paddle-specific connector endpoints
openapi.post("/v1/connectors/paddle/connect", auth, ConnectPaddle);
openapi.post("/v1/connectors/paddle/:connection_id/test", auth, TestPaddleConnection);

// Chargebee-specific connector endpoints
openapi.post("/v1/connectors/chargebee/connect", auth, ConnectChargebee);
openapi.post("/v1/connectors/chargebee/:connection_id/test", auth, TestChargebeeConnection);

// Recurly-specific connector endpoints
openapi.post("/v1/connectors/recurly/connect", auth, ConnectRecurly);
openapi.post("/v1/connectors/recurly/:connection_id/test", auth, TestRecurlyConnection);

// Generic OAuth provider endpoints (after platform-specific routes)
openapi.post("/v1/connectors/:provider/connect", auth, InitiateOAuthFlow);
openapi.get("/v1/connectors/:provider/callback", HandleOAuthCallback); // No auth - OAuth callback
openapi.get("/v1/connectors/:provider/mock-callback", MockOAuthCallback); // No auth - Mock OAuth for local dev
openapi.get("/v1/connectors/:provider/accounts", GetOAuthAccounts); // No auth - called from callback page
openapi.get("/v1/connectors/:provider/accounts/:account_id/children", GetChildAccounts); // No auth - called from callback page
openapi.post("/v1/connectors/:provider/finalize", FinalizeOAuthConnection); // No auth - called from callback page
openapi.delete("/v1/connectors/:connection_id", auth, DisconnectPlatform);
openapi.get("/v1/connectors/:connection_id/sync-status", auth, GetSyncStatus);

// Sync job status endpoint (for error recovery)
openapi.get("/v1/sync-jobs/:job_id/status", auth, GetSyncJobStatus);

// General connector settings endpoints
openapi.get("/v1/connectors/:connection_id/settings", auth, GetConnectorSettings);
openapi.patch("/v1/connectors/:connection_id/settings", auth, UpdateConnectorSettings);
openapi.post("/v1/connectors/:connection_id/resync", auth, TriggerResync);

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
openapi.get("/v1/workers/d1/stats", auth, GetD1Stats);
openapi.get("/v1/workers/test-token/:connection_id", auth, TestConnectionToken);
openapi.post("/v1/workers/sync/trigger", auth, TriggerSync);
openapi.post("/v1/workers/events-sync/trigger", auth, TriggerEventsSync);

// Settings endpoints
openapi.get("/v1/settings/matrix", auth, requireOrg, GetMatrixSettings);
openapi.post("/v1/settings/matrix", auth, requireOrg, requireOrgAdmin, UpdateMatrixSettings);

// Terms acceptance endpoints (for onboarding clickwrap)
openapi.post("/v1/terms/accept", auth, AcceptTerms);
openapi.get("/v1/terms/status", auth, GetTermsStatus);

// Tracking config endpoints
openapi.get("/v1/config", GetTagConfig); // Public endpoint for tracking tag
openapi.get("/v1/tracking-config", auth, GetTrackingConfig);
openapi.put("/v1/tracking-config", auth, UpdateTrackingConfig);
openapi.post("/v1/tracking-config/snippet", auth, GenerateTrackingSnippet);

// Email tracking links endpoints
openapi.get("/v1/tracking-links", auth, requireOrg, ListTrackingLinks);
openapi.post("/v1/tracking-links", auth, requireOrg, CreateTrackingLink);
openapi.get("/v1/tracking-links/:id", auth, requireOrg, GetTrackingLink);
openapi.delete("/v1/tracking-links/:id", auth, requireOrg, DeleteTrackingLink);

// AI Decisions endpoints
openapi.get("/v1/settings/ai-decisions", auth, requireOrg, GetAIDecisions);
openapi.post("/v1/settings/ai-decisions/:decision_id/accept", auth, requireOrg, requireOrgAdmin, AcceptAIDecision);
openapi.post("/v1/settings/ai-decisions/:decision_id/reject", auth, requireOrg, requireOrgAdmin, RejectAIDecision);
openapi.post("/v1/settings/ai-decisions/:decision_id/rate", auth, requireOrg, RateAIDecision);

// Conversion Goals endpoints
openapi.get("/v1/goals", auth, requireOrg, ListConversionGoals);
openapi.post("/v1/goals", auth, requireOrg, requireOrgAdmin, CreateConversionGoal);
openapi.put("/v1/goals/:id", auth, requireOrg, requireOrgAdmin, UpdateConversionGoal);
openapi.delete("/v1/goals/:id", auth, requireOrg, requireOrgAdmin, DeleteConversionGoal);

// Goal Config for Tag (public endpoint - no auth required)
openapi.get("/v1/goals/config", GetGoalConfig);
openapi.options("/v1/goals/config", GoalConfigOptions);

// Goal Metrics endpoints (D1 data)
openapi.get("/v1/goals/:id/metrics", auth, requireOrg, GetGoalMetrics);
openapi.get("/v1/goals/:id/conversions", auth, requireOrg, GetGoalConversions);

// Goal Hierarchy and Value Computation endpoints
openapi.get("/v1/goals/hierarchy", auth, requireOrg, GetGoalHierarchy);
openapi.get("/v1/goals/templates", auth, GetGoalTemplates);
openapi.post("/v1/goals/from-templates", auth, requireOrg, CreateGoalsFromTemplates);
openapi.post("/v1/goals/relationships", auth, requireOrg, requireOrgAdmin, CreateGoalRelationship);
openapi.delete("/v1/goals/relationships/:id", auth, requireOrg, requireOrgAdmin, DeleteGoalRelationship);
openapi.post("/v1/goals/:id/compute-value", auth, requireOrg, ComputeGoalValue);
openapi.get("/v1/goals/:id/conversion-stats", auth, requireOrg, GetGoalConversionStats);
openapi.post("/v1/goals/recompute-all", auth, requireOrg, RecomputeAllGoalValues);

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


// Import aggregation service for scheduled tasks
import { AggregationService } from './services/aggregation-service';

// Export the Hono app with scheduled handler
export default {
  fetch: app.fetch,

  // Scheduled handler for cron jobs
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date(event.scheduledTime).toISOString()}, cron: ${event.cron}`);

    // Daily aggregation cron (runs at 5 AM UTC)
    if (event.cron === '0 5 * * *') {
      console.log('[Cron] Running daily aggregation...');

      // Build array of shard databases
      const shards = [env.SHARD_0, env.SHARD_1, env.SHARD_2, env.SHARD_3].filter(Boolean);

      if (shards.length === 0) {
        console.error('[Cron] No shard databases configured');
        return;
      }

      // Pass ANALYTICS_DB for Stripe aggregation (Stripe data lives in ANALYTICS_DB, not shards)
      const aggregator = new AggregationService(shards, env.ANALYTICS_DB);
      const result = await aggregator.runFullAggregation();

      console.log(`[Cron] Aggregation completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`[Cron] Total duration: ${result.totalDuration_ms}ms`);
      console.log(`[Cron] Shards processed: ${result.shards.length}`);

      if (result.errors.length > 0) {
        console.error(`[Cron] Errors: ${result.errors.join(', ')}`);
      }

      // Log summary per shard
      for (const shard of result.shards) {
        console.log(`[Cron] Shard ${shard.shardId}: ${shard.success ? 'OK' : 'FAILED'} (${shard.duration_ms}ms)`);
      }

      // Run CAC history backfill for all orgs (populates cac_history table)
      console.log('[Cron] Running CAC history backfill...');
      await this.backfillCACHistoryForAllOrgs(env);
    }

    // Stale job cleanup cron (runs every 15 minutes)
    if (event.cron === '*/15 * * * *') {
      console.log('[Cron] Running stale job cleanup...');
      await this.cleanupStaleJobs(env);
    }
  },

  // Cleanup stale pending jobs - retry or fail them
  async cleanupStaleJobs(env: Env): Promise<void> {
    const STALE_THRESHOLD_MINUTES = 10;  // Jobs pending > 10 min are stale (reduced from 30 for faster recovery)
    const MAX_RETRIES = 3;               // Max retry attempts before marking failed
    const FAIL_THRESHOLD_HOURS = 2;      // Jobs pending > 2 hours are failed

    try {
      // Find stale pending jobs (> 30 minutes old, < 2 hours old)
      const staleJobs = await env.DB.prepare(`
        SELECT
          sj.id, sj.connection_id, sj.organization_id, sj.job_type, sj.metadata,
          pc.platform, pc.account_id
        FROM sync_jobs sj
        JOIN platform_connections pc ON sj.connection_id = pc.id
        WHERE sj.status = 'pending'
          AND sj.created_at < datetime('now', '-${STALE_THRESHOLD_MINUTES} minutes')
          AND sj.created_at > datetime('now', '-${FAIL_THRESHOLD_HOURS} hours')
        LIMIT 10
      `).all<{
        id: string;
        connection_id: string;
        organization_id: string;
        job_type: string;
        metadata: string | null;
        platform: string;
        account_id: string;
      }>();

      console.log(`[Cron] Found ${staleJobs.results?.length || 0} stale pending jobs`);

      for (const job of staleJobs.results || []) {
        const metadata = job.metadata ? JSON.parse(job.metadata) : {};
        const retryCount = metadata.retry_count || 0;

        if (retryCount >= MAX_RETRIES) {
          // Too many retries - mark as failed
          console.log(`[Cron] Job ${job.id} exceeded max retries, marking as failed`);
          await env.DB.prepare(`
            UPDATE sync_jobs
            SET status = 'failed',
                error_message = 'Job stuck in pending state after ${MAX_RETRIES} retry attempts',
                completed_at = datetime('now'),
                metadata = ?
            WHERE id = ?
          `).bind(
            JSON.stringify({ ...metadata, retry_count: retryCount, failed_reason: 'max_retries_exceeded' }),
            job.id
          ).run();
        } else {
          // Retry - re-queue the job
          console.log(`[Cron] Re-queuing stale job ${job.id} (retry ${retryCount + 1}/${MAX_RETRIES})`);

          // Update metadata with retry count
          const updatedMetadata = { ...metadata, retry_count: retryCount + 1, last_retry: new Date().toISOString() };
          await env.DB.prepare(`
            UPDATE sync_jobs SET metadata = ? WHERE id = ?
          `).bind(JSON.stringify(updatedMetadata), job.id).run();

          // Re-send to queue
          try {
            await env.SYNC_QUEUE.send({
              job_id: job.id,
              connection_id: job.connection_id,
              organization_id: job.organization_id,
              platform: job.platform,
              account_id: job.account_id,
              sync_window: metadata.sync_window || {
                type: job.job_type,
                start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                end: new Date().toISOString()
              },
              metadata: updatedMetadata
            });
            console.log(`[Cron] Successfully re-queued job ${job.id}`);
          } catch (queueErr) {
            console.error(`[Cron] Failed to re-queue job ${job.id}:`, queueErr);
          }
        }
      }

      // Find very old pending jobs (> 2 hours) and mark as failed
      const veryOldJobs = await env.DB.prepare(`
        SELECT id, metadata FROM sync_jobs
        WHERE status = 'pending'
          AND created_at < datetime('now', '-${FAIL_THRESHOLD_HOURS} hours')
        LIMIT 20
      `).all<{ id: string; metadata: string | null }>();

      if (veryOldJobs.results?.length) {
        console.log(`[Cron] Marking ${veryOldJobs.results.length} very old pending jobs as failed`);

        for (const job of veryOldJobs.results) {
          const metadata = job.metadata ? JSON.parse(job.metadata) : {};
          await env.DB.prepare(`
            UPDATE sync_jobs
            SET status = 'failed',
                error_message = 'Job abandoned - pending for over ${FAIL_THRESHOLD_HOURS} hours without being processed',
                completed_at = datetime('now'),
                metadata = ?
            WHERE id = ?
          `).bind(
            JSON.stringify({ ...metadata, failed_reason: 'abandoned' }),
            job.id
          ).run();
        }
      }

      // Also cleanup stale active_event_workflows entries (> 2 hours old)
      const cleanedWorkflows = await env.DB.prepare(`
        DELETE FROM active_event_workflows
        WHERE created_at < datetime('now', '-2 hours')
      `).run();

      if (cleanedWorkflows.meta.changes > 0) {
        console.log(`[Cron] Cleaned up ${cleanedWorkflows.meta.changes} stale workflow entries`);
      }

      console.log('[Cron] Stale job cleanup completed');
    } catch (err) {
      console.error('[Cron] Error during stale job cleanup:', err);
    }
  },

  // Backfill CAC history for all organizations from unified ad_metrics table
  async backfillCACHistoryForAllOrgs(env: Env): Promise<void> {
    const DAYS_TO_BACKFILL = 30;

    try {
      // Get all unique org IDs from unified ad_metrics table
      const orgsResult = await env.ANALYTICS_DB.prepare(`
        SELECT DISTINCT organization_id
        FROM ad_metrics
        WHERE entity_type = 'campaign'
          AND metric_date >= date('now', '-${DAYS_TO_BACKFILL} days')
      `).all<{ organization_id: string }>();

      const orgs = orgsResult.results || [];
      console.log(`[Cron] Found ${orgs.length} orgs with campaign metrics for CAC backfill`);

      let totalRowsInserted = 0;

      for (const org of orgs) {
        try {
          // Query daily spend and conversions from unified ad_metrics for this org
          const metricsResult = await env.ANALYTICS_DB.prepare(`
            SELECT
              metric_date as date,
              SUM(spend_cents) as spend_cents,
              SUM(conversions) as conversions
            FROM ad_metrics
            WHERE organization_id = ?
              AND entity_type = 'campaign'
              AND metric_date >= date('now', '-${DAYS_TO_BACKFILL} days')
            GROUP BY metric_date
            ORDER BY metric_date ASC
          `).bind(org.organization_id).all<{
            date: string;
            spend_cents: number;
            conversions: number;
          }>();

          if (!metricsResult.results || metricsResult.results.length === 0) {
            continue;
          }

          for (const row of metricsResult.results) {
            if (row.conversions === 0) continue;

            const cacCents = Math.round(row.spend_cents / row.conversions);

            await env.AI_DB.prepare(`
              INSERT INTO cac_history (
                organization_id, date, spend_cents, conversions, revenue_cents, cac_cents
              )
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(organization_id, date)
              DO UPDATE SET
                spend_cents = excluded.spend_cents,
                conversions = excluded.conversions,
                revenue_cents = excluded.revenue_cents,
                cac_cents = excluded.cac_cents,
                created_at = datetime('now')
            `).bind(
              org.organization_id,
              row.date,
              row.spend_cents,
              row.conversions,
              0, // revenue_cents - not available in campaign metrics, would need Stripe/Shopify
              cacCents
            ).run();

            totalRowsInserted++;
          }
        } catch (orgErr) {
          console.error(`[Cron] Error backfilling CAC for org ${org.organization_id}:`, orgErr);
          // Continue with other orgs
        }
      }

      console.log(`[Cron] CAC history backfill completed: ${totalRowsInserted} rows upserted across ${orgs.length} orgs`);
    } catch (err) {
      console.error('[Cron] Error during CAC history backfill:', err);
    }
  }
};

// Export workflow classes for Cloudflare Workflows bindings
export { AnalysisWorkflow } from './workflows/analysis-workflow';
export { AttributionWorkflow } from './workflows/attribution-workflow';