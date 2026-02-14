#!/usr/bin/env node
/**
 * Local D1 Seed Script — populates a realistic fake org with 30 days of data.
 *
 * Run with:
 *   npx tsx scripts/seed-local.ts
 *
 * Prerequisites:
 *   npm run db:migrate:local   (applies DB + ANALYTICS_DB + AI_DB migrations)
 *
 * What it creates:
 *   - "Acme SaaS Demo" org with user, tag, domain, 4 connectors, 3 goals
 *   - ~150 conversions (30 days, mix of stripe/tag)
 *   - ~90 goal_conversions linked to goals
 *   - 30 cac_history rows with per-source breakdown
 *   - 2 handoff_patterns + ~40 handoff_observations
 *   - ~60 conversion_daily_summary rows
 *   - ~90 conversion_attribution rows (first/last touch)
 *   - ~90 stripe_charges linked to stripe conversions
 *   - ~35 jobber_jobs (completed, with revenue)
 *   - 1 journey_analytics pre-computed row
 *   - ~600 journey_touchpoints (multi-touch sessions)
 *   - ~84 event_daily_summary rows (3 event types × 28 days)
 *   - ~300 event_hourly_summary rows (last 7 days)
 *   - 10 attribution_model_results (markov + shapley, AI_DB)
 *   - org_tracking_configs for tag configuration
 *   - Valid session token for dashboard access (no OAuth needed)
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG) — same data every run
// ---------------------------------------------------------------------------
class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    // Numerical Recipes LCG
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state >>> 0) / 0xffffffff;
  }
  /** Inclusive range */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  /** Weighted boolean — p is probability of true */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const rng = new SeededRandom(42);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Use proper UUIDs so the API's slug-vs-UUID detection works correctly.
// The requireOrg middleware uses a UUID regex to decide whether to lookup by id or slug.
const ORG_ID = "de000001-0000-4000-a000-000000000001";
const USER_ID = "de000002-0000-4000-a000-000000000002";
const USER_EMAIL = "demo@acme-saas.com";
const SESSION_TOKEN = "demo_session_token_001";
const TAG = "acme_demo";
const DOMAIN = "acme-saas.com";

const GOAL_STRIPE_ID = "goal_demo_stripe_purchase";
const GOAL_TRIAL_ID = "goal_demo_trial_signup";
const GOAL_DEMO_ID = "goal_demo_request";

const CONN_STRIPE_ID = "conn_demo_stripe";
const CONN_GOOGLE_ID = "conn_demo_google";
const CONN_META_ID = "conn_demo_meta";
const CONN_JOBBER_ID = "conn_demo_jobber";

// Date range: Feb 1 – Feb 28, 2026
const START_DATE = new Date("2026-02-01T00:00:00Z");
const DAYS = 28;

// Ad spend ranges (cents)
const GOOGLE_SPEND_MIN = 8000; // $80
const GOOGLE_SPEND_MAX = 12000; // $120
const META_SPEND_MIN = 4000; // $40
const META_SPEND_MAX = 8000; // $80

// Plan values (cents)
const PLAN_VALUES = [2900, 4900, 9900, 19900, 29900]; // $29 – $299
const PLAN_WEIGHTS = [0.15, 0.35, 0.30, 0.12, 0.08]; // probability weights

