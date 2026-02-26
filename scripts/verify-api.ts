#!/usr/bin/env npx tsx
/**
 * API Verification Script — hits every key endpoint and verifies data contracts.
 *
 * Usage:
 *   cd clearlift-api
 *   npx tsx scripts/verify-api.ts
 *   npx tsx scripts/verify-api.ts --token <session_token>
 *   npx tsx scripts/verify-api.ts --port 8787
 *
 * Prerequisites:
 *   - Local API worker running (npx wrangler dev --env local --port 8787)
 *   - Local D1 populated (via seed-local.ts or migrate-org.ts)
 *
 * The script:
 *   1. Authenticates (uses provided token or reads from local D1)
 *   2. Discovers the org_id from the session
 *   3. Hits every key analytics endpoint
 *   4. Validates response shapes and flags issues
 */

const args = process.argv.slice(2);

function argVal(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const PORT = argVal('--port', '8787');
const BASE = `http://localhost:${PORT}`;
let TOKEN = argVal('--token', '');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  status: number;
  ok: boolean;
  issues: string[];
  summary: string;
}

async function check(
  name: string,
  path: string,
  validate: (data: any, raw: any) => string[],
): Promise<CheckResult> {
  const url = `${BASE}${path}`;
  const issues: string[] = [];

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const status = res.status;
    const text = await res.text();
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      return { name, status, ok: false, issues: [`Non-JSON response (${status}): ${text.slice(0, 100)}`], summary: `FAIL (${status} non-JSON)` };
    }

    const data = raw?.data ?? raw;

    if (status !== 200) {
      // Let validator handle expected non-200s (e.g., 404 NO_RESULTS)
      const validationIssues = validate(data, raw);
      if (validationIssues.length === 0) {
        return { name, status, ok: true, issues: [], summary: `OK (${status})` };
      }
      return { name, status, ok: false, issues: [`HTTP ${status}: ${raw?.error?.message || raw?.message || 'unknown'}`], summary: `FAIL (${status})` };
    }

    const validationIssues = validate(data, raw);
    issues.push(...validationIssues);

    return {
      name,
      status,
      ok: issues.length === 0,
      issues,
      summary: issues.length === 0 ? 'OK' : `WARN (${issues.length} issues)`,
    };
  } catch (err: any) {
    return { name, status: 0, ok: false, issues: [`Network error: ${err.message}`], summary: 'FAIL (network)' };
  }
}

function requireField(data: any, field: string, issues: string[]): void {
  if (data?.[field] === undefined || data?.[field] === null) {
    issues.push(`Missing field: ${field}`);
  }
}

