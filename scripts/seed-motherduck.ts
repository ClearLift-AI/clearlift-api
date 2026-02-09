#!/usr/bin/env node
/**
 * Script to seed MotherDuck with test data
 * Run with: npx tsx scripts/seed-motherduck.ts
 */

import { MotherDuckService } from '../src/services/motherDuckService';

const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN;

if (!MOTHERDUCK_TOKEN) {
  console.error('❌ MOTHERDUCK_TOKEN environment variable is required. Set it in .dev.vars or your environment.');
  process.exit(1);
}

async function seedMotherDuck() {
  console.log('🦆 Connecting to MotherDuck...');
  
  const motherDuck = new MotherDuckService({
    token: MOTHERDUCK_TOKEN,
    database: 'clearlift'
  });

  try {
    // Create schemas
    console.log('📁 Creating schemas...');
    await motherDuck.executeQuery('CREATE SCHEMA IF NOT EXISTS campaigns');
    await motherDuck.executeQuery('CREATE SCHEMA IF NOT EXISTS events');
    await motherDuck.executeQuery('CREATE SCHEMA IF NOT EXISTS insights');
    await motherDuck.executeQuery('CREATE SCHEMA IF NOT EXISTS platforms');

    // Create tables
    console.log('📊 Creating tables...');
    
    // Campaigns table
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS campaigns.metrics (
        id VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
        organization_id VARCHAR NOT NULL,
        platform VARCHAR NOT NULL,
        campaign_id VARCHAR NOT NULL,
        campaign_name VARCHAR NOT NULL,
        campaign_type VARCHAR,
        status VARCHAR DEFAULT 'active',
        date DATE NOT NULL,
        impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0,
        spend DECIMAL(10,2) DEFAULT 0,
        conversions BIGINT DEFAULT 0,
        revenue DECIMAL(10,2) DEFAULT 0,
        ctr DECIMAL(5,4) DEFAULT 0,
        cpc DECIMAL(10,2) DEFAULT 0,
        cpa DECIMAL(10,2) DEFAULT 0,
        roas DECIMAL(10,2) DEFAULT 0,
        quality_score DECIMAL(3,1),
        budget_daily DECIMAL(10,2),
        budget_total DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (organization_id, platform, campaign_id, date)
      )
    `);

    // Events table
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS events.conversion_events (
        id VARCHAR,
        organization_id VARCHAR,
        event_id VARCHAR,
        timestamp TIMESTAMP,
        event_type VARCHAR,
        event_value DOUBLE,
        currency VARCHAR,
        user_id VARCHAR,
        session_id VARCHAR,
        utm_source VARCHAR,
        utm_medium VARCHAR,
        utm_campaign VARCHAR,
        device_type VARCHAR,
        browser VARCHAR,
        country VARCHAR,
        attribution_path VARCHAR
      )
    `);

    // Insights table
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS insights.recommendations (
        id VARCHAR PRIMARY KEY,
        organization_id VARCHAR NOT NULL,
        insight_type VARCHAR NOT NULL,
        severity VARCHAR CHECK (severity IN ('high', 'medium', 'low')),
        platform VARCHAR,
        campaign_id VARCHAR,
        title VARCHAR NOT NULL,
        recommendation TEXT NOT NULL,
        potential_impact DECIMAL(10,2),
        confidence_score DECIMAL(3,2),
        metadata JSON,
        status VARCHAR DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);

    // Platform accounts table
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS platforms.accounts (
        id VARCHAR PRIMARY KEY,
        organization_id VARCHAR NOT NULL,
        platform VARCHAR NOT NULL,
        account_id VARCHAR NOT NULL,
        account_name VARCHAR,
        currency VARCHAR DEFAULT 'USD',
        timezone VARCHAR DEFAULT 'UTC',
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_synced_at TIMESTAMP,
        sync_status VARCHAR DEFAULT 'active',
        metadata JSON
      )
    `);

    // Platform sync history
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS platforms.sync_history (
        id VARCHAR PRIMARY KEY,
        organization_id VARCHAR NOT NULL,
        platform VARCHAR NOT NULL,
        sync_type VARCHAR,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        status VARCHAR DEFAULT 'pending',
        records_synced INTEGER DEFAULT 0,
        error_message TEXT,
        date_from DATE,
        date_to DATE
      )
    `);

    // Insight decisions table
    await motherDuck.executeQuery(`
      CREATE TABLE IF NOT EXISTS insights.decisions (
        id VARCHAR PRIMARY KEY,
        insight_id VARCHAR NOT NULL,
        organization_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        decision VARCHAR CHECK (decision IN ('accept', 'reject')),
        reason TEXT,
        executed_at TIMESTAMP,
        execution_result JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Schemas and tables created successfully');

    // Generate test data
    console.log('🎲 Generating test data...');

    const testOrgId = 'test-org-123';
    const platforms = ['google-ads', 'meta-ads', 'tiktok-ads'];
    const campaignTypes = ['search', 'display', 'video', 'shopping'];
    const eventTypes = ['purchase', 'add_to_cart', 'view_item', 'signup'];
    
    // Seed platform accounts
    console.log('  → Seeding platform accounts...');
    for (const platform of platforms) {
      await motherDuck.executeQuery(`
        INSERT INTO platforms.accounts (
          id, organization_id, platform, account_id, account_name, currency, timezone
        ) VALUES (
          '${crypto.randomUUID()}',
          '${testOrgId}',
          '${platform}',
          '${platform}-account-001',
          'Test ${platform} Account',
          'USD',
          'America/New_York'
        ) ON CONFLICT DO NOTHING
      `);
    }

    // Seed campaign data (last 30 days)
    console.log('  → Seeding campaign metrics...');
    const campaigns = [];
    const today = new Date();
    
    for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
      const date = new Date(today);
      date.setDate(date.getDate() - daysAgo);
      const dateStr = date.toISOString().split('T')[0];
      
      for (const platform of platforms) {
        for (let i = 1; i <= 3; i++) {
          const impressions = Math.floor(Math.random() * 50000) + 10000;
          const clicks = Math.floor(impressions * (Math.random() * 0.05 + 0.01));
          const conversions = Math.floor(clicks * (Math.random() * 0.1 + 0.02));
          const spend = clicks * (Math.random() * 2 + 0.5);
          const revenue = conversions * (Math.random() * 100 + 50);
          
          campaigns.push({
            id: crypto.randomUUID(),
            organization_id: testOrgId,
            platform,
            campaign_id: `${platform}-camp-${i}`,
            campaign_name: `${platform} Campaign ${i}`,
            campaign_type: campaignTypes[Math.floor(Math.random() * campaignTypes.length)],
            status: 'active',
            date: dateStr,
            impressions,
            clicks,
            spend: Math.round(spend * 100) / 100,
            conversions,
            revenue: Math.round(revenue * 100) / 100,
            ctr: Math.round((clicks / impressions) * 10000) / 10000,
            cpc: Math.round((spend / clicks) * 100) / 100,
            cpa: conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : 0,
            roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
            quality_score: Math.round((Math.random() * 5 + 5) * 10) / 10,
            budget_daily: Math.round(Math.random() * 500 + 100),
            budget_total: Math.round(Math.random() * 10000 + 5000)
          });
        }
      }
    }

    // Write campaigns in batches
    await motherDuck.writeCampaignData(campaigns);
    console.log(`    ✓ Created ${campaigns.length} campaign records`);

    // Seed conversion events
    console.log('  → Seeding conversion events...');
    const events = [];
    
    for (let i = 0; i < 100; i++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date(today);
      date.setDate(date.getDate() - daysAgo);
      date.setHours(Math.floor(Math.random() * 24));
      date.setMinutes(Math.floor(Math.random() * 60));
      
      events.push({
        id: crypto.randomUUID(),
        organization_id: testOrgId,
        event_id: `evt_${crypto.randomUUID().slice(0, 12)}`,
        timestamp: date.toISOString(),
        event_type: eventTypes[Math.floor(Math.random() * eventTypes.length)],
        event_value: Math.round(Math.random() * 500 * 100) / 100,
        currency: 'USD',
        user_id: `user_${Math.floor(Math.random() * 1000)}`,
        session_id: crypto.randomUUID(),
        utm_source: platforms[Math.floor(Math.random() * platforms.length)],
        utm_medium: 'cpc',
        utm_campaign: `campaign_${Math.floor(Math.random() * 10)}`,
        device_type: ['desktop', 'mobile', 'tablet'][Math.floor(Math.random() * 3)],
        browser: ['Chrome', 'Safari', 'Firefox', 'Edge'][Math.floor(Math.random() * 4)],
        country: ['US', 'UK', 'CA', 'AU'][Math.floor(Math.random() * 4)],
        attribution_path: null
      });
    }

    await motherDuck.writeConversionEvents(events);
    console.log(`    ✓ Created ${events.length} conversion events`);

    // Seed insights
    console.log('  → Seeding AI insights...');
    const insightTypes = [
      { type: 'budget_optimization', title: 'Budget Reallocation Opportunity', severity: 'high' },
      { type: 'keyword_performance', title: 'Underperforming Keywords Detected', severity: 'medium' },
      { type: 'audience_expansion', title: 'Similar Audience Available', severity: 'low' },
      { type: 'bid_adjustment', title: 'Bid Strategy Optimization', severity: 'high' },
      { type: 'creative_fatigue', title: 'Ad Creative Refresh Needed', severity: 'medium' }
    ];

    for (const insightType of insightTypes) {
      const insightId = crypto.randomUUID();
      await motherDuck.createInsight({
        organization_id: testOrgId,
        insight_type: insightType.type,
        severity: insightType.severity as 'high' | 'medium' | 'low',
        platform: platforms[Math.floor(Math.random() * platforms.length)],
        campaign_id: null,
        title: insightType.title,
        recommendation: `Based on recent performance data, we recommend adjusting your ${insightType.type.replace('_', ' ')} strategy to improve ROI.`,
        potential_impact: Math.round(Math.random() * 5000 + 1000),
        confidence_score: Math.round(Math.random() * 30 + 70) / 100,
        metadata: { source: 'ai_analysis', version: '1.0' },
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
      console.log(`    ✓ Created insight: ${insightType.title}`);
    }

    // Seed sync history
    console.log('  → Seeding sync history...');
    for (const platform of platforms) {
      for (let i = 0; i < 5; i++) {
        const daysAgo = i * 2;
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - daysAgo);
        
        const endDate = new Date(startDate);
        endDate.setMinutes(endDate.getMinutes() + Math.floor(Math.random() * 10 + 1));
        
        await motherDuck.executeQuery(`
          INSERT INTO platforms.sync_history (
            id, organization_id, platform, sync_type, started_at, completed_at,
            status, records_synced, date_from, date_to
          ) VALUES (
            '${crypto.randomUUID()}',
            '${testOrgId}',
            '${platform}',
            'incremental',
            '${startDate.toISOString()}',
            '${endDate.toISOString()}',
            'completed',
            ${Math.floor(Math.random() * 1000 + 100)},
            '${startDate.toISOString().split('T')[0]}',
            '${startDate.toISOString().split('T')[0]}'
          )
        `);
      }
    }
    console.log('    ✓ Created sync history records');

    console.log('\n✅ Test data seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`  • Organization ID: ${testOrgId}`);
    console.log(`  • Platforms: ${platforms.join(', ')}`);
    console.log(`  • Campaign records: ${campaigns.length}`);
    console.log(`  • Conversion events: ${events.length}`);
    console.log(`  • AI insights: ${insightTypes.length}`);
    console.log(`  • Date range: Last 30 days`);

  } catch (error) {
    console.error('❌ Error seeding MotherDuck:', error);
    process.exit(1);
  }
}

// Run the seeding
seedMotherDuck().then(() => {
  console.log('\n🎉 Done! Your MotherDuck instance is ready for testing.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});