function pickPlanValue(): number {
  const r = rng.next();
  let cumulative = 0;
  for (let i = 0; i < PLAN_VALUES.length; i++) {
    cumulative += PLAN_WEIGHTS[i];
    if (r < cumulative) return PLAN_VALUES[i];
  }
  return PLAN_VALUES[1]; // fallback $49
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function dateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoStr(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Simple email hash (deterministic) */
function emailHash(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = ((h << 5) - h + email.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(16, "0");
}

function escSql(s: string): string {
  return s.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// SQL Generators
// ---------------------------------------------------------------------------

function generateDbSql(): string {
  const lines: string[] = [];
  const now = isoStr(new Date());
  const expires = isoStr(addDays(new Date(), 30));

  // User
  lines.push(`INSERT OR IGNORE INTO users (id, email, issuer, access_sub, name, is_admin, created_at, last_login_at)
VALUES ('${USER_ID}', '${USER_EMAIL}', 'seed', 'seed_${USER_ID}', 'Demo User', 0, '${now}', '${now}');`);

  // Organization
  lines.push(`INSERT OR IGNORE INTO organizations (id, name, slug, subscription_tier, settings, created_at, updated_at)
VALUES ('${ORG_ID}', 'Acme SaaS Demo', 'acme-demo', 'growth', '{}', '${now}', '${now}');`);

  // Membership
  lines.push(`INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, joined_at)
VALUES ('${ORG_ID}', '${USER_ID}', 'owner', '${now}');`);

  // Tag mapping
  lines.push(`INSERT OR IGNORE INTO org_tag_mappings (id, organization_id, short_tag, is_active, created_at, updated_at)
VALUES ('tag_demo_001', '${ORG_ID}', '${TAG}', 1, '${now}', '${now}');`);

  // Tracking domain
  lines.push(`INSERT OR IGNORE INTO tracking_domains (id, organization_id, domain, is_verified, is_primary, created_at, updated_at)
VALUES ('domain_demo_001', '${ORG_ID}', '${DOMAIN}', 1, 1, '${now}', '${now}');`);

  // Session
  lines.push(`INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at)
VALUES ('${SESSION_TOKEN}', '${USER_ID}', '${now}', '${expires}');`);

  // Platform connections
  const connectors = [
    { id: CONN_STRIPE_ID, platform: "stripe", accountId: "acct_demo_stripe", name: "Acme Stripe" },
    { id: CONN_GOOGLE_ID, platform: "google", accountId: "123-456-7890", name: "Acme Google Ads" },
    { id: CONN_META_ID, platform: "facebook", accountId: "act_demo_meta", name: "Acme Meta Ads" },
    { id: CONN_JOBBER_ID, platform: "jobber", accountId: "jobber_demo_001", name: "Acme Jobber" },
  ];
  for (const c of connectors) {
    lines.push(`INSERT OR IGNORE INTO platform_connections (id, organization_id, platform, account_id, account_name, connected_by, connected_at, last_synced_at, sync_status, is_active, settings)
VALUES ('${c.id}', '${ORG_ID}', '${c.platform}', '${c.accountId}', '${c.name}', '${USER_ID}', '${now}', '${now}', 'synced', 1, '{}');`);
  }

  // Conversion goals
  lines.push(`INSERT OR IGNORE INTO conversion_goals (id, organization_id, name, type, trigger_config, default_value_cents, is_primary, goal_type, is_active, category, created_at, updated_at)
VALUES ('${GOAL_STRIPE_ID}', '${ORG_ID}', 'Stripe Purchase', 'conversion', '${escSql(JSON.stringify({ source: "stripe", events: ["charge.succeeded"] }))}', 4900, 1, 'revenue_source', 1, 'macro_conversion', '${now}', '${now}');`);

  lines.push(`INSERT OR IGNORE INTO conversion_goals (id, organization_id, name, type, trigger_config, default_value_cents, is_primary, goal_type, is_active, category, created_at, updated_at)
VALUES ('${GOAL_TRIAL_ID}', '${ORG_ID}', 'Trial Signup', 'conversion', '${escSql(JSON.stringify({ event_name: "trial_start" }))}', 0, 0, 'tag_event', 1, 'micro_conversion', '${now}', '${now}');`);

  lines.push(`INSERT OR IGNORE INTO conversion_goals (id, organization_id, name, type, trigger_config, default_value_cents, is_primary, goal_type, is_active, category, created_at, updated_at)
VALUES ('${GOAL_DEMO_ID}', '${ORG_ID}', 'Demo Request', 'conversion', '${escSql(JSON.stringify({ event_name: "demo_request" }))}', 0, 0, 'tag_event', 1, 'micro_conversion', '${now}', '${now}');`);

  // Onboarding progress (completed)
  lines.push(`INSERT OR IGNORE INTO onboarding_progress (user_id, organization_id, current_step, steps_completed, services_connected, first_sync_completed, created_at, updated_at, completed_at)
VALUES ('${USER_ID}', '${ORG_ID}', 'completed', '["welcome","organization","flow","review"]', 3, 1, '${now}', '${now}', '${now}');`);

  // Tracking config
  const goalsJson = escSql(JSON.stringify([
    { id: GOAL_STRIPE_ID, event_name: "charge.succeeded", source: "stripe" },
    { id: GOAL_TRIAL_ID, event_name: "trial_start", source: "tag" },
    { id: GOAL_DEMO_ID, event_name: "demo_request", source: "tag" },
  ]));
  lines.push(`INSERT OR IGNORE INTO org_tracking_configs (id, organization_id, goals, enable_fingerprinting, enable_cross_domain_tracking, enable_performance_tracking, session_timeout, batch_size, batch_timeout, snippet_complexity, created_by)
VALUES ('otc_demo_001', '${ORG_ID}', '${goalsJson}', 1, 1, 1, 1800000, 10, 5000, 'simple', '${USER_ID}');`);

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// ANALYTICS_DB data
// ---------------------------------------------------------------------------

interface ConversionRow {
  id: string;
  source: "stripe" | "tag";
  sourceId: string;
  valueCents: number;
  timestamp: string;
  emailHash: string | null;
  anonymousId: string | null;
  goalId: string | null;
  day: number; // day index 0-27
}

function generateAnalyticsSql(): string {
  const lines: string[] = [];
  const conversions: ConversionRow[] = [];
  const now = isoStr(new Date());

  // -- 1. Generate conversions (30 days) --
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const weekend = isWeekend(day);
    const convCount = weekend ? rng.int(2, 4) : rng.int(5, 8);

    for (let ci = 0; ci < convCount; ci++) {
      const isStripe = rng.chance(0.6);
      const source = isStripe ? "stripe" as const : "tag" as const;
      const id = `conv_demo_${pad(dayIdx)}_${pad(ci)}`;
      const valueCents = isStripe ? pickPlanValue() : 0;
      const hour = rng.int(9, 18); // 9am-6pm
      const minute = rng.int(0, 59);
      const second = rng.int(0, 59);
      const ts = new Date(day);
      ts.setUTCHours(hour, minute, second);

      // 60% have anonymous_id, 30% null (handoff candidates), 10% null+no click
      const hasAnonId = rng.chance(0.6);
      const anonId = hasAnonId ? `anon_demo_${dayIdx}_${ci}` : null;

      // Email hash for stripe conversions
      const custEmail = isStripe ? `customer${dayIdx * 10 + ci}@example.com` : null;
      const eHash = custEmail ? emailHash(custEmail) : null;

      // Goal assignment
      let goalId: string | null = null;
      if (isStripe) {
        goalId = GOAL_STRIPE_ID;
      } else {
        goalId = rng.chance(0.5) ? GOAL_TRIAL_ID : GOAL_DEMO_ID;
      }

      const conv: ConversionRow = {
        id,
        source,
        sourceId: isStripe ? `ch_demo_${dayIdx}_${ci}` : `evt_demo_${dayIdx}_${ci}`,
        valueCents,
        timestamp: isoStr(ts),
        emailHash: eHash,
        anonymousId: anonId,
        goalId,
        day: dayIdx,
      };
      conversions.push(conv);

      // Attributed platform (for stripe, pick based on rng)
      const attributedPlatform = isStripe ? (rng.chance(0.6) ? "google" : "facebook") : null;
      const utmSource = anonId ? (rng.chance(0.5) ? "google" : "facebook") : null;

      lines.push(`INSERT OR IGNORE INTO conversions (id, organization_id, conversion_source, source_id, value_cents, currency, conversion_timestamp, customer_email_hash, anonymous_id, attributed_platform, utm_source, linked_goal_id, link_confidence, link_method, linked_at, created_at, updated_at)
VALUES ('${id}', '${ORG_ID}', '${source}', '${conv.sourceId}', ${valueCents}, 'USD', '${conv.timestamp}', ${eHash ? `'${eHash}'` : "NULL"}, ${anonId ? `'${anonId}'` : "NULL"}, ${attributedPlatform ? `'${attributedPlatform}'` : "NULL"}, ${utmSource ? `'${utmSource}'` : "NULL"}, ${goalId ? `'${goalId}'` : "NULL"}, ${goalId ? "0.95" : "NULL"}, ${goalId ? "'direct_link'" : "NULL"}, ${goalId ? `'${conv.timestamp}'` : "NULL"}, '${now}', '${now}');`);
    }
  }

  // -- 2. Goal conversions (linked subset ~60% of all) --
  const linkedConversions = conversions.filter((c) => c.goalId !== null);
  for (const c of linkedConversions) {
    const gcId = `gc_${c.id}`;
    const sourcePlatform = c.source === "stripe" ? "stripe" : null;
    lines.push(`INSERT OR IGNORE INTO goal_conversions (id, organization_id, goal_id, conversion_id, conversion_source, source_platform, source_event_id, value_cents, currency, conversion_timestamp, created_at)
VALUES ('${gcId}', '${ORG_ID}', '${c.goalId}', '${c.id}', '${c.source === "stripe" ? "connector" : "tag"}', ${sourcePlatform ? `'${sourcePlatform}'` : "NULL"}, '${c.sourceId}', ${c.valueCents}, 'USD', '${c.timestamp}', '${now}');`);
  }

  // -- 3. CAC history (30 days) --
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const ds = dateStr(day);

    // Slight upward trend
    const trendMultiplier = 1 + dayIdx * 0.01;
    const googleSpend = Math.round(rng.int(GOOGLE_SPEND_MIN, GOOGLE_SPEND_MAX) * trendMultiplier);
    const metaSpend = Math.round(rng.int(META_SPEND_MIN, META_SPEND_MAX) * trendMultiplier);
    const totalSpend = googleSpend + metaSpend;

    const dayConversions = conversions.filter((c) => c.day === dayIdx);
    const stripeConvs = dayConversions.filter((c) => c.source === "stripe");
    const tagConvs = dayConversions.filter((c) => c.source === "tag");
    const totalConvs = dayConversions.length;
    const totalRevenue = dayConversions.reduce((s, c) => s + c.valueCents, 0);
    const stripeRevenue = stripeConvs.reduce((s, c) => s + c.valueCents, 0);
    const goalConvs = dayConversions.filter((c) => c.goalId !== null).length;
    const platformConvs = 0; // we don't have platform-reported conversions in this seed

    const cac = totalConvs > 0 ? Math.round(totalSpend / totalConvs) : 0;

    const cacId = `cac_demo_${pad(dayIdx)}`;
    lines.push(`INSERT OR IGNORE INTO cac_history (id, organization_id, date, spend_cents, conversions, revenue_cents, cac_cents, conversions_goal, conversions_platform, conversion_source, goal_ids, revenue_goal_cents, conversions_stripe, conversions_shopify, conversions_jobber, conversions_tag, revenue_stripe_cents, revenue_shopify_cents, revenue_jobber_cents, created_at)
VALUES ('${cacId}', '${ORG_ID}', '${ds}', ${totalSpend}, ${totalConvs}, ${totalRevenue}, ${cac}, ${goalConvs}, ${platformConvs}, 'goal', '${escSql(JSON.stringify([GOAL_STRIPE_ID]))}', ${stripeRevenue}, ${stripeConvs.length}, 0, 0, ${tagConvs.length}, ${stripeRevenue}, 0, 0, '${now}');`);
  }

  // -- 4. Handoff patterns --
  lines.push(`INSERT OR IGNORE INTO handoff_patterns (id, organization_id, click_destination_hostname, conversion_source, observation_count, match_count, match_rate, avg_handoff_to_conversion_seconds, p50_seconds, p95_seconds, min_seconds, max_seconds, first_seen_at, last_seen_at, is_known_provider, created_at, updated_at)
VALUES ('hp_demo_checkout', '${ORG_ID}', 'checkout.stripe.com', 'stripe', 100, 80, 0.80, 65.0, 45.0, 120.0, 12.0, 180.0, '2026-02-01 10:00:00', '2026-02-13 18:00:00', 1, '${now}', '${now}');`);

  lines.push(`INSERT OR IGNORE INTO handoff_patterns (id, organization_id, click_destination_hostname, conversion_source, observation_count, match_count, match_rate, avg_handoff_to_conversion_seconds, p50_seconds, p95_seconds, min_seconds, max_seconds, first_seen_at, last_seen_at, is_known_provider, created_at, updated_at)
VALUES ('hp_demo_pay', '${ORG_ID}', 'pay.stripe.com', 'stripe', 30, 21, 0.70, 50.0, 35.0, 90.0, 8.0, 150.0, '2026-02-07 09:00:00', '2026-02-13 17:00:00', 1, '${now}', '${now}');`);

  // -- 5. Handoff observations (last 7 days: Feb 7-13) --
  let obsIdx = 0;
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayIdx = 6 + dayOffset; // Feb 7 = dayIdx 6
    const day = addDays(START_DATE, dayIdx);
    const clickCount = rng.int(6, 10);

    for (let ci = 0; ci < clickCount; ci++) {
      const obsId = `ho_demo_${pad(obsIdx)}`;
      const clickEventId = `click_demo_${pad(obsIdx)}`;
      const anonId = `anon_ho_${pad(obsIdx)}`;
      const sessionId = `sess_ho_${pad(obsIdx)}`;
      const hour = rng.int(9, 17);
      const minute = rng.int(0, 59);
      const second = rng.int(0, 59);
      const clickTime = new Date(day);
      clickTime.setUTCHours(hour, minute, second);

      const hostname = rng.chance(0.75) ? "checkout.stripe.com" : "pay.stripe.com";
      const matched = rng.chance(0.72); // ~72% match rate
      const timeDelta = rng.int(15, 180); // 15s – 3min

      const convTime = matched ? new Date(clickTime.getTime() + timeDelta * 1000) : null;
      const matchedConvId = matched ? `conv_demo_${pad(dayIdx)}_${pad(ci % 8)}` : null;
      const confidence = matched ? (0.7 + rng.next() * 0.3).toFixed(3) : null;

      const utmSource = rng.pick(["google", "facebook", "direct", null]);
      const utmMedium = utmSource === "direct" ? null : rng.pick(["cpc", "social", null]);
      const utmCampaign = utmSource && utmSource !== "direct" ? rng.pick(["brand_q1", "retarget_feb", "demo_launch"]) : null;

      lines.push(`INSERT OR IGNORE INTO handoff_observations (id, organization_id, click_event_id, anonymous_id, session_id, click_destination_hostname, click_destination_path, navigation_source_path, click_timestamp, utm_source, utm_medium, utm_campaign, geo_country, matched_conversion_id, conversion_timestamp, time_to_conversion_seconds, match_confidence, created_at)
VALUES ('${obsId}', '${ORG_ID}', '${clickEventId}', '${anonId}', '${sessionId}', '${hostname}', '/pay', '/pricing', '${isoStr(clickTime)}', ${utmSource ? `'${utmSource}'` : "NULL"}, ${utmMedium ? `'${utmMedium}'` : "NULL"}, ${utmCampaign ? `'${utmCampaign}'` : "NULL"}, 'US', ${matchedConvId ? `'${matchedConvId}'` : "NULL"}, ${convTime ? `'${isoStr(convTime)}'` : "NULL"}, ${matched ? timeDelta : "NULL"}, ${confidence ?? "NULL"}, '${now}');`);

      obsIdx++;
    }
  }

  // -- 6. Conversion daily summary --
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const ds = dateStr(day);
    const dayConvs = conversions.filter((c) => c.day === dayIdx);

    // By source
    const bySrc: Record<string, { count: number; value: number; customers: Set<string> }> = {};
    for (const c of dayConvs) {
      if (!bySrc[c.source]) bySrc[c.source] = { count: 0, value: 0, customers: new Set() };
      bySrc[c.source].count++;
      bySrc[c.source].value += c.valueCents;
      if (c.emailHash) bySrc[c.source].customers.add(c.emailHash);
    }

    for (const [src, data] of Object.entries(bySrc)) {
      lines.push(`INSERT OR IGNORE INTO conversion_daily_summary (organization_id, summary_date, conversion_source, conversion_count, total_value_cents, unique_customers, created_at)
VALUES ('${ORG_ID}', '${ds}', '${src}', ${data.count}, ${data.value}, ${data.customers.size}, '${now}');`);
    }
  }

  // -- 7. Conversion attribution (first + last touch) --
  const stripeConvs = conversions.filter((c) => c.source === "stripe");
  for (const c of stripeConvs) {
    const platforms = ["google", "facebook"];
    const touchPlatform = rng.pick(platforms);

    // First touch
    lines.push(`INSERT OR IGNORE INTO conversion_attribution (id, organization_id, conversion_id, model, touchpoint_type, touchpoint_platform, touchpoint_timestamp, credit_percent, credit_value_cents, touchpoint_position, total_touchpoints, created_at)
VALUES ('ca_first_${c.id}', '${ORG_ID}', '${c.id}', 'first_touch', 'ad_click', '${touchPlatform}', '${c.timestamp}', 1.0, ${c.valueCents}, 1, 1, '${now}');`);

    // Last touch (sometimes different platform)
    const lastPlatform = rng.chance(0.3) ? rng.pick(platforms) : touchPlatform;
    lines.push(`INSERT OR IGNORE INTO conversion_attribution (id, organization_id, conversion_id, model, touchpoint_type, touchpoint_platform, touchpoint_timestamp, credit_percent, credit_value_cents, touchpoint_position, total_touchpoints, created_at)
VALUES ('ca_last_${c.id}', '${ORG_ID}', '${c.id}', 'last_touch', 'ad_click', '${lastPlatform}', '${c.timestamp}', 1.0, ${c.valueCents}, 1, 1, '${now}');`);
  }

  // -- 8. Ad campaigns in unified tables --
  const campaigns = [
    { id: "camp_google_brand", platform: "google", accountId: "123-456-7890", campaignId: "ggl_brand_001", name: "Brand - Search", objective: "search" },
    { id: "camp_google_retarget", platform: "google", accountId: "123-456-7890", campaignId: "ggl_retarget_001", name: "Retargeting - Display", objective: "display" },
    { id: "camp_meta_prospecting", platform: "facebook", accountId: "act_demo_meta", campaignId: "fb_prospect_001", name: "Prospecting - Lookalike", objective: "conversions" },
    { id: "camp_meta_retarget", platform: "facebook", accountId: "act_demo_meta", campaignId: "fb_retarget_001", name: "Retargeting - Website Visitors", objective: "conversions" },
  ];

  for (const camp of campaigns) {
    lines.push(`INSERT OR IGNORE INTO ad_campaigns (id, organization_id, platform, account_id, campaign_id, campaign_name, campaign_status, objective, last_synced_at, created_at, updated_at)
VALUES ('${camp.id}', '${ORG_ID}', '${camp.platform}', '${camp.accountId}', '${camp.campaignId}', '${camp.name}', 'active', '${camp.objective}', '${now}', '${now}', '${now}');`);
  }

  // Ad metrics per campaign per day
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const ds = dateStr(day);
    const weekend = isWeekend(day);

    for (const camp of campaigns) {
      const isGoogle = camp.platform === "google";
      const baseImpressions = weekend ? rng.int(500, 1500) : rng.int(1500, 4000);
      const ctrVal = 0.02 + rng.next() * 0.04; // 2-6% CTR
      const clicks = Math.round(baseImpressions * ctrVal);
      const spendCents = isGoogle
        ? Math.round((rng.int(GOOGLE_SPEND_MIN, GOOGLE_SPEND_MAX) / 2) * (1 + dayIdx * 0.01))
        : Math.round((rng.int(META_SPEND_MIN, META_SPEND_MAX) / 2) * (1 + dayIdx * 0.01));
      const convs = rng.int(0, weekend ? 2 : 4);
      const ctrCalc = baseImpressions > 0 ? (clicks / baseImpressions) : 0;
      const cpcCents = clicks > 0 ? Math.round(spendCents / clicks) : 0;
      const cpmCents = baseImpressions > 0 ? Math.round((spendCents / baseImpressions) * 1000) : 0;

      lines.push(`INSERT OR IGNORE INTO ad_metrics (organization_id, platform, entity_type, entity_ref, metric_date, impressions, clicks, spend_cents, conversions, ctr, cpc_cents, cpm_cents, created_at)
VALUES ('${ORG_ID}', '${camp.platform}', 'campaign', '${camp.id}', '${ds}', ${baseImpressions}, ${clicks}, ${spendCents}, ${convs}, ${ctrCalc.toFixed(4)}, ${cpcCents}, ${cpmCents}, '${now}');`);
    }
  }

  // -- 9. Stripe charges (mirror existing stripe conversions) --
  const stripeConvs2 = conversions.filter((c) => c.source === "stripe");
  for (const c of stripeConvs2) {
    const chargeId = c.sourceId; // ch_demo_XX_YY
    const custId = `cus_demo_${c.id.replace("conv_demo_", "")}`;
    const custEmailHash = c.emailHash || "NULL";
    const subId = rng.chance(0.6) ? `sub_demo_${c.id.replace("conv_demo_", "")}` : null;
    const chargeType = subId ? "subscription" : "one_time";

    lines.push(`INSERT OR IGNORE INTO stripe_charges (id, organization_id, connection_id, charge_id, customer_id, customer_email_hash, has_invoice, amount_cents, currency, status, payment_method_type, stripe_created_at, charge_type, subscription_id, created_at)
VALUES ('sc_${c.id}', '${ORG_ID}', '${CONN_STRIPE_ID}', '${chargeId}', '${custId}', ${c.emailHash ? `'${c.emailHash}'` : "NULL"}, ${subId ? 1 : 0}, ${c.valueCents}, 'USD', 'succeeded', 'card', '${c.timestamp}', '${chargeType}', ${subId ? `'${subId}'` : "NULL"}, '${now}');`);
  }

  // -- 10. Jobber jobs (1-2 per day, completed) --
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const weekend = isWeekend(day);
    const jobCount = weekend ? rng.int(0, 1) : rng.int(1, 2);

    for (let ji = 0; ji < jobCount; ji++) {
      const jobId = `jj_demo_${pad(dayIdx)}_${pad(ji)}`;
      const jobberId = `job_${1000 + dayIdx * 10 + ji}`;
      const jobNum = `J-${1000 + dayIdx * 10 + ji}`;
      const clientId = `client_${rng.int(1, 20)}`;
      const clientName = `Client ${clientId.replace("client_", "")}`;
      const amount = rng.int(15000, 85000); // $150-$850
      const hour = rng.int(8, 16);
      const completedAt = new Date(day);
      completedAt.setUTCHours(hour, rng.int(0, 59), rng.int(0, 59));
      const createdAt = new Date(completedAt.getTime() - rng.int(1, 5) * 86400000); // 1-5 days before
      const jobTypes = ["Plumbing", "Electrical", "HVAC", "Landscaping", "Cleaning"];
      const jobType = rng.pick(jobTypes);
      const leadSources = ["google", "referral", "website", "facebook", "yelp"];
      const leadSource = rng.pick(leadSources);

      lines.push(`INSERT OR IGNORE INTO jobber_jobs (id, organization_id, connection_id, jobber_job_id, job_number, client_id, client_name, title, job_type, total_amount_cents, currency, job_status, is_completed, completed_at, lead_source, jobber_created_at, created_at, updated_at)
VALUES ('${jobId}', '${ORG_ID}', '${CONN_JOBBER_ID}', '${jobberId}', '${jobNum}', '${clientId}', '${escSql(clientName)}', '${jobType} Service', '${jobType.toLowerCase()}', ${amount}, 'USD', 'completed', 1, '${isoStr(completedAt)}', '${leadSource}', '${isoStr(createdAt)}', '${now}', '${now}');`);
    }
  }

  // -- 11. Journey analytics (1 pre-computed row for the month) --
  const channelDist = JSON.stringify({ google: 0.35, facebook: 0.25, direct: 0.20, organic_search: 0.12, email: 0.08 });
  const entryChannels = JSON.stringify({ google: 0.40, direct: 0.25, facebook: 0.20, organic_search: 0.10, email: 0.05 });
  const exitChannels = JSON.stringify({ direct: 0.35, google: 0.25, facebook: 0.20, email: 0.12, organic_search: 0.08 });
  const transMatrix = JSON.stringify({
    google: { direct: 0.4, facebook: 0.15, conversion: 0.25, organic_search: 0.2 },
    facebook: { direct: 0.35, google: 0.2, conversion: 0.3, organic_search: 0.15 },
    direct: { conversion: 0.45, google: 0.25, facebook: 0.15, email: 0.15 },
    organic_search: { direct: 0.4, google: 0.3, conversion: 0.2, facebook: 0.1 },
    email: { direct: 0.3, conversion: 0.5, google: 0.1, facebook: 0.1 },
  });
  const commonPaths = JSON.stringify([
    { path: ["google", "direct", "conversion"], count: 45, conversion_rate: 0.12 },
    { path: ["facebook", "direct", "conversion"], count: 32, conversion_rate: 0.09 },
    { path: ["google", "conversion"], count: 28, conversion_rate: 0.15 },
    { path: ["direct", "conversion"], count: 25, conversion_rate: 0.08 },
    { path: ["email", "direct", "conversion"], count: 18, conversion_rate: 0.22 },
  ]);
  const matchBreakdown = JSON.stringify({ identity: 45, time_proximity: 30, direct_tag: 20, goal_matched: 10, unmatched: 15 });

  lines.push(`INSERT OR IGNORE INTO journey_analytics (org_tag, channel_distribution, entry_channels, exit_channels, transition_matrix, total_sessions, converting_sessions, conversion_rate, avg_path_length, common_paths, data_quality_level, data_quality_report, total_conversions, matched_conversions, match_breakdown, period_start, period_end, computed_at)
VALUES ('${TAG}', '${escSql(channelDist)}', '${escSql(entryChannels)}', '${escSql(exitChannels)}', '${escSql(transMatrix)}', 2500, 153, 0.061, 2.8, '${escSql(commonPaths)}', 3, '${escSql(JSON.stringify({ level: 3, description: "Good quality with identity matching" }))}', 153, 120, '${escSql(matchBreakdown)}', '2026-02-01', '2026-02-28', '${now}');`);

  // -- 12. Journey touchpoints (~200 sessions with 2-4 touchpoints each) --
  const channels = ["google", "facebook", "direct", "organic_search", "email"];
  const touchpointTypes: Record<string, string> = {
    google: "ad_click", facebook: "ad_click", direct: "direct",
    organic_search: "organic_search", email: "email",
  };
  let tpIdx = 0;
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const weekend = isWeekend(day);
    const sessionCount = weekend ? rng.int(3, 6) : rng.int(6, 10);

    for (let si = 0; si < sessionCount; si++) {
      const anonId = `anon_jt_${pad(dayIdx)}_${pad(si)}`;
      const sessionId = `sess_jt_${pad(dayIdx)}_${pad(si)}`;
      const tpCount = rng.int(2, 4);
      const baseHour = rng.int(8, 20);

      for (let ti = 0; ti < tpCount; ti++) {
        const tpId = `jt_demo_${pad(tpIdx)}`;
        const channel = ti === tpCount - 1 && rng.chance(0.4) ? "direct" : rng.pick(channels);
        const tpType = touchpointTypes[channel];
        const ts = new Date(day);
        ts.setUTCHours(baseHour, rng.int(0, 59) + ti * 10, rng.int(0, 59));

        const isConversion = ti === tpCount - 1 && rng.chance(0.15);
        const convId = isConversion ? `conv_demo_${pad(dayIdx)}_${pad(si % 8)}` : null;
        const convValue = isConversion ? pickPlanValue() : null;

        const utmSource = channel === "google" || channel === "facebook" ? channel : null;
        const utmMedium = channel === "google" ? "cpc" : channel === "facebook" ? "social" : null;

        lines.push(`INSERT OR IGNORE INTO journey_touchpoints (id, organization_id, anonymous_id, session_id, touchpoint_type, touchpoint_source, touchpoint_timestamp, utm_source, utm_medium, page_path, conversion_id, conversion_value_cents, touchpoint_number, is_first_touch, is_last_touch, created_at)
VALUES ('${tpId}', '${ORG_ID}', '${anonId}', '${sessionId}', '${tpType}', '${channel}', '${isoStr(ts)}', ${utmSource ? `'${utmSource}'` : "NULL"}, ${utmMedium ? `'${utmMedium}'` : "NULL"}, '${rng.pick(["/", "/pricing", "/features", "/demo", "/signup"])}', ${convId ? `'${convId}'` : "NULL"}, ${convValue ?? "NULL"}, ${ti + 1}, ${ti === 0 ? 1 : 0}, ${ti === tpCount - 1 ? 1 : 0}, '${now}');`);

        tpIdx++;
      }
    }
  }

  // -- 13. Event daily summary (3 event types × 28 days) --
  const eventTypes = ["page_view", "conversion", "click"];
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const day = addDays(START_DATE, dayIdx);
    const ds = dateStr(day);
    const weekend = isWeekend(day);

    for (const evtType of eventTypes) {
      let count: number, visitors: number, sessions: number;
      if (evtType === "page_view") {
        count = weekend ? rng.int(200, 500) : rng.int(500, 1200);
        visitors = Math.round(count * 0.6);
        sessions = Math.round(count * 0.4);
      } else if (evtType === "conversion") {
        count = weekend ? rng.int(2, 5) : rng.int(5, 12);
        visitors = count;
        sessions = count;
      } else {
        count = weekend ? rng.int(50, 150) : rng.int(150, 400);
        visitors = Math.round(count * 0.7);
        sessions = Math.round(count * 0.5);
      }

      lines.push(`INSERT OR IGNORE INTO event_daily_summary (organization_id, org_tag, summary_date, event_type, event_count, unique_visitors, unique_sessions, created_at)
VALUES ('${ORG_ID}', '${TAG}', '${ds}', '${evtType}', ${count}, ${visitors}, ${sessions}, '${now}');`);
    }
  }

  // -- 14. Event hourly summary (last 7 days, page_view + conversion) --
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayIdx = DAYS - 7 + dayOffset; // Last 7 days
    const day = addDays(START_DATE, dayIdx);

    for (let hour = 0; hour < 24; hour++) {
      const hourTs = new Date(day);
      hourTs.setUTCHours(hour, 0, 0);
      const hourStr = hourTs.toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00Z");
      const isBusinessHour = hour >= 9 && hour <= 18;

      for (const evtType of ["page_view", "conversion"]) {
        let count: number, visitors: number;
        if (evtType === "page_view") {
          count = isBusinessHour ? rng.int(20, 80) : rng.int(2, 15);
          visitors = Math.round(count * 0.6);
        } else {
          count = isBusinessHour ? rng.int(0, 3) : 0;
          visitors = count;
        }
        if (count === 0) continue;

        lines.push(`INSERT OR IGNORE INTO event_hourly_summary (organization_id, summary_hour, event_type, event_count, unique_visitors, created_at)
VALUES ('${ORG_ID}', '${hourStr}', '${evtType}', ${count}, ${visitors}, '${now}');`);
      }
    }
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// AI_DB data
// ---------------------------------------------------------------------------

