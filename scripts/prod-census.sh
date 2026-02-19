#!/bin/bash
# Production D1 Census - counts every row in every table across all databases
# Runs queries in parallel batches for speed
set -uo pipefail

OUTFILE="/tmp/prod-census-results.txt"
> "$OUTFILE"

count_table() {
  local db_name="$1"
  local table="$2"
  local result
  result=$(npx wrangler d1 execute "$db_name" --remote --command "SELECT COUNT(*) as c FROM $table" 2>&1)
  local count=$(echo "$result" | grep -oE '"c": [0-9]+' | head -1 | grep -oE '[0-9]+')
  if [ -z "$count" ]; then
    count="ERR"
  fi
  echo "$db_name|$table|$count" >> "$OUTFILE"
  echo "$db_name|$table|$count"
}

echo "=== PRODUCTION D1 CENSUS === $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# DB tables
DB_TABLES="active_event_workflows active_shopify_workflows admin_impersonation_logs admin_invites admin_task_comments admin_tasks ai_optimization_settings audit_logs auth_audit_logs config_audit_logs connector_configs connector_filter_rules consent_configurations conversion_goals dashboard_layouts data_access_logs email_verification_tokens event_sync_watermarks goal_branches goal_conversion_stats goal_group_members goal_groups goal_relationships goal_templates goal_value_history identity_mappings identity_merges invitations oauth_states onboarding_progress onboarding_steps org_tag_mappings org_tracking_configs organization_members organizations password_reset_tokens platform_connections rate_limits script_hashes security_events sessions shard_routing stripe_metadata_keys sync_jobs terms_acceptance tracking_domains tracking_links users waitlist webhook_endpoints webhook_events"

# AI_DB tables
AI_TABLES="ai_decisions ai_tool_registry analysis_jobs analysis_logs analysis_prompts analysis_summaries attribution_model_results cac_baselines cac_predictions"

# ANALYTICS_DB tables
AN_TABLES="accounting_customers accounting_expenses accounting_invoices ad_campaigns ad_groups ad_metrics ads affiliate_conversions affiliate_partners affiliate_referrals aggregation_jobs analytics_events analytics_sessions analytics_users attribution_events attribution_installs attribution_results attribution_revenue cac_history campaign_period_summary channel_transitions comm_campaigns comm_engagements comm_subscribers connector_sync_status conversion_attribution conversion_daily_summary conversion_value_allocations conversions crm_activities crm_companies crm_contacts crm_deals customer_identities daily_metrics domain_claims ecommerce_customers ecommerce_orders ecommerce_products events_attendees events_definitions events_registrations facebook_pages forms_definitions forms_responses forms_submissions funnel_transitions goal_completion_metrics goal_conversions goal_metrics_daily handoff_observations handoff_patterns hourly_metrics identity_link_events jobber_clients jobber_invoices jobber_jobs journey_analytics journey_touchpoints journeys org_daily_summary org_timeseries payments_customers payments_subscriptions payments_transactions platform_comparison reviews_items reviews_profiles reviews_responses scheduling_appointments scheduling_customers scheduling_services shopify_orders shopify_refunds social_followers social_metrics social_posts social_profiles stripe_charges stripe_daily_summary stripe_subscriptions support_conversations support_customers support_tickets sync_watermarks tracked_clicks utm_performance"

# Shard tables
SHARD_TABLES="ad_campaigns ad_groups ad_metrics ads"

BATCH=8

run_batch() {
  local db="$1"
  shift
  local tables=("$@")
  local pids=()
  local i=0

  for t in "${tables[@]}"; do
    count_table "$db" "$t" &
    pids+=($!)
    i=$((i+1))
    if [ $((i % BATCH)) -eq 0 ]; then
      for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null; done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null; done
}

echo ""
echo "--- DB (clearlift-db-prod) ---"
read -ra db_arr <<< "$DB_TABLES"
run_batch "clearlift-db-prod" "${db_arr[@]}"

echo ""
echo "--- AI_DB (clearlift-ai-prod) ---"
read -ra ai_arr <<< "$AI_TABLES"
run_batch "clearlift-ai-prod" "${ai_arr[@]}"

echo ""
echo "--- ANALYTICS_DB (clearlift-analytics-prod) ---"
read -ra an_arr <<< "$AN_TABLES"
run_batch "clearlift-analytics-prod" "${an_arr[@]}"

echo ""
echo "--- SHARD_0 ---"
read -ra sh_arr <<< "$SHARD_TABLES"
run_batch "clearlift-shard-0" "${sh_arr[@]}"

echo ""
echo "--- SHARD_1 ---"
run_batch "clearlift-shard-1" "${sh_arr[@]}"

echo ""
echo "=== SUMMARY ==="
echo ""
# Sort and format
sort -t'|' -k1,1 -k2,2 "$OUTFILE" | awk -F'|' '{printf "%-28s %-40s %8s\n", $1, $2, $3}'
echo ""
echo "Total rows:"
awk -F'|' '$3 != "ERR" {sum+=$3} END {print sum}' "$OUTFILE"