function requireNonEmpty(data: any, field: string, issues: string[]): void {
  const val = data?.[field];
  if (!val || (Array.isArray(val) && val.length === 0)) {
    issues.push(`Empty or missing: ${field}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== AdBliss API Verification ===\n');
  console.log(`Base URL: ${BASE}`);

  // 1. Get user + org_id from /v1/user/me + /v1/user/organizations
  if (!TOKEN) {
    console.log('No --token provided, trying demo_session_token_001...');
    TOKEN = 'demo_session_token_001';
  }

  const meRes = await fetch(`${BASE}/v1/user/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (meRes.status !== 200) {
    console.error(`Auth failed (${meRes.status}). Provide --token or run seed-local.ts / migrate-org.ts first.`);
    process.exit(1);
  }
  const meData = await meRes.json() as any;
  const user = meData?.data?.user || meData?.user;

  if (!user) {
    console.error('Could not extract user from /v1/user/me response');
    process.exit(1);
  }

  const orgsRes = await fetch(`${BASE}/v1/user/organizations`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const orgsData = await orgsRes.json() as any;
  const orgs = orgsData?.data?.organizations || orgsData?.organizations || [];

  if (orgs.length === 0) {
    console.error('User has no organizations');
    process.exit(1);
  }

  const orgId = orgs[0].id;
  const orgName = orgs[0].name || orgs[0].slug;
  console.log(`User: ${user.email}`);
  console.log(`Org:  ${orgName} (${orgId})\n`);

  // 2. Date range (last 30 days)
  const now = new Date();
  const dateTo = now.toISOString().split('T')[0];
  const dateFrom = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];

  // 3. Run all checks
  const results: CheckResult[] = [];

  results.push(await check(
    'CAC Summary',
    `/v1/analytics/cac/summary?org_id=${orgId}&days=30`,
    (data) => {
      const issues: string[] = [];
      if (data === null) {
        issues.push('Response is null (no cac_history rows)');
        return issues;
      }
      requireField(data, 'cac_cents', issues);
      requireField(data, 'conversions', issues);
      requireField(data, 'spend_cents', issues);
      requireField(data, 'conversion_source', issues);
      if (data.per_source !== undefined && data.per_source !== null) {
        const keys = Object.keys(data.per_source);
        if (keys.length === 0) {
          issues.push('per_source is empty object (no connector breakdown)');
        } else {
          for (const key of keys) {
            if (typeof data.per_source[key]?.conversions !== 'number') {
              issues.push(`per_source.${key}.conversions is not a number`);
            }
          }
        }
      }
      return issues;
    },
  ));

  results.push(await check(
    'CAC Timeline',
    `/v1/analytics/cac/timeline?org_id=${orgId}&days=30`,
    (data) => {
      const issues: string[] = [];
      const rows = Array.isArray(data) ? data : data?.data;
      if (!rows || !Array.isArray(rows)) {
        issues.push('Expected array of daily rows (in data or data.data)');
        return issues;
      }
      if (rows.length === 0) {
        issues.push('No daily rows returned');
      } else {
        const sample = rows[0];
        requireField(sample, 'date', issues);
        requireField(sample, 'actual_cac', issues);
      }
      return issues;
    },
  ));

  results.push(await check(
    'Conversions',
    `/v1/analytics/conversions?org_id=${orgId}&start_date=${dateFrom}&end_date=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      requireField(data, 'total_conversions', issues);
      requireField(data, 'data_source', issues);
      if (data?.data_source && data.data_source !== 'd1_unified') {
        issues.push(`Unexpected data_source: ${data.data_source} (expected d1_unified)`);
      }
      return issues;
    },
  ));

  results.push(await check(
    'Realtime Goals',
    `/v1/analytics/realtime/goals?org_id=${orgId}&hours=168`,
    (data) => {
      const issues: string[] = [];
      requireField(data, 'total_conversions', issues);
      requireField(data, 'total_revenue', issues);
      if (data?.goals && !Array.isArray(data.goals)) {
        issues.push('goals is not an array');
      }
      return issues;
    },
  ));

  results.push(await check(
    'D1 Summary',
    `/v1/analytics/metrics/summary?org_id=${orgId}&days=30`,
    (data) => {
      const issues: string[] = [];
      requireField(data, 'totalEvents', issues);
      requireField(data, 'totalSessions', issues);
      return issues;
    },
  ));

  results.push(await check(
    'D1 Daily',
    `/v1/analytics/metrics/daily?org_id=${orgId}&start_date=${dateFrom}&end_date=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (!Array.isArray(data)) {
        issues.push('Expected array of daily metrics');
        return issues;
      }
      if (data.length === 0) {
        issues.push('No daily metrics rows');
      }
      return issues;
    },
  ));

  results.push(await check(
    'Platforms',
    `/v1/analytics/platforms/unified?org_id=${orgId}&start_date=${dateFrom}&end_date=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (data?.summary) {
        requireField(data.summary, 'total_spend_cents', issues);
      }
      return issues;
    },
  ));

  // Attribution (D1) endpoint removed — pre-computed attribution uses /v1/analytics/attribution/computed

  results.push(await check(
    'Page Flow',
    `/v1/analytics/metrics/page-flow?org_id=${orgId}&period_start=${dateFrom}&period_end=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (!data?.transitions) {
        issues.push('Missing transitions array');
      } else if (data.transitions.length === 0) {
        issues.push('No page flow transitions');
      } else {
        const t = data.transitions[0];
        requireField(t, 'from_id', issues);
        requireField(t, 'to_id', issues);
        requireField(t, 'from_type', issues);
      }
      return issues;
    },
  ));

  results.push(await check(
    'Journey Overview',
    `/v1/analytics/journeys/overview?org_id=${orgId}&date_from=${dateFrom}&date_to=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (data?.summary) {
        requireField(data.summary, 'total_anonymous_sessions', issues);
      } else if (data?.metrics) {
        requireField(data.metrics, 'total_anonymous_sessions', issues);
      } else {
        issues.push('Missing summary/metrics');
      }
      return issues;
    },
  ));

  results.push(await check(
    'Pipeline Status',
    `/v1/analytics/pipeline-status?org_id=${orgId}`,
    (data) => {
      const issues: string[] = [];
      if (!data?.pipelines && !Array.isArray(data)) {
        issues.push('Missing pipelines array');
      }
      return issues;
    },
  ));

  results.push(await check(
    'Realtime Summary',
    `/v1/analytics/realtime/summary?org_id=${orgId}&hours=168`,
    (data) => {
      const issues: string[] = [];
      requireField(data, 'totalEvents', issues);
      requireField(data, 'sessions', issues);
      return issues;
    },
  ));

  results.push(await check(
    'UTM Campaigns',
    `/v1/analytics/utm-campaigns?org_id=${orgId}&date_from=${dateFrom}&date_to=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (!Array.isArray(data) && !data?.campaigns) {
        issues.push('Expected array or object with campaigns');
      }
      return issues;
    },
  ));

  // Additional endpoints
  results.push(await check(
    'Platform Connections',
    `/v1/connectors?org_id=${orgId}`,
    (data) => {
      const issues: string[] = [];
      if (!Array.isArray(data) && !data?.connections) {
        issues.push('Expected array or connections object');
      }
      return issues;
    },
  ));

  results.push(await check(
    'AI Settings',
    `/v1/settings/matrix?org_id=${orgId}`,
    (data) => {
      const issues: string[] = [];
      if (!data) {
        issues.push('No settings returned');
      }
      return issues;
    },
  ));

  results.push(await check(
    'AI Decisions',
    `/v1/settings/ai-decisions?org_id=${orgId}`,
    (data) => {
      const issues: string[] = [];
      if (!Array.isArray(data) && !data?.decisions) {
        issues.push('Expected array or decisions object');
      }
      return issues;
    },
  ));

  results.push(await check(
    'Analysis Latest',
    `/v1/analysis/latest?org_id=${orgId}`,
    (data) => {
      const issues: string[] = [];
      // May return null if no analysis has run
      return issues;
    },
  ));

  // Hourly Metrics endpoint removed — SiteEventsTab uses /v1/analytics/events/d1 instead

  // D1 Journeys endpoint removed — dashboard uses /v1/analytics/journeys/overview
  // Channel Transitions endpoint removed — dashboard uses page-flow transitions

  results.push(await check(
    'UTM Performance',
    `/v1/analytics/metrics/utm?org_id=${orgId}&start_date=${dateFrom}&end_date=${dateTo}`,
    (data) => {
      const issues: string[] = [];
      if (!Array.isArray(data)) {
        issues.push('Expected array of UTM data');
      }
      return issues;
    },
  ));

  results.push(await check(
    'Attribution (Markov)',
    `/v1/analytics/attribution/computed?org_id=${orgId}&model=markov_chain`,
    (data, raw) => {
      const issues: string[] = [];
      // Expected: NO_RESULTS for orgs without cron-computed Markov data
      if (raw?.error?.code === 'NO_RESULTS') {
        return issues; // Expected for migrated orgs
      }
      requireField(data, 'model', issues);
      requireNonEmpty(data, 'attributions', issues);
      return issues;
    },
  ));

  // 4. Print results
  console.log('─'.repeat(70));
  console.log(`${'Endpoint'.padEnd(30)} ${'Status'.padEnd(8)} Result`);
  console.log('─'.repeat(70));

  let passed = 0;
  let warned = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.ok ? '  OK' : r.status === 200 ? 'WARN' : 'FAIL';
    const color = r.ok ? '\x1b[32m' : r.status === 200 ? '\x1b[33m' : '\x1b[31m';
    console.log(`${color}${r.name.padEnd(30)} ${String(r.status).padEnd(8)} ${r.summary}\x1b[0m`);
    for (const issue of r.issues) {
      console.log(`  → ${issue}`);
    }
    if (r.ok) passed++;
    else if (r.status === 200) warned++;
    else failed++;
  }

  console.log('─'.repeat(70));
  console.log(`\nTotal: ${results.length} endpoints | ${passed} passed | ${warned} warned | ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