function generateAiDbSql(): string {
  const lines: string[] = [];
  const now = isoStr(new Date());
  const expires = isoStr(addDays(new Date(), 30));
  const computeDate = dateStr(new Date());

  // Attribution model results — Markov Chain
  const markovChannels: Array<{ channel: string; credit: number; removal: number }> = [
    { channel: "google", credit: 0.38, removal: 0.42 },
    { channel: "facebook", credit: 0.28, removal: 0.31 },
    { channel: "direct", credit: 0.18, removal: 0.12 },
    { channel: "organic_search", credit: 0.10, removal: 0.09 },
    { channel: "email", credit: 0.06, removal: 0.06 },
  ];

  for (const ch of markovChannels) {
    lines.push(`INSERT OR IGNORE INTO attribution_model_results (id, organization_id, model, channel, attributed_credit, removal_effect, shapley_value, computation_date, conversion_count, path_count, expires_at, created_at)
VALUES ('amr_markov_${ch.channel}', '${ORG_ID}', 'markov_chain', '${ch.channel}', ${ch.credit}, ${ch.removal}, NULL, '${computeDate}', 153, 2500, '${expires}', '${now}');`);
  }

  // Attribution model results — Shapley Value
  const shapleyChannels: Array<{ channel: string; credit: number; shapley: number }> = [
    { channel: "google", credit: 0.35, shapley: 0.36 },
    { channel: "facebook", credit: 0.26, shapley: 0.27 },
    { channel: "direct", credit: 0.20, shapley: 0.19 },
    { channel: "organic_search", credit: 0.12, shapley: 0.11 },
    { channel: "email", credit: 0.07, shapley: 0.07 },
  ];

  for (const ch of shapleyChannels) {
    lines.push(`INSERT OR IGNORE INTO attribution_model_results (id, organization_id, model, channel, attributed_credit, removal_effect, shapley_value, computation_date, conversion_count, path_count, expires_at, created_at)
VALUES ('amr_shapley_${ch.channel}', '${ORG_ID}', 'shapley_value', '${ch.channel}', ${ch.credit}, NULL, ${ch.shapley}, '${computeDate}', 153, 2500, '${expires}', '${now}');`);
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiDir = join(import.meta.dirname ?? __dirname, "..");
  const tmpDir = join(apiDir, ".seed-tmp");

  console.log("=== ClearLift Local Seed Script ===\n");

  // 1. Create temp dir
  mkdirSync(tmpDir, { recursive: true });

  // 2. Apply migrations (run each DB separately for better error handling)
  console.log("[1/4] Applying D1 migrations...");
  const dbs = ["DB", "ANALYTICS_DB", "AI_DB"];
  for (const db of dbs) {
    try {
      execSync(`npx wrangler d1 migrations apply ${db} --local`, {
        cwd: apiDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CI: "true" },
        maxBuffer: 10 * 1024 * 1024, // 10MB — migrations produce verbose output
      });
      console.log(`      ${db} migrations applied.`);
    } catch (e: any) {
      const stderr = e.stderr?.toString() || "";
      const stdout = e.stdout?.toString() || "";
      // "Nothing to migrate" or "Migrations to be applied: None" are fine
      if (stdout.includes("Nothing to migrate") || stdout.includes("already") || stderr.includes("Nothing to migrate")) {
        console.log(`      ${db} already up to date.`);
      } else {
        console.error(`      ${db} migration failed:`, stderr.slice(0, 500) || stdout.slice(0, 500));
        process.exit(1);
      }
    }
  }
  console.log("");

  // 3. Generate SQL files
  console.log("[2/5] Generating seed data...");

  const dbSql = generateDbSql();
  const analyticsDbSql = generateAnalyticsSql();
  const aiDbSql = generateAiDbSql();

  const dbSqlPath = join(tmpDir, "seed-db.sql");
  const analyticsSqlPath = join(tmpDir, "seed-analytics.sql");
  const aiSqlPath = join(tmpDir, "seed-ai.sql");

  writeFileSync(dbSqlPath, dbSql, "utf-8");
  writeFileSync(analyticsSqlPath, analyticsDbSql, "utf-8");
  writeFileSync(aiSqlPath, aiDbSql, "utf-8");

  const dbLines = dbSql.split("\n").filter((l) => l.startsWith("INSERT")).length;
  const analyticsLines = analyticsDbSql.split("\n").filter((l) => l.startsWith("INSERT")).length;
  const aiLines = aiDbSql.split("\n").filter((l) => l.startsWith("INSERT")).length;
  console.log(`      DB:           ${dbLines} INSERT statements`);
  console.log(`      ANALYTICS_DB: ${analyticsLines} INSERT statements`);
  console.log(`      AI_DB:        ${aiLines} INSERT statements\n`);

  // 4. Execute SQL via wrangler
  console.log("[3/5] Inserting into local D1...");

  const dbExecs: Array<{ name: string; db: string; path: string }> = [
    { name: "DB", db: "DB", path: dbSqlPath },
    { name: "ANALYTICS_DB", db: "ANALYTICS_DB", path: analyticsSqlPath },
    { name: "AI_DB", db: "AI_DB", path: aiSqlPath },
  ];

  for (const { name, db, path } of dbExecs) {
    try {
      execSync(`npx wrangler d1 execute ${db} --local --file="${path}"`, {
        cwd: apiDir,
        stdio: "pipe",
      });
      console.log(`      ${name} seeded.`);
    } catch (e: any) {
      console.error(`      ${name} seed failed:`, e.stderr?.toString().slice(0, 500));
      process.exit(1);
    }
  }

  // 5. Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  // 6. Summary
  console.log("\n[5/5] Done!\n");
  console.log("=== Seed Summary ===");
  console.log(`  Org:     Acme SaaS Demo (${ORG_ID})`);
  console.log(`  User:    ${USER_EMAIL} (${USER_ID})`);
  console.log(`  Session: ${SESSION_TOKEN} (expires in 30 days)`);
  console.log(`  Tag:     ${TAG}`);
  console.log(`  Domain:  ${DOMAIN}`);
  console.log("");
  console.log("  Connectors: Stripe, Google Ads, Meta Ads");
  console.log("  Goals:      Stripe Purchase (primary), Trial Signup, Demo Request");
  console.log(`  Date range: 2026-02-01 to 2026-02-28`);
  console.log("");
  console.log("=== Next Steps ===");
  console.log("  1. Start the API:");
  console.log("     cd /Users/work/Documents/Code/clearlift-api");
  console.log("     npx wrangler dev --env local --port 8787");
  console.log("");
  console.log("  2. Test with curl:");
  console.log(`     curl http://localhost:8787/v1/analytics/cac/summary?org_id=${ORG_ID} \\`);
  console.log(`       -H "Authorization: Bearer ${SESSION_TOKEN}"`);
  console.log("");
  console.log("  3. Start the dashboard:");
  console.log("     cd /Users/work/Documents/Code/clearlift-page-router/apps/dashboard");
  console.log("     npm run dev");
  console.log("");
  console.log("  4. Set localStorage in browser console:");
  console.log(`     localStorage.setItem('clearlift_session', '${SESSION_TOKEN}')`);
  console.log(`     localStorage.setItem('clearlift_current_org', '${ORG_ID}')`);
  console.log("     // Then reload the page");
  console.log("");
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
