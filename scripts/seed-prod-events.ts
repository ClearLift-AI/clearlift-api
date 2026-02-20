#!/usr/bin/env node
/**
 * Prod Event Data → Local D1 Test Harness
 *
 * Pulls real clickstream data from production R2 SQL (event_data_v5),
 * re-tags it as the demo org, and processes it through the same pipeline
 * as ProbabilisticAttributionWorkflow to populate local D1 ANALYTICS_DB.
 *
 * Populates (same tables as prod ProbabilisticAttributionWorkflow):
 *   - journeys             (session-level channel paths)
 *   - journey_analytics    (pre-computed flow stats + transition matrix)
 *   - channel_transitions  (channel→channel flow probabilities)
 *   - funnel_transitions   (page→page flow graph — the implicit sitemap)
 *
 * The funnel_transitions table gets real page→page navigation data from R2 SQL.
 * In prod, the ProbabilisticAttributionWorkflow writes channel-level entries here.
 * For local testing of the implicit sitemap flowchart, we write actual page paths
 * because that's what the dashboard journeys widgets visualize.
 *
 * Run:
 *   npx tsx scripts/seed-prod-events.ts [--org wine|lole|bandago] [--days 7]
 *
 * Prerequisites:
 *   npx tsx scripts/seed-local.ts   (creates demo org + connectors)
 *
 * Env (auto-read from .dev.vars):
 *   R2_SQL_TOKEN — Cloudflare R2 API token with SQL read permissions
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_DIR = join(import.meta.dirname ?? __dirname, "..");
const TMP_DIR = join(API_DIR, ".seed-tmp");

const CF_ACCOUNT_ID = "133c285e1182ce57a619c802eaf56fb0";
const R2_BUCKET = "clearlift-db";
const R2_TABLE = "clearlift.event_data_v5";

// Demo org constants — must match seed-local.ts
const ORG_ID = "de000001-0000-4000-a000-000000000001";
const ORG_TAG = "acme_demo";

// Parse CLI args
const args = process.argv.slice(2);
function argVal(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const SOURCE_ORG = argVal("--org", "wine");
const DAYS = parseInt(argVal("--days", "7"));

// R2 SQL token — env → .dev.vars fallback
function getR2Token(): string {
  if (process.env.R2_SQL_TOKEN) return process.env.R2_SQL_TOKEN;
  if (process.env.WRANGLER_R2_SQL_AUTH_TOKEN) return process.env.WRANGLER_R2_SQL_AUTH_TOKEN;
  try {
    const vars = readFileSync(join(API_DIR, ".dev.vars"), "utf-8");
    const m = vars.match(/R2_SQL_TOKEN=(.+)/);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("R2_SQL_TOKEN not found in env or .dev.vars");
}
const R2_TOKEN = getR2Token();

// ---------------------------------------------------------------------------
// R2 SQL REST API
// ---------------------------------------------------------------------------
interface R2SqlResult {
  result: {
    schema: Array<{ name: string }>;
    rows: Array<Record<string, unknown>>;
    metrics: { bytes_scanned: number; files_scanned: number };
  };
  success: boolean;
  errors: Array<{ message: string }>;
}

async function r2sql(query: string): Promise<Record<string, unknown>[]> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${CF_ACCOUNT_ID}/r2-sql/query/${R2_BUCKET}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${R2_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`R2 SQL ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as R2SqlResult;
  if (!data.success) throw new Error(`R2 SQL: ${data.errors.map((e) => e.message).join("; ")}`);
  const { rows, metrics } = data.result;
  console.log(`      → ${rows.length} rows, ${(metrics.bytes_scanned / 1024 / 1024).toFixed(1)} MB scanned`);
  return rows;
}

// ---------------------------------------------------------------------------
// Channel classification (mirrors classifyChannel in probabilistic-attribution.ts)
// ---------------------------------------------------------------------------
function classifyChannel(ev: Record<string, unknown>): string {
  const src = ((ev.utm_source as string) || "").toLowerCase();
  const med = ((ev.utm_medium as string) || "").toLowerCase();
  const ref = ((ev.referrer_domain as string) || "").toLowerCase();
  const host = ((ev.page_hostname as string) || "").toLowerCase();

  if (ev.gclid) return "paid_search";
  if (ev.fbclid) return "paid_social";
  if (ev.ttclid) return "paid_social";

  if (med === "cpc" || med === "ppc" || med === "paid") {
    return src.includes("google") || src.includes("bing") ? "paid_search" : "paid_social";
  }
  if (med === "email" || src === "lifecycle") return "email";
  if (med === "sms") return "sms";
  if (med === "social" || med === "organic_social") return "organic_social";
  if (med === "affiliate" || med === "referral") return "referral";

  if (!ref) return "direct";
  if (/google|bing|yahoo|duckduckgo/.test(ref)) return "organic_search";
  if (/facebook|instagram|twitter|tiktok|linkedin|pinterest/.test(ref)) return "organic_social";
  if (ref.includes(host.replace("www.", ""))) return "direct"; // self-referral
  return "referral";
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------
function esc(s: string | null | undefined): string {
  if (s == null || s === "") return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dateFrom = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const dateFromShort = dateFrom.split("T")[0];

  console.log("=== Prod R2 SQL → Local D1 Test Harness ===\n");
  console.log(`  Source:   ${SOURCE_ORG} via R2 SQL (event_data_v5)`);
  console.log(`  Window:   ${DAYS} days (since ${dateFromShort})`);
  console.log(`  Target:   ${ORG_TAG} → local ANALYTICS_DB\n`);

  mkdirSync(TMP_DIR, { recursive: true });

  // =========================================================================
  // Step 1: Fetch events from R2 SQL
  // =========================================================================
  console.log("[1/5] Querying R2 SQL for page_view + click events...");
  const events = await r2sql(`
    SELECT event_type, anonymous_id, session_id, page_path,
           page_hostname, referrer_domain, utm_source, utm_medium,
           utm_campaign, utm_content, utm_term, gclid, fbclid,
           navigation_source_path, timestamp
    FROM ${R2_TABLE}
    WHERE __ingest_ts > '${dateFrom}'
      AND org_tag = '${SOURCE_ORG}'
      AND (event_type = 'page_view' OR event_type = 'click')
    LIMIT 5000
  `);

  if (!events.length) {
    console.error("\nNo events found. Try --org lole or --org bandago, or increase --days.");
    process.exit(1);
  }

  // =========================================================================
  // Step 2: Group into sessions, build journeys
  // (mirrors ProbabilisticAttributionWorkflow.buildJourneysAndMatch)
  // =========================================================================
  console.log("\n[2/5] Building journeys from sessions...");

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  for (const ev of events) {
    const sid = ev.session_id as string;
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid)!.push(ev);
  }
  for (const evts of sessions.values()) {
    evts.sort((a, b) => (a.timestamp as string).localeCompare(b.timestamp as string));
  }

  // Period bounds
  const allTimestamps = events.map((e) => e.timestamp as string).sort();
  const periodStart = allTimestamps[0].split("T")[0];
  const periodEnd = allTimestamps[allTimestamps.length - 1].split("T")[0];

  // Build journey objects
  const journeyRows: string[] = [];
  const journeys: Array<{ channelPath: string[] }> = [];
  let jIdx = 0;

  for (const [, evts] of sessions) {
    const id = `j_prod_${jIdx++}`;
    const anonId = evts[0].anonymous_id as string;
    const firstTs = evts[0].timestamp as string;
    const lastTs = evts[evts.length - 1].timestamp as string;

    // Collapse consecutive same-channel page_views into channel path
    const channelPath: string[] = [];
    for (const ev of evts) {
      if (ev.event_type !== "page_view") continue;
      const ch = classifyChannel(ev);
      if (!channelPath.length || channelPath[channelPath.length - 1] !== ch) {
        channelPath.push(ch);
      }
    }
    if (!channelPath.length) channelPath.push("direct");

    journeys.push({ channelPath });

    // Matches prod INSERT from probabilistic-attribution.ts line 611
    journeyRows.push(`INSERT INTO journeys (
  id, org_tag, anonymous_id, channel_path, path_length,
  first_touch_ts, last_touch_ts, converted, conversion_value_cents, computed_at
) VALUES (
  ${esc(id)}, ${esc(ORG_TAG)}, ${esc(anonId)},
  ${esc(JSON.stringify(channelPath))}, ${channelPath.length},
  ${esc(firstTs)}, ${esc(lastTs)}, 0, 0, datetime('now')
) ON CONFLICT (id) DO UPDATE SET
  channel_path = excluded.channel_path,
  path_length = excluded.path_length,
  computed_at = datetime('now');`);
  }

  console.log(`      ${journeyRows.length} journeys from ${sessions.size} sessions.`);

  // =========================================================================
  // Step 3: Build channel_transitions
  // (mirrors ProbabilisticAttributionWorkflow.buildTransitionMatrixFromSlim)
  // =========================================================================
  console.log("\n[3/5] Building channel transitions...");

  const ctMap = new Map<string, { from: string; to: string; count: number }>();
  for (const j of journeys) {
    for (let i = 0; i + 1 < j.channelPath.length; i++) {
      const key = `${j.channelPath[i]}→${j.channelPath[i + 1]}`;
      if (!ctMap.has(key)) ctMap.set(key, { from: j.channelPath[i], to: j.channelPath[i + 1], count: 0 });
      ctMap.get(key)!.count++;
    }
  }

  const ctRows: string[] = [];
  for (const ct of ctMap.values()) {
    // Matches prod INSERT from probabilistic-attribution.ts line 768
    ctRows.push(`INSERT INTO channel_transitions (
  org_tag, from_channel, to_channel, transition_count, converting_count,
  probability, period_start, period_end
) VALUES (
  ${esc(ORG_TAG)}, ${esc(ct.from)}, ${esc(ct.to)},
  ${ct.count}, 0, 0,
  ${esc(periodStart)}, ${esc(periodEnd)}
) ON CONFLICT (org_tag, from_channel, to_channel, period_start) DO UPDATE SET
  transition_count = excluded.transition_count,
  computed_at = datetime('now');`);
  }

  console.log(`      ${ctRows.length} channel transitions.`);

  // =========================================================================
  // Step 4: Build funnel_transitions (page→page implicit sitemap)
  // (mirrors ProbabilisticAttributionWorkflow step 10c, but with real page paths
  //  instead of channel analogs — this is the flow graph the user wants to test)
  // =========================================================================
  console.log("\n[4/5] Building page→page flow graph (funnel_transitions)...");

  const pageTrans = new Map<string, { from: string; to: string; count: number; visitors: Set<string> }>();
  const pageVisitors = new Map<string, Set<string>>();

  for (const [, evts] of sessions) {
    const views = evts.filter((e) => e.event_type === "page_view");
    for (let i = 0; i < views.length; i++) {
      const fromPath = views[i].page_path as string;
      const anonId = views[i].anonymous_id as string;

      if (!pageVisitors.has(fromPath)) pageVisitors.set(fromPath, new Set());
      pageVisitors.get(fromPath)!.add(anonId);

      if (i + 1 < views.length) {
        const toPath = views[i + 1].page_path as string;
        if (fromPath === toPath) continue; // skip reloads
        const key = `${fromPath}→${toPath}`;
        if (!pageTrans.has(key)) pageTrans.set(key, { from: fromPath, to: toPath, count: 0, visitors: new Set() });
        const t = pageTrans.get(key)!;
        t.count++;
        t.visitors.add(anonId);
      }
    }
  }

  // Top 200 by frequency
  const topPageTrans = [...pageTrans.values()].sort((a, b) => b.count - a.count).slice(0, 200);
  const ftRows: string[] = [];
  for (const t of topPageTrans) {
    const fromVis = pageVisitors.get(t.from)?.size || 1;
    const rate = Math.min(t.visitors.size / fromVis, 1);

    // Matches prod INSERT from probabilistic-attribution.ts line 1097
    ftRows.push(`INSERT INTO funnel_transitions (
  org_tag, from_type, from_id, from_name, to_type, to_id, to_name,
  visitors_at_from, visitors_transitioned, transition_rate,
  conversions, conversion_rate, revenue_cents,
  period_start, period_end
) VALUES (
  ${esc(ORG_TAG)}, 'page', ${esc(t.from)}, ${esc(t.from)},
  'page', ${esc(t.to)}, ${esc(t.to)},
  ${fromVis}, ${t.visitors.size}, ${rate.toFixed(4)},
  0, 0, 0,
  ${esc(periodStart)}, ${esc(periodEnd)}
) ON CONFLICT (org_tag, from_type, from_id, to_type, to_id, period_start) DO UPDATE SET
  visitors_at_from = excluded.visitors_at_from,
  visitors_transitioned = excluded.visitors_transitioned,
  transition_rate = excluded.transition_rate,
  computed_at = datetime('now');`);
  }

  console.log(`      ${ftRows.length} page transitions (top 200).`);

  // =========================================================================
  // Step 5: Compute journey_analytics
  // (mirrors ProbabilisticAttributionWorkflow.computeJourneyAnalytics)
  // =========================================================================
  console.log("\n[5/5] Computing journey_analytics...");

  const chCounts = new Map<string, number>();
  const entryCh = new Map<string, number>();
  const exitCh = new Map<string, number>();
  let totalLen = 0;

  for (const j of journeys) {
    totalLen += j.channelPath.length;
    for (const ch of j.channelPath) chCounts.set(ch, (chCounts.get(ch) || 0) + 1);
    entryCh.set(j.channelPath[0], (entryCh.get(j.channelPath[0]) || 0) + 1);
    const last = j.channelPath[j.channelPath.length - 1];
    exitCh.set(last, (exitCh.get(last) || 0) + 1);
  }

  const total = journeys.length || 1;
  const pct = (m: Map<string, number>) => {
    const o: Record<string, number> = {};
    for (const [k, v] of m) o[k] = Math.round((v / total) * 100);
    return o;
  };

  // Normalized transition matrix
  const matrix: Record<string, Record<string, number>> = {};
  for (const ct of ctMap.values()) {
    if (!matrix[ct.from]) matrix[ct.from] = {};
    matrix[ct.from][ct.to] = ct.count;
  }
  for (const from in matrix) {
    const sum = Object.values(matrix[from]).reduce((a, b) => a + b, 0);
    if (sum > 0) for (const to in matrix[from]) matrix[from][to] = +(matrix[from][to] / sum).toFixed(3);
  }

  // Common paths
  const pathFreq = new Map<string, number>();
  for (const j of journeys) pathFreq.set(JSON.stringify(j.channelPath), (pathFreq.get(JSON.stringify(j.channelPath)) || 0) + 1);
  const commonPaths = [...pathFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, c]) => ({ path: JSON.parse(p), count: c, conversion_rate: 0 }));

  // Matches prod INSERT from probabilistic-attribution.ts line 668
  const jaRow = `INSERT INTO journey_analytics (
  org_tag, channel_distribution, entry_channels, exit_channels,
  transition_matrix, total_sessions, converting_sessions, conversion_rate,
  avg_path_length, common_paths, data_quality_level, data_quality_report,
  total_conversions, matched_conversions, match_breakdown,
  period_start, period_end
) VALUES (
  ${esc(ORG_TAG)},
  ${esc(JSON.stringify(pct(chCounts)))},
  ${esc(JSON.stringify(pct(entryCh)))},
  ${esc(JSON.stringify(pct(exitCh)))},
  ${esc(JSON.stringify(matrix))},
  ${total}, 0, 0,
  ${(totalLen / total).toFixed(2)},
  ${esc(JSON.stringify(commonPaths))},
  3,
  ${esc(JSON.stringify({ level: 3, confidence: 0.75, gaps: [], source: "prod_r2_sql_seed" }))},
  0, 0,
  ${esc(JSON.stringify({ identity: 0, time_proximity: 0, direct_tag: 0, unmatched: total }))},
  ${esc(periodStart)},
  ${esc(periodEnd)}
) ON CONFLICT (org_tag, period_start, period_end) DO UPDATE SET
  channel_distribution = excluded.channel_distribution,
  entry_channels = excluded.entry_channels,
  exit_channels = excluded.exit_channels,
  transition_matrix = excluded.transition_matrix,
  total_sessions = excluded.total_sessions,
  avg_path_length = excluded.avg_path_length,
  common_paths = excluded.common_paths,
  computed_at = datetime('now');`;

  console.log(`      ${total} sessions, ${chCounts.size} channels, avg path ${(totalLen / total).toFixed(1)} steps.`);

  // =========================================================================
  // Execute against local D1
  // =========================================================================
  console.log("\n[INSERT] Writing to local ANALYTICS_DB...");

  // Clear previous seed data for this org
  const clearSql = [
    `DELETE FROM journeys WHERE org_tag = '${ORG_TAG}' AND id LIKE 'j_prod_%';`,
    `DELETE FROM funnel_transitions WHERE org_tag = '${ORG_TAG}';`,
    `DELETE FROM channel_transitions WHERE org_tag = '${ORG_TAG}';`,
    `DELETE FROM journey_analytics WHERE org_tag = '${ORG_TAG}';`,
  ];

  const allStatements = [...clearSql, ...journeyRows, ...ctRows, ...ftRows, jaRow];
  const BATCH = 80;
  const batches: string[] = [];
  for (let i = 0; i < allStatements.length; i += BATCH) {
    batches.push(allStatements.slice(i, i + BATCH).join("\n"));
  }

  console.log(`      ${allStatements.length} statements → ${batches.length} batch(es)\n`);

  let ok = 0;
  for (let i = 0; i < batches.length; i++) {
    const path = join(TMP_DIR, `seed-events-batch-${i}.sql`);
    writeFileSync(path, batches[i], "utf-8");
    try {
      execSync(`npx wrangler d1 execute ANALYTICS_DB --local --env local --file="${path}"`, {
        cwd: API_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      ok++;
      process.stdout.write(`      Batch ${ok}/${batches.length} ✓\r`);
    } catch (e: any) {
      const err = e.stderr?.toString() || e.stdout?.toString() || "";
      console.error(`\n      Batch ${i + 1} FAILED: ${err.slice(0, 300)}`);
    }
  }

  // Also save full SQL for debugging
  const fullPath = join(TMP_DIR, "seed-prod-events.sql");
  writeFileSync(fullPath, allStatements.join("\n\n"), "utf-8");

  console.log(`\n\n=== Done ===`);
  console.log(`  Journeys:             ${journeyRows.length}`);
  console.log(`  Channel transitions:  ${ctRows.length}`);
  console.log(`  Funnel transitions:   ${ftRows.length} (page→page flow graph)`);
  console.log(`  Journey analytics:    1\n`);
  console.log(`  Source: ${SOURCE_ORG} (${DAYS}d from R2 SQL event_data_v5)`);
  console.log(`  Target: ${ORG_TAG} in local ANALYTICS_DB`);
  console.log(`  SQL:    ${fullPath}\n`);
}

main().catch((err) => {
  console.error("\nFatal:", err.message || err);
  process.exit(1);
});
