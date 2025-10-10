// =============== Configuration ===============
const CONFIG = {
    API_BASE: 'https://api.clearlift.ai',
    UPDATE_INTERVAL: 30000,

    PLATFORMS: {
        'google-ads': { name: 'Google Ads', color: '#4285f4', bgClass: 'bg-blue-50', icon: 'fab fa-google' },
        'meta-ads': { name: 'Meta Ads', color: '#1877f2', bgClass: 'bg-indigo-50', icon: 'fab fa-facebook' },
        'tiktok-ads': { name: 'TikTok Ads', color: '#000000', bgClass: 'bg-gray-50', icon: 'fab fa-tiktok' },
        'linkedin': { name: 'LinkedIn Ads', color: '#0077b5', bgClass: 'bg-cyan-50', icon: 'fab fa-linkedin' },
        'amazon': { name: 'Amazon Ads', color: '#ff9900', bgClass: 'bg-orange-50', icon: 'fab fa-amazon' },
        google: { name: 'Google Ads', color: '#4285f4', bgClass: 'bg-blue-50', icon: 'fab fa-google' },
        meta: { name: 'Meta Ads', color: '#1877f2', bgClass: 'bg-indigo-50', icon: 'fab fa-facebook' },
        tiktok: { name: 'TikTok Ads', color: '#000000', bgClass: 'bg-gray-50', icon: 'fab fa-tiktok' }
    }
};

// =============== Application State ===============
const AppState = {
    currentOrg: null,
    lookbackDays: 30,
    timelineView: 'overall',

    eventsData: null,
    campaignData: null,
    conversionData: null,
    processedData: null,

    hasData: false,
    loading: true,
    error: null,

    charts: {},

    auth: null
};

// =============== API Service ===============
const APIService = {
    async fetchUserOrganizations() {
        return await this._apiCall('/v1/user/organizations', null, 'GET');
    },

    async fetchEvents(orgTag, limit = 1000, lookback = 30) {
        const lookbackStr = `${lookback}d`;
        return await this._apiCall(`/v1/analytics/events?org_tag=${orgTag}&limit=${limit}&lookback=${lookbackStr}`, null, 'GET');
    },

    async fetchAds(orgId, platform = 'facebook', lookback = 30, groupBy = 'campaign') {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - lookback);
        const endDate = new Date();
        return await this._apiCall(
            `/v1/analytics/ads/${platform}?org_id=${orgId}&start_date=${startDate.toISOString().split('T')[0]}&end_date=${endDate.toISOString().split('T')[0]}&group_by=${groupBy}`,
            null,
            'GET'
        );
    },

    async fetchConversions(orgId, lookback = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - lookback);
        const endDate = new Date();
        return await this._apiCall(
            `/v1/analytics/conversions?org_id=${orgId}&start_date=${startDate.toISOString().split('T')[0]}&end_date=${endDate.toISOString().split('T')[0]}&group_by=date`,
            null,
            'GET'
        );
    },

    async fetchInsights(orgId) {
        return await this._apiCall(`/api/insights?org_id=${orgId}&limit=10&status=active`, null, 'GET');
    },

    async fetchDecisions(orgId, lookback = 30) {
        return await this._apiCall(`/api/decisions?org_id=${orgId}&lookback_days=${lookback}`, null, 'GET');
    },

    async _apiCall(endpoint, data, method = 'POST') {
        const baseUrl = CONFIG.API_BASE;
        const token = sessionStorage.getItem('cf_access_token') || localStorage.getItem('session_token') || '';

        console.log(`API Call: ${endpoint}`, { method, requestData: data });

        try {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                }
            };

            if (data && method !== 'GET') {
                options.body = JSON.stringify(data);
            }

            const response = await fetch(`${baseUrl}${endpoint}`, options);

            if (!response.ok) {
                console.error(`API call failed: ${endpoint}`, response.status, response.statusText);
                throw new Error(`API call failed: ${response.statusText}`);
            }

            const result = await response.json();
            console.log(`API Response from ${endpoint}:`, result);
            return result;
        } catch (error) {
            console.error(`API Error: ${endpoint}`, error);
            throw error;
        }
    }
};

// =============== Data Processor ===============
const DataProcessor = {
    processEventsData(eventsResponse) {
        console.log('processEventsData called with:', eventsResponse);
        if (!eventsResponse || !eventsResponse.success) return null;

        const events = eventsResponse.data.events || [];
        console.log(`Processing ${events.length} events`);

        // Calculate unique sessions and users (use anonymous_id for visitors)
        const uniqueSessions = new Set(events.map(e => e.session_id)).size;
        const uniqueUsers = new Set(events.map(e => e.anonymous_id || e.user_id).filter(id => id)).size;

        console.log('Unique calculations:', { uniqueSessions, uniqueUsers, sampleIds: events.slice(0, 3).map(e => ({anon: e.anonymous_id, user: e.user_id})) });

        // Count event types
        const eventTypes = {};
        events.forEach(e => {
            eventTypes[e.event_type] = (eventTypes[e.event_type] || 0) + 1;
        });

        // Top pages
        const pageViews = {};
        events.filter(e => e.event_type === 'page_view').forEach(e => {
            pageViews[e.page_path] = (pageViews[e.page_path] || 0) + 1;
        });
        const topPages = Object.entries(pageViews)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([path, count]) => ({ path, count }));

        // Top UTM sources
        const utmSources = {};
        events.filter(e => e.utm_source).forEach(e => {
            utmSources[e.utm_source] = (utmSources[e.utm_source] || 0) + 1;
        });
        const topSources = Object.entries(utmSources)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([source, count]) => ({ source, count }));

        // Build time series data (sessions and events by date)
        const timeSeriesMap = new Map();
        events.forEach(e => {
            const date = e.timestamp ? e.timestamp.split('T')[0] : null;
            if (!date) return;

            if (!timeSeriesMap.has(date)) {
                timeSeriesMap.set(date, {
                    date,
                    sessions: new Set(),
                    events: 0
                });
            }

            const dayData = timeSeriesMap.get(date);
            dayData.events++;
            if (e.session_id) dayData.sessions.add(e.session_id);
        });

        const timeSeries = Array.from(timeSeriesMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(d => ({
                date: d.date,
                sessions: d.sessions.size,
                events: d.events
            }));

        const result = {
            totalEvents: events.length,
            uniqueSessions,
            uniqueUsers,
            eventTypes,
            topPages,
            topSources,
            timeSeries,
            rawEvents: events
        };

        console.log('processEventsData returning:', {
            totalEvents: result.totalEvents,
            uniqueSessions: result.uniqueSessions,
            uniqueUsers: result.uniqueUsers,
            eventTypesCount: Object.keys(result.eventTypes).length,
            timeSeriesCount: result.timeSeries.length
        });

        return result;
    },

    processApiData(campaignData, conversionData, dailyAdsData) {
        console.log('processApiData called with:', {
            campaignData: campaignData,
            conversionData: conversionData,
            dailyAdsData: dailyAdsData
        });

        if (!campaignData && !conversionData) {
            console.log('No data provided to processApiData');
            return null;
        }

        const campaigns = campaignData?.data?.results || [];
        const campaignSummary = campaignData?.data?.summary || {};
        const convSummary = conversionData?.data?.summary || {};
        const convEvents = conversionData?.data?.events || [];

        console.log('Extracted data:', {
            campaignsCount: campaigns.length,
            summary: campaignSummary,
            convSummary: convSummary,
            convEventsCount: convEvents.length
        });

        // Build time series from daily ads data
        const timeSeries = this.buildTimeSeries(dailyAdsData, conversionData);

        const totalSpend = campaignSummary.total_spend || 0;
        const totalRevenue = campaignSummary.total_revenue || 0;
        const totalConversions = campaignSummary.total_conversions || convSummary.total_events || 0;
        const totalClicks = campaignSummary.total_clicks || 0;
        const totalImpressions = campaignSummary.total_impressions || 0;

        const hasData = campaigns.length > 0 || convEvents.length > 0;

        const platformStats = this.derivePlatformStats(campaigns, campaignSummary);

        const result = {
            hasData: hasData,
            totals: {
                spend: totalSpend,
                revenue: totalRevenue,
                conversions: totalConversions,
                roas: campaignSummary.average_roas || campaignSummary.avg_roas || (totalSpend > 0 ? totalRevenue / totalSpend : 0),
                cac: totalConversions > 0 ? totalSpend / totalConversions : 0,
                ctr: campaignSummary.average_ctr || campaignSummary.avg_ctr || 0,
                cpc: campaignSummary.average_cpc || campaignSummary.avg_cpc || 0,
                clicks: totalClicks,
                impressions: totalImpressions
            },
            changes: {
                spend: campaignSummary.spend_change || 0,
                revenue: campaignSummary.revenue_change || convSummary.revenue_change || 0,
                conversions: campaignSummary.conversion_change || convSummary.conversion_change || 0,
                roas: campaignSummary.roas_change || 0,
                cac: campaignSummary.cac_change || 0,
                ctr: campaignSummary.ctr_change || 0
            },
            campaigns: campaigns,
            timeSeries: timeSeries,
            platforms: platformStats,
            platformTimeSeries: campaignData?.data?.platform_time_series || campaignData?.platform_time_series || null,
            campaignTimeSeries: campaignData?.data?.campaign_time_series || campaignData?.campaign_time_series || null,
            attribution: campaignData?.data?.attribution || campaignData?.attribution || null
        };

        console.log('processApiData returning:', result);
        return result;
    },

    buildTimeSeries(dailyAdsData, conversionData) {
        console.log('buildTimeSeries called with:', {
            hasDailyAds: !!dailyAdsData,
            hasConversions: !!conversionData
        });

        if (!dailyAdsData && !conversionData) {
            return { dates: [], spend: [], conversions: [], revenue: [] };
        }

        // Get daily ads array
        const dailyAds = dailyAdsData?.data?.results || [];
        const dailyConversions = conversionData?.data?.by_date || [];

        // Create a map of date -> data
        const dateMap = new Map();

        // Add ads data
        dailyAds.forEach(day => {
            if (day.date) {
                dateMap.set(day.date, {
                    date: day.date,
                    spend: day.spend || 0,
                    impressions: day.impressions || 0,
                    clicks: day.clicks || 0,
                    conversions: 0,
                    revenue: 0
                });
            }
        });

        // Merge conversion data
        dailyConversions.forEach(day => {
            if (day.date) {
                if (dateMap.has(day.date)) {
                    const existing = dateMap.get(day.date);
                    existing.conversions = day.conversions || 0;
                    existing.revenue = day.revenue || 0;
                } else {
                    dateMap.set(day.date, {
                        date: day.date,
                        spend: 0,
                        impressions: 0,
                        clicks: 0,
                        conversions: day.conversions || 0,
                        revenue: day.revenue || 0
                    });
                }
            }
        });

        // Convert to arrays sorted by date
        const sortedData = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));

        const timeSeries = {
            dates: sortedData.map(d => d.date),
            spend: sortedData.map(d => d.spend),
            conversions: sortedData.map(d => d.conversions),
            revenue: sortedData.map(d => d.revenue),
            impressions: sortedData.map(d => d.impressions),
            clicks: sortedData.map(d => d.clicks)
        };

        console.log('buildTimeSeries returning:', {
            datesCount: timeSeries.dates.length,
            firstDate: timeSeries.dates[0],
            lastDate: timeSeries.dates[timeSeries.dates.length - 1],
            totalSpend: timeSeries.spend.reduce((a, b) => a + b, 0),
            totalConversions: timeSeries.conversions.reduce((a, b) => a + b, 0)
        });

        return timeSeries;
    },

    derivePlatformStats(campaigns, summary) {
        if (!campaigns || campaigns.length === 0) {
            return {};
        }

        const platformStats = {};

        campaigns.forEach(campaign => {
            const platform = campaign.platform || 'meta-ads';

            if (!platformStats[platform]) {
                platformStats[platform] = {
                    spend: 0,
                    revenue: 0,
                    conversions: 0,
                    impressions: 0,
                    clicks: 0
                };
            }

            const metrics = campaign.metrics || {};
            platformStats[platform].spend += metrics.spend || 0;
            platformStats[platform].revenue += metrics.revenue || 0;
            platformStats[platform].conversions += metrics.conversions || 0;
            platformStats[platform].impressions += metrics.impressions || 0;
            platformStats[platform].clicks += metrics.clicks || 0;
        });

        Object.keys(platformStats).forEach(platform => {
            const stats = platformStats[platform];
            stats.roas = stats.spend > 0 ? stats.revenue / stats.spend : 0;
            stats.ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
            stats.cac = stats.conversions > 0 ? stats.spend / stats.conversions : 0;
        });

        console.log('Derived platform stats:', platformStats);
        return platformStats;
    }
};

// =============== UI Manager ===============
const UIManager = {
    showLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'flex';
    },

    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
    },

    updateEventsKPIs(eventsData) {
        if (!eventsData) return;

        const sessionsEl = document.getElementById('kpiSessions');
        if (sessionsEl) sessionsEl.textContent = this.formatNumber(eventsData.uniqueSessions);

        const usersEl = document.getElementById('kpiUsers');
        if (usersEl) usersEl.textContent = this.formatNumber(eventsData.uniqueUsers);

        const eventsEl = document.getElementById('kpiEvents');
        if (eventsEl) eventsEl.textContent = this.formatNumber(eventsData.totalEvents);
    },

    updateTopPages(eventsData) {
        if (!eventsData || !eventsData.topPages) return;

        const tbody = document.getElementById('topPagesTableBody');
        if (!tbody) return;

        tbody.innerHTML = eventsData.topPages.map((page, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${page.path}</td>
                <td>${this.formatNumber(page.count)}</td>
            </tr>
        `).join('');
    },

    updateTopSources(eventsData) {
        if (!eventsData || !eventsData.topSources) return;

        const tbody = document.getElementById('topSourcesTableBody');
        if (!tbody) return;

        if (eventsData.topSources.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 20px; color: #94a3b8;">
                        No UTM source data available
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = eventsData.topSources.map((source, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${source.source}</td>
                <td>${this.formatNumber(source.count)}</td>
            </tr>
        `).join('');
    },

    updateWebsiteCharts(eventsData) {
        console.log('updateWebsiteCharts called with:', eventsData);
        if (!eventsData) {
            console.warn('No eventsData provided to updateWebsiteCharts');
            return;
        }

        // Update Event Types Chart
        console.log('Updating event types chart, chart exists:', !!AppState.charts.eventTypes, 'data exists:', !!eventsData.eventTypes);
        if (AppState.charts.eventTypes && eventsData.eventTypes) {
            const eventTypeData = Object.entries(eventsData.eventTypes)
                .sort((a, b) => b[1] - a[1]);

            AppState.charts.eventTypes.data.labels = eventTypeData.map(([type]) =>
                type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            );
            AppState.charts.eventTypes.data.datasets[0].data = eventTypeData.map(([_, count]) => count);
            console.log('Event types chart updated with:', {
                labels: AppState.charts.eventTypes.data.labels,
                data: AppState.charts.eventTypes.data.datasets[0].data
            });
            AppState.charts.eventTypes.update();
        }

        // Update Traffic Timeline Chart
        console.log('Updating traffic timeline chart, chart exists:', !!AppState.charts.trafficTimeline, 'timeSeries exists:', !!eventsData.timeSeries);
        if (AppState.charts.trafficTimeline && eventsData.timeSeries) {
            const dates = eventsData.timeSeries.map(d => d.date);
            const sessions = eventsData.timeSeries.map(d => d.sessions);
            const events = eventsData.timeSeries.map(d => d.events);

            AppState.charts.trafficTimeline.data.labels = dates;
            AppState.charts.trafficTimeline.data.datasets[0].data = sessions;
            AppState.charts.trafficTimeline.data.datasets[1].data = events;
            AppState.charts.trafficTimeline.update();
        }
    },

    showNoDataMessage() {
        const mainContent = document.getElementById('mainContent');
        if (!mainContent) return;

        const kpiSection = document.querySelector('.kpi-section');
        if (kpiSection) {
            kpiSection.innerHTML = `
                <div style="
                    grid-column: 1 / -1;
                    text-align: center;
                    padding: 60px 20px;
                    background: white;
                    border-radius: 12px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                ">
                    <i class="fas fa-chart-line" style="
                        font-size: 48px;
                        color: #e5e7eb;
                        margin-bottom: 16px;
                    "></i>

                    <h3 style="
                        color: #1e293b;
                        font-size: 20px;
                        font-weight: 600;
                        margin-bottom: 8px;
                    ">No Campaign Data Yet</h3>

                    <p style="
                        color: #64748b;
                        margin-bottom: 20px;
                    ">
                        Connect your advertising platforms to start seeing data
                    </p>

                    <button onclick="window.location.href='/onboarding'" style="
                        background: #3b82f6;
                        color: white;
                        border: none;
                        padding: 10px 24px;
                        border-radius: 6px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                    ">
                        Complete Setup
                    </button>
                </div>
            `;
        }
    },

    updateKPICards(data) {
        if (!data || !data.totals) return;

        const spendEl = document.getElementById('kpiSpend');
        if (spendEl) spendEl.textContent = this.formatCurrency(data.totals.spend);
        this.updateChange('kpiSpendChange', data.changes.spend);

        const roasEl = document.getElementById('kpiRoas');
        if (roasEl) roasEl.textContent = data.totals.roas.toFixed(1) + 'x';
        this.updateChange('kpiRoasChange', data.changes.roas);

        const cacEl = document.getElementById('kpiCac');
        if (cacEl) cacEl.textContent = this.formatCurrency(data.totals.cac);
        this.updateChange('kpiCacChange', data.changes.cac, true);

        const ctrEl = document.getElementById('kpiCtr');
        if (ctrEl) ctrEl.textContent = data.totals.ctr.toFixed(1) + '%';
        this.updateChange('kpiCtrChange', data.changes.ctr);

        const convEl = document.getElementById('kpiConversions');
        if (convEl) convEl.textContent = this.formatNumber(data.totals.conversions);
        this.updateChange('kpiConvChange', data.changes.conversions);

        if (data.timeSeries) {
            this.drawSparklines(data.timeSeries);
        }
    },

    updateChange(elementId, value, inverse = false) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const isPositive = inverse ? value < 0 : value > 0;
        element.innerHTML = `
            <i class="fas fa-arrow-trend-${isPositive ? 'up' : 'down'}"></i>
            <span>${value > 0 ? '+' : ''}${value.toFixed(1)}%</span>
        `;
        element.className = `kpi-change ${isPositive ? 'positive' : 'negative'}`;
    },

    drawSparklines(timeSeries) {
        if (!timeSeries) return;

        if (timeSeries.spend) this.drawSparkline('sparklineSpend', timeSeries.spend, '#3b82f6');
        if (timeSeries.roas) this.drawSparkline('sparklineRoas', timeSeries.roas, '#10b981');
        if (timeSeries.cac) this.drawSparkline('sparklineCac', timeSeries.cac, '#f59e0b');
        if (timeSeries.ctr) this.drawSparkline('sparklineCtr', timeSeries.ctr, '#8b5cf6');
        if (timeSeries.conversions) this.drawSparkline('sparklineConversions', timeSeries.conversions, '#ec4899');
    },

    drawSparkline(containerId, data, color) {
        try {
            const container = document.getElementById(containerId);
            if (!container) return;

            let canvas = container.querySelector('canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.width = 64;
                canvas.height = 32;
                container.appendChild(canvas);
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const width = canvas.width;
            const height = canvas.height;

            ctx.clearRect(0, 0, width, height);

            if (!data || data.length === 0) return;

            const max = Math.max(...data);
            const min = Math.min(...data);
            const range = max - min || 1;

            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();

            data.forEach((value, index) => {
                const x = (index / (data.length - 1)) * width;
                const y = height - ((value - min) / range) * (height - 4) - 2;

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.stroke();
        } catch (error) {
            console.error(`Error drawing sparkline ${containerId}:`, error);
        }
    },

    formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value || 0);
    },

    formatNumber(value) {
        return new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value || 0);
    },

    initCharts() {
        const timelineCanvas = document.getElementById('timelineChart');
        if (timelineCanvas && window.Chart) {
            AppState.charts.timeline = new Chart(timelineCanvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: []
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom'
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) label += ': ';
                                    if (context.parsed.y !== null) {
                                        label += context.dataset.label.includes('CAC') ?
                                            `$${context.parsed.y.toFixed(2)}` :
                                            `${context.parsed.y.toFixed(1)}x`;
                                    }
                                    return label;
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'CAC ($)'
                            }
                        }
                    }
                }
            });
        }

        const attrCanvas = document.getElementById('attributionChart');
        if (attrCanvas && window.Chart) {
            AppState.charts.attribution = new Chart(attrCanvas, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: []
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y'
                }
            });
        }

        const budgetFlowCanvas = document.getElementById('budgetFlowChart');
        if (budgetFlowCanvas && window.Chart) {
            AppState.charts.budgetFlow = new Chart(budgetFlowCanvas, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: []
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            stacked: true,
                            title: {
                                display: true,
                                text: 'Date'
                            }
                        },
                        y: {
                            stacked: true,
                            title: {
                                display: true,
                                text: 'Budget ($)'
                            },
                            ticks: {
                                callback: function(value) {
                                    return '$' + value.toLocaleString();
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                usePointStyle: true
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) label += ': ';
                                    label += '$' + context.parsed.y.toLocaleString();
                                    return label;
                                }
                            }
                        }
                    }
                }
            });
        }

        const budgetPieCanvas = document.getElementById('budgetPieChart');
        if (budgetPieCanvas && window.Chart) {
            AppState.charts.budgetPie = new Chart(budgetPieCanvas, {
                type: 'pie',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            '#3b82f6',
                            '#10b981',
                            '#f59e0b',
                            '#ef4444',
                            '#8b5cf6'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom' }
                    }
                }
            });
        }

        // Website Analytics Charts
        const eventTypesCanvas = document.getElementById('eventTypesChart');
        if (eventTypesCanvas && window.Chart) {
            AppState.charts.eventTypes = new Chart(eventTypesCanvas, {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            '#3b82f6',  // blue
                            '#10b981',  // green
                            '#f59e0b',  // orange
                            '#ef4444',  // red
                            '#8b5cf6',  // purple
                            '#06b6d4',  // cyan
                            '#ec4899'   // pink
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { padding: 15 }
                        }
                    }
                }
            });
        }

        const trafficTimelineCanvas = document.getElementById('trafficTimelineChart');
        if (trafficTimelineCanvas && window.Chart) {
            AppState.charts.trafficTimeline = new Chart(trafficTimelineCanvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Sessions',
                            data: [],
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            tension: 0.3,
                            fill: true
                        },
                        {
                            label: 'Events',
                            data: [],
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.1)',
                            tension: 0.3,
                            fill: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top' }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { precision: 0 }
                        }
                    }
                }
            });
        }
    },

    updateCharts(data) {
        if (!data) {
            console.log('updateCharts: No data provided');
            return;
        }

        console.log('updateCharts called with data:', {
            hasTimeSeries: !!data.timeSeries,
            timeSeriesKeys: data.timeSeries ? Object.keys(data.timeSeries) : [],
            hasPlatforms: !!data.platforms,
            hasPlatformTimeSeries: !!data.platformTimeSeries,
            hasCampaignTimeSeries: !!data.campaignTimeSeries,
            hasAttribution: !!data.attribution
        });

        if (AppState.charts.timeline && data.timeSeries) {
            console.log('Updating CAC Timeline with view:', AppState.timelineView);

            let datasets = [];
            const dates = data.timeSeries.dates || [];

            if (AppState.timelineView === 'overall') {
                const cacData = data.timeSeries.cac || data.timeSeries.spend?.map((s, i) => {
                    const conversions = data.timeSeries.conversions?.[i] || 1;
                    return conversions > 0 ? (s / conversions) : 0;
                }) || [];

                datasets.push({
                    label: 'Overall CAC',
                    data: cacData,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.3,
                    fill: true
                });
            } else if (AppState.timelineView === 'platforms') {
                if (data.platformTimeSeries && Object.keys(data.platformTimeSeries).length > 0) {
                    Object.entries(data.platformTimeSeries).forEach(([platform, platformData]) => {
                        const config = CONFIG.PLATFORMS[platform];
                        if (!config) {
                            console.warn(`No config for platform in timeline: ${platform}`);
                            return;
                        }

                        const cacData = platformData.spend?.map((s, i) => {
                            const conversions = platformData.conversions?.[i] || 1;
                            return conversions > 0 ? (s / conversions) : 0;
                        }) || [];

                        datasets.push({
                            label: config.name,
                            data: cacData,
                            borderColor: config.color,
                            backgroundColor: `${config.color}20`,
                            tension: 0.3,
                            fill: false
                        });
                    });
                } else {
                    const cacData = data.timeSeries.cac || data.timeSeries.spend?.map((s, i) => {
                        const conversions = data.timeSeries.conversions?.[i] || 1;
                        return conversions > 0 ? (s / conversions) : 0;
                    }) || [];

                    datasets.push({
                        label: 'Overall CAC',
                        data: cacData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        tension: 0.3,
                        fill: true
                    });
                }
            } else if (AppState.timelineView === 'campaigns') {
                if (data.campaignTimeSeries && Object.keys(data.campaignTimeSeries).length > 0) {
                    Object.entries(data.campaignTimeSeries).forEach(([campaign, campaignData], index) => {
                        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#f97316'];
                        const color = colors[index % colors.length];

                        const cacData = campaignData.spend?.map((s, i) => {
                            const conversions = campaignData.conversions?.[i] || 1;
                            return conversions > 0 ? (s / conversions) : 0;
                        }) || [];

                        datasets.push({
                            label: campaignData.name || campaign,
                            data: cacData,
                            borderColor: color,
                            backgroundColor: `${color}20`,
                            tension: 0.3,
                            fill: false
                        });
                    });
                } else {
                    const cacData = data.timeSeries.cac || data.timeSeries.spend?.map((s, i) => {
                        const conversions = data.timeSeries.conversions?.[i] || 1;
                        return conversions > 0 ? (s / conversions) : 0;
                    }) || [];

                    datasets.push({
                        label: 'Overall CAC',
                        data: cacData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        tension: 0.3,
                        fill: true
                    });
                }
            }

            if (AppState.decisions && AppState.decisions.length > 0) {
                const decisionsByDate = {};
                AppState.decisions.forEach(decision => {
                    const date = new Date(decision.executed_at || decision.created_at).toLocaleDateString();
                    if (!decisionsByDate[date]) {
                        decisionsByDate[date] = [];
                    }
                    decisionsByDate[date].push(decision);
                });

                const annotations = {};
                Object.entries(decisionsByDate).forEach(([date, decisions]) => {
                    const dateIndex = dates.findIndex(d => new Date(d).toLocaleDateString() === date);
                    if (dateIndex >= 0) {
                        annotations[`decision-${date}`] = {
                            type: 'line',
                            xMin: dateIndex,
                            xMax: dateIndex,
                            borderColor: 'rgba(156, 163, 175, 0.5)',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: {
                                content: `${decisions.length} decision${decisions.length > 1 ? 's' : ''}`,
                                enabled: true,
                                position: 'top'
                            }
                        };
                    }
                });

                if (!AppState.charts.timeline.options.plugins) {
                    AppState.charts.timeline.options.plugins = {};
                }
                AppState.charts.timeline.options.plugins.annotation = {
                    annotations: annotations
                };
            }

            AppState.charts.timeline.data.labels = dates;
            AppState.charts.timeline.data.datasets = datasets;

            AppState.charts.timeline.options.scales = {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'CAC ($)'
                    }
                }
            };

            AppState.charts.timeline.update();
        }

        if (AppState.charts.attribution && data.attribution) {
            const attrData = data.attribution || {
                firstTouch: 25,
                lastTouch: 35,
                linear: 20,
                timeDecay: 15,
                dataDriver: 5
            };

            AppState.charts.attribution.data.labels = Object.keys(attrData).map(key => {
                const labels = {
                    firstTouch: 'First Touch',
                    lastTouch: 'Last Touch',
                    linear: 'Linear',
                    timeDecay: 'Time Decay',
                    dataDriver: 'Data Driven'
                };
                return labels[key] || key;
            });

            AppState.charts.attribution.data.datasets = [{
                label: 'Attribution %',
                data: Object.values(attrData),
                backgroundColor: [
                    '#3b82f6',
                    '#10b981',
                    '#f59e0b',
                    '#8b5cf6',
                    '#ef4444'
                ]
            }];

            AppState.charts.attribution.update();
        }

        if (AppState.charts.budgetFlow) {
            console.log('Updating Budget Flow chart');

            const dates = data.timeSeries?.dates || [];
            const datasets = [];

            if (data.campaignTimeSeries && Object.keys(data.campaignTimeSeries).length > 0) {
                console.log('Using campaign time series for budget chart');
                const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#f97316'];

                Object.entries(data.campaignTimeSeries).forEach(([campaignId, campaignData], index) => {
                    const color = colors[index % colors.length];

                    datasets.push({
                        label: campaignData.name || campaignId,
                        data: campaignData.spend || [],
                        backgroundColor: color,
                        borderColor: color,
                        borderWidth: 1
                    });
                });
            } else if (data.campaigns && data.campaigns.length > 0) {
                console.log('Creating synthetic campaign data from campaign list');
                const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#f97316'];

                data.campaigns.forEach((campaign, index) => {
                    const color = colors[index % colors.length];

                    const dailySpend = (campaign.metrics?.spend || 0) / Math.max(dates.length, 1);
                    const dailyData = dates.map(() => dailySpend);

                    datasets.push({
                        label: campaign.campaign_name,
                        data: dailyData,
                        backgroundColor: color,
                        borderColor: color,
                        borderWidth: 1
                    });
                });
            } else if (data.platformTimeSeries && Object.keys(data.platformTimeSeries).length > 0) {
                console.log('Using platform time series');
                Object.entries(data.platformTimeSeries).forEach(([platform, platformData]) => {
                    const config = CONFIG.PLATFORMS[platform];
                    if (!config) {
                        console.warn(`No config for platform: ${platform}`);
                        return;
                    }

                    datasets.push({
                        label: config.name,
                        data: platformData.spend || [],
                        backgroundColor: config.color,
                        borderColor: config.color,
                        borderWidth: 1
                    });
                });
            } else if (data.platforms) {
                console.log('Creating synthetic platform data from totals');
                Object.entries(data.platforms).forEach(([platform, stats]) => {
                    const config = CONFIG.PLATFORMS[platform];
                    if (!config) return;

                    const dailySpend = stats.spend / Math.max(dates.length, 1);
                    const dailyData = dates.map(() => dailySpend);

                    datasets.push({
                        label: config.name,
                        data: dailyData,
                        backgroundColor: config.color,
                        borderColor: config.color,
                        borderWidth: 1
                    });
                });
            }

            if (AppState.decisions && AppState.decisions.length > 0) {
                const decisionsByDate = {};
                AppState.decisions.forEach(decision => {
                    const date = new Date(decision.executed_at || decision.created_at).toLocaleDateString();
                    const dateIndex = dates.findIndex(d => new Date(d).toLocaleDateString() === date);
                    if (dateIndex >= 0) {
                        if (!decisionsByDate[dateIndex]) {
                            decisionsByDate[dateIndex] = [];
                        }
                        decisionsByDate[dateIndex].push(decision);
                    }
                });

                if (!AppState.charts.budgetFlow.options.plugins) {
                    AppState.charts.budgetFlow.options.plugins = {};
                }

                const annotations = {};
                Object.entries(decisionsByDate).forEach(([index, decisions]) => {
                    annotations[`decision-${index}`] = {
                        type: 'line',
                        xMin: parseInt(index),
                        xMax: parseInt(index),
                        borderColor: 'rgba(239, 68, 68, 0.5)',
                        borderWidth: 2,
                        borderDash: [5, 5]
                    };
                });

                AppState.charts.budgetFlow.options.plugins.annotation = {
                    annotations: annotations
                };
            }

            if (datasets.length > 0) {
                console.log(`Updating budget chart with ${datasets.length} datasets`);
                AppState.charts.budgetFlow.data.labels = dates;
                AppState.charts.budgetFlow.data.datasets = datasets;
                AppState.charts.budgetFlow.update();
            } else if (data.timeSeries) {
                console.log('Using fallback total budget data');
                const budgetData = data.timeSeries.spend || [];

                AppState.charts.budgetFlow.data.labels = data.timeSeries.dates || [];
                AppState.charts.budgetFlow.data.datasets = [{
                    label: 'Total Budget',
                    data: budgetData,
                    backgroundColor: '#3b82f6',
                    borderColor: '#3b82f6',
                    borderWidth: 1
                }];
                AppState.charts.budgetFlow.update();
            }
        }

        if (AppState.charts.budgetPie && data.platforms) {
            const platformData = Object.entries(data.platforms);
            console.log('Updating Budget Pie chart with platforms:', platformData);

            const labels = platformData.map(([key]) => CONFIG.PLATFORMS[key]?.name || key);
            const values = platformData.map(([_, stats]) => stats.spend || 0);

            AppState.charts.budgetPie.data.labels = labels;
            AppState.charts.budgetPie.data.datasets[0].data = values;
            AppState.charts.budgetPie.update();
        }

        if (AppState.charts.attribution && data.attribution) {
            console.log('Updating Attribution Analysis chart with:', data.attribution);

            const platforms = Object.keys(data.attribution);
            const models = ['Linear Attribution', 'Last Touch', 'First Touch'];

            const datasets = models.map((model, index) => {
                const colors = ['#3b82f6', '#ef4444', '#10b981'];

                let dataValues;
                if (model === 'Linear Attribution') {
                    dataValues = platforms.map(p => data.attribution[p].conversions);
                } else if (model === 'Last Touch') {
                    dataValues = platforms.map(p => {
                        const base = data.attribution[p].conversions;
                        return p.includes('google') ? base * 1.3 : base * 0.7;
                    });
                } else {
                    dataValues = platforms.map(p => {
                        const base = data.attribution[p].conversions;
                        return p.includes('meta') || p.includes('tiktok') ? base * 1.2 : base * 0.8;
                    });
                }

                return {
                    label: model,
                    data: dataValues,
                    backgroundColor: colors[index] + '80',
                    borderColor: colors[index],
                    borderWidth: 1
                };
            });

            AppState.charts.attribution.data.labels = platforms.map(p => {
                const config = CONFIG.PLATFORMS[p];
                return config ? config.name : p;
            });
            AppState.charts.attribution.data.datasets = datasets;
            AppState.charts.attribution.update();
        }
    },

    updateCampaignTable(campaigns) {
        const tbody = document.getElementById('campaignsTableBody');
        if (!tbody) return;

        if (!campaigns || campaigns.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 32px; color: #94a3b8;">
                        No campaigns found. Connect your advertising platforms to see campaign data.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = campaigns.slice(0, 10).map(campaign => `
            <tr>
                <td>${campaign.campaign_name || 'Unnamed Campaign'}</td>
                <td><span class="platform-badge">meta</span></td>
                <td><span class="status-${(campaign.status || 'unknown').toLowerCase()}">${campaign.status || 'Unknown'}</span></td>
                <td>${(campaign.metrics?.roas || 0).toFixed(1)}x</td>
                <td>${(campaign.metrics?.ctr || 0).toFixed(1)}%</td>
                <td>${this.formatCurrency(campaign.metrics?.spend || 0)}</td>
                <td>${campaign.metrics?.conversions || 0}</td>
            </tr>
        `).join('');
    },

    updatePlatformBreakdown(type, data) {
        const breakdownEl = document.getElementById(`breakdown-${type}`);
        if (!breakdownEl || !data || !data.platforms) return;

        const platformData = Object.entries(data.platforms);

        breakdownEl.innerHTML = platformData.map(([platform, stats]) => {
            const platformConfig = CONFIG.PLATFORMS[platform] || {};

            let mainValue, mainDisplay;
            switch(type) {
                case 'spend':
                    mainValue = stats.spend || 0;
                    mainDisplay = this.formatCurrency(mainValue);
                    break;
                case 'roas':
                    mainValue = stats.revenue && stats.spend ? (stats.revenue / stats.spend) : 0;
                    mainDisplay = `${mainValue.toFixed(1)}x`;
                    break;
                case 'cac':
                    mainValue = stats.conversions && stats.spend ? (stats.spend / stats.conversions) : 0;
                    mainDisplay = this.formatCurrency(mainValue);
                    break;
                case 'ctr':
                    mainValue = stats.ctr || 0;
                    mainDisplay = `${mainValue.toFixed(2)}%`;
                    break;
                case 'conversions':
                    mainValue = stats.conversions || 0;
                    mainDisplay = this.formatNumber(mainValue);
                    break;
                default:
                    mainValue = 0;
                    mainDisplay = '0';
            }

            const total = platformData.reduce((sum, [_, s]) => {
                switch(type) {
                    case 'spend': return sum + (s.spend || 0);
                    case 'conversions': return sum + (s.conversions || 0);
                    default: return sum + 1;
                }
            }, 0);
            const percentage = total > 0 ? ((type === 'spend' ? stats.spend :
                                            type === 'conversions' ? stats.conversions : 0) / total * 100) : 0;

            return `
                <div class="platform-item" data-platform="${platform}" onclick="ClearLift.switchTimelineToplatform('${platform}')">
                    <div class="platform-info">
                        <span class="platform-icon" style="background-color: ${platformConfig.color || '#6366f1'};">
                            <i class="${platformConfig.icon || 'fas fa-ad'}"></i>
                        </span>
                        <div class="platform-data">
                            <span class="platform-name">${platformConfig.name || platform}</span>
                            <span class="platform-value">${mainDisplay}</span>
                        </div>
                        ${percentage > 0 ? `<span class="platform-percentage">${percentage.toFixed(0)}%</span>` : ''}
                    </div>
                    <div class="platform-bar">
                        <div class="platform-bar-fill" style="width: ${percentage}%; background-color: ${platformConfig.color || '#6366f1'};"></div>
                    </div>
                </div>
            `;
        }).join('') || '<div class="empty-state">No platform data available</div>';
    },

    updateDecisionTrail(decisions) {
        const trailList = document.getElementById('decisionTrailList');
        if (!trailList) return;

        const sortedDecisions = (decisions || []).sort((a, b) => {
            const dateA = new Date(a.executed_at || a.created_at || a.date);
            const dateB = new Date(b.executed_at || b.created_at || b.date);
            return dateB - dateA;
        });

        if (sortedDecisions.length === 0) {
            trailList.innerHTML = '<p style="color: #94a3b8; text-align: center; padding: 20px;">No decisions made yet</p>';
            return;
        }

        trailList.innerHTML = sortedDecisions.slice(0, 10).map(decision => {
            const date = new Date(decision.executed_at || decision.created_at || decision.date);
            const timeAgo = this.getTimeAgo(date);

            const actionIcons = {
                'increase_budget': { icon: '📈', color: '#10b981' },
                'decrease_budget': { icon: '📉', color: '#f59e0b' },
                'pause_campaign': { icon: '⏸️', color: '#ef4444' },
                'redistribute_budget': { icon: '🔄', color: '#3b82f6' },
                'optimize_keywords': { icon: '🎯', color: '#8b5cf6' },
                'expand_targeting': { icon: '🎯', color: '#06b6d4' },
                'accepted': { icon: '✅', color: '#10b981' },
                'rejected': { icon: '❌', color: '#ef4444' }
            };

            const actionConfig = actionIcons[decision.action] || actionIcons[decision.decision_type] || { icon: '📊', color: '#6b7280' };

            let impactHtml = '';
            if (decision.outcome || decision.impact) {
                const impact = decision.outcome || decision.impact;
                if (typeof impact === 'object') {
                    if (impact.cost_savings) {
                        impactHtml = `<span style="color: #10b981;">Saved $${impact.cost_savings.toLocaleString()}</span>`;
                    } else if (impact.additional_revenue) {
                        impactHtml = `<span style="color: #3b82f6;">+$${impact.additional_revenue.toLocaleString()}</span>`;
                    } else if (impact.roas_change) {
                        impactHtml = `<span style="color: #8b5cf6;">${impact.roas_change > 0 ? '+' : ''}${impact.roas_change}x ROAS</span>`;
                    }
                } else if (typeof impact === 'string') {
                    impactHtml = `<span style="color: #6b7280;">${impact}</span>`;
                }
            }

            return `
                <div class="decision-item" style="
                    display: flex;
                    align-items: flex-start;
                    gap: 12px;
                    padding: 12px;
                    border-bottom: 1px solid #e5e7eb;
                ">
                    <div style="
                        font-size: 20px;
                        width: 32px;
                        height: 32px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        background: ${actionConfig.color}20;
                        border-radius: 8px;
                    ">${actionConfig.icon}</div>
                    <div style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span style="font-weight: 500; color: #1e293b;">
                                ${decision.title || decision.action?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Decision'}
                            </span>
                            <span style="font-size: 12px; color: #94a3b8;">${timeAgo}</span>
                        </div>
                        <div style="font-size: 14px; color: #64748b; margin-bottom: 4px;">
                            ${decision.description || decision.parameters?.description || ''}
                        </div>
                        ${impactHtml ? `<div style="font-size: 13px;">${impactHtml}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    },

    getTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        const intervals = [
            { label: 'year', seconds: 31536000 },
            { label: 'month', seconds: 2592000 },
            { label: 'day', seconds: 86400 },
            { label: 'hour', seconds: 3600 },
            { label: 'minute', seconds: 60 }
        ];

        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
            }
        }
        return 'Just now';
    }
};

const DashboardManager = {
    async applyInsight(insightId, action) {
        try {
            const response = await APIService._apiCall('/api/insights/decision', {
                insight_id: insightId,
                action: action,
                decision_type: 'accepted',
                parameters: {}
            }, 'POST');

            if (response.success) {
                const card = document.querySelector(`[data-insight-id="${insightId}"]`);
                if (card) {
                    card.style.opacity = '0.6';
                    const buttons = card.querySelector('div:last-child');
                    buttons.innerHTML = '<span style="color: #10b981; font-size: 12px;">✓ Applied</span>';
                }

                Dashboard.loadInsights();
                Dashboard.loadDecisions();
            }
        } catch (error) {
            console.error('Failed to apply insight:', error);
        }
    },

    async dismissInsight(insightId) {
        try {
            const response = await APIService._apiCall('/api/insights/decision', {
                insight_id: insightId,
                action: 'dismiss',
                decision_type: 'rejected',
                parameters: {}
            }, 'POST');

            if (response.success) {
                const card = document.querySelector(`[data-insight-id="${insightId}"]`);
                if (card) {
                    card.style.opacity = '0.6';
                    const buttons = card.querySelector('div:last-child');
                    buttons.innerHTML = '<span style="color: #6b7280; font-size: 12px;">✗ Dismissed</span>';
                }

                Dashboard.loadInsights();
                Dashboard.loadDecisions();
            }
        } catch (error) {
            console.error('Failed to dismiss insight:', error);
        }
    },

    switchTimelineView(view) {
        AppState.timelineView = view;

        document.querySelectorAll('.timeline-section .btn-group button').forEach(btn => {
            btn.classList.remove('active');
            if (btn.textContent.toLowerCase().includes(view) ||
                (view === 'overall' && btn.textContent === 'Overall') ||
                (view === 'platforms' && btn.textContent === 'By Platform') ||
                (view === 'campaigns' && btn.textContent === 'By Campaign')) {
                btn.classList.add('active');
            }
        });

        if (AppState.processedData) {
            UIManager.updateCharts(AppState.processedData);
        }
    }
};

window.DashboardManager = DashboardManager;

const Dashboard = {
    async init() {
        console.log('Initializing dashboard...');

        try {
            const token = sessionStorage.getItem('cf_access_token') ||
                         localStorage.getItem('session_token');

            if (!token) {
                console.log('No auth token found, redirecting to login');
                window.location.href = '/';
                return;
            }

            await this.loadOrganizations();

            const orgId = localStorage.getItem('current_org_id');
            if (!orgId) {
                console.log('No organization selected, redirecting to onboarding');
                window.location.href = '/onboarding';
                return;
            }

            AppState.currentOrg = { id: orgId };

            UIManager.initCharts();
            this.setupEventListeners();

            await this.loadData();

            UIManager.hideLoading();

        } catch (error) {
            console.error('Dashboard initialization failed:', error);
            UIManager.hideLoading();
            UIManager.showNoDataMessage();
        }
    },

    async loadOrganizations() {
        try {
            const response = await APIService.fetchUserOrganizations();
            const organizations = response?.data?.organizations || [];

            if (organizations.length === 0) {
                console.warn('No organizations found for user');
                return;
            }

            const currentOrgId = localStorage.getItem('current_org_id');
            let selectedOrg = organizations.find(org => org.id === currentOrgId);

            if (!selectedOrg) {
                // Fallback to first org if current org not found
                selectedOrg = organizations[0];
                localStorage.setItem('current_org_id', selectedOrg.id);
                localStorage.setItem('current_org_name', selectedOrg.name);
                if (selectedOrg.org_tag) {
                    localStorage.setItem('current_org_tag', selectedOrg.org_tag);
                }
            } else {
                // Org was found - only update org_tag from API (in case it changed server-side)
                // DO NOT overwrite org_id or org_name that were set by switchOrganization()
                if (selectedOrg.org_tag) {
                    localStorage.setItem('current_org_tag', selectedOrg.org_tag);
                }
            }

            const currentOrgName = document.getElementById('currentOrgName');
            if (currentOrgName) {
                currentOrgName.textContent = selectedOrg.name;
            }

            const orgDropdownMenu = document.getElementById('orgDropdownMenu');
            if (orgDropdownMenu) {
                orgDropdownMenu.innerHTML = organizations.map(org => `
                    <div class="org-item ${org.id === selectedOrg.id ? 'active' : ''}"
                         onclick="Dashboard.switchOrganization('${org.id}', '${org.name}', '${org.org_tag || ''}')">
                        <span class="org-name">${org.name}</span>
                        <span class="org-role">${org.role}</span>
                        ${org.id === selectedOrg.id ? '<i class="fas fa-check"></i>' : ''}
                    </div>
                `).join('');
            }

            console.log(`Loaded ${organizations.length} organizations, selected: ${selectedOrg.name}`);
        } catch (error) {
            console.error('Failed to load organizations:', error);
        }
    },

    switchOrganization(orgId, orgName, orgTag) {
        console.log('🔄 Switching to org:', { orgId, orgName, orgTag });

        localStorage.setItem('current_org_id', orgId);
        localStorage.setItem('current_org_name', orgName);
        if (orgTag) {
            localStorage.setItem('current_org_tag', orgTag);
        }

        console.log('✅ localStorage after switch:', {
            id: localStorage.getItem('current_org_id'),
            name: localStorage.getItem('current_org_name'),
            tag: localStorage.getItem('current_org_tag')
        });

        // Update AppState
        AppState.currentOrg = { id: orgId };

        // Update UI immediately
        const orgNameEl = document.getElementById('currentOrgName');
        if (orgNameEl) {
            orgNameEl.textContent = orgName;
            console.log('✅ Updated org name in UI to:', orgName);
        }

        // Close dropdown
        const orgMenu = document.getElementById('orgDropdownMenu');
        if (orgMenu) {
            orgMenu.classList.remove('show');
            console.log('✅ Closed dropdown menu');
        }

        // Reload data with new org (no page refresh!)
        console.log('🔄 Reloading data for new org...');
        this.loadData();
    },

    async loadData() {
        try {
            const orgTag = localStorage.getItem('current_org_tag') || 'test-org';

            const promises = [
                APIService.fetchEvents(orgTag, 1000, AppState.lookbackDays).catch(err => {
                    console.warn('Events fetch failed:', err);
                    return null;
                }),
                APIService.fetchAds(AppState.currentOrg.id, 'meta', AppState.lookbackDays).catch(err => {
                    console.warn('Ads fetch failed:', err);
                    return null;
                }),
                // Fetch daily ads data for time series charts
                APIService.fetchAds(AppState.currentOrg.id, 'meta', AppState.lookbackDays, 'date').catch(err => {
                    console.warn('Daily ads fetch failed:', err);
                    return null;
                }),
                APIService.fetchConversions(AppState.currentOrg.id, AppState.lookbackDays).catch(err => {
                    console.warn('Conversion fetch failed:', err);
                    return null;
                })
            ];

            const [eventsResponse, adsResponse, dailyAdsResponse, conversionData] = await Promise.all(promises);

            // Process events data
            console.log('📊 eventsResponse received:', eventsResponse);
            AppState.eventsData = DataProcessor.processEventsData(eventsResponse);
            console.log('📊 AppState.eventsData set to:', AppState.eventsData);

            // Process ads as campaign data
            AppState.campaignData = adsResponse;
            AppState.conversionData = conversionData;

            const processedData = DataProcessor.processApiData(adsResponse, conversionData, dailyAdsResponse);

            if (!processedData && !AppState.eventsData) {
                console.log('No data received from API');
                UIManager.showNoDataMessage();
                return;
            }

            AppState.processedData = processedData;
            AppState.hasData = processedData?.hasData || AppState.eventsData;

            this.updateUI();

            if (!processedData?.hasData && !AppState.eventsData) {
                UIManager.showNoDataMessage();
            }

            // Optional features - don't fail if endpoints don't exist
            this.loadInsights();
            this.loadDecisions();

        } catch (error) {
            console.error('Failed to load dashboard data:', error);
            UIManager.showNoDataMessage();
        }
    },

    async loadDecisions() {
        try {
            const decisions = await APIService.fetchDecisions(AppState.currentOrg.id, AppState.lookbackDays);
            if (decisions && decisions.decisions) {
                AppState.decisions = decisions.decisions;
                UIManager.updateDecisionTrail(decisions.decisions);

                if (AppState.processedData) {
                    UIManager.updateCharts(AppState.processedData);
                }
            }
        } catch (error) {
            console.warn('Failed to load decisions (endpoint may not exist yet):', error);
        }
    },

    async loadInsights() {
        try {
            const insights = await APIService.fetchInsights(AppState.currentOrg.id);
            if (insights && insights.insights) {
                this.renderInsights(insights.insights);
            }
        } catch (error) {
            console.warn('Failed to load insights (endpoint may not exist yet):', error);
        }
    },

    renderInsights(insights) {
        const container = document.getElementById('recommendationsContainer');
        if (!container) return;

        const loading = document.getElementById('aiLoading');
        if (loading) loading.style.display = 'none';

        if (!insights || insights.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #94a3b8;">No insights available yet.</p>';
            return;
        }

        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        insights.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

        container.innerHTML = insights.slice(0, 5).map(insight => {
            const severityColors = {
                critical: { bg: '#fef2f2', color: '#dc2626' },
                high: { bg: '#fef3c7', color: '#d97706' },
                medium: { bg: '#fef3c7', color: '#f59e0b' },
                low: { bg: '#f3f4f6', color: '#6b7280' }
            };
            const colors = severityColors[insight.severity] || severityColors.low;

            let impactHtml = '';
            if (insight.potential_impact) {
                const impact = insight.potential_impact;
                if (impact.cost_savings) {
                    impactHtml += `<span style="color: #10b981;">Save $${impact.cost_savings.toLocaleString()}</span>`;
                }
                if (impact.additional_revenue) {
                    impactHtml += `<span style="color: #3b82f6;">+$${impact.additional_revenue.toLocaleString()} revenue</span>`;
                }
                if (impact.additional_conversions) {
                    impactHtml += `<span style="color: #8b5cf6;">+${impact.additional_conversions} conversions</span>`;
                }
            }

            return `
            <div class="insight-card" data-insight-id="${insight.id}" style="
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 12px;
                ${insight.decision ? 'opacity: 0.6;' : ''}
            ">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <h4 style="font-weight: 600; color: #1e293b;">${insight.title || 'Insight'}</h4>
                    <span style="
                        padding: 2px 8px;
                        border-radius: 4px;
                        font-size: 12px;
                        background: ${colors.bg};
                        color: ${colors.color};
                    ">${insight.severity || 'low'}</span>
                </div>
                <p style="color: #64748b; font-size: 14px; margin-bottom: 8px;">${insight.description || ''}</p>
                ${insight.recommendation ? `<p style="color: #475569; font-size: 13px; margin-bottom: 12px;"><strong>Recommendation:</strong> ${insight.recommendation}</p>` : ''}
                ${impactHtml ? `<div style="display: flex; gap: 12px; margin-bottom: 12px; font-size: 13px;">${impactHtml}</div>` : ''}
                <div style="display: flex; gap: 8px;">
                    ${!insight.decision ? `
                    <button onclick="DashboardManager.applyInsight('${insight.id}', '${insight.action || ''}')" style="
                        padding: 6px 12px;
                        background: #3b82f6;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        font-size: 12px;
                        cursor: pointer;
                    ">Apply</button>
                    <button onclick="DashboardManager.dismissInsight('${insight.id}')" style="
                        padding: 6px 12px;
                        background: transparent;
                        color: #6b7280;
                        border: 1px solid #e5e7eb;
                        border-radius: 4px;
                        font-size: 12px;
                        cursor: pointer;
                    ">Dismiss</button>
                    ` : `
                    <span style="color: #6b7280; font-size: 12px;">
                        ${insight.decision === 'accepted' ? '✓ Applied' : '✗ Dismissed'}
                    </span>
                    `}
                </div>
            </div>
            `;
        }).join('');
    },


    updateUI() {
        const data = AppState.processedData;

        // Update events analytics
        console.log('📊 updateUI called, AppState.eventsData:', AppState.eventsData);
        if (AppState.eventsData) {
            console.log('📊 Updating events UI components...');
            UIManager.updateEventsKPIs(AppState.eventsData);
            UIManager.updateWebsiteCharts(AppState.eventsData);
            UIManager.updateTopPages(AppState.eventsData);
            UIManager.updateTopSources(AppState.eventsData);
        } else {
            console.log('📊 No eventsData available, skipping events UI updates');
        }

        // Update ads/campaigns analytics
        if (data) {
            UIManager.updateKPICards(data);
            UIManager.updateCharts(data);
            UIManager.updateCampaignTable(data.campaigns);

            UIManager.updatePlatformBreakdown('spend', data);
            UIManager.updatePlatformBreakdown('roas', data);
            UIManager.updatePlatformBreakdown('cac', data);
            UIManager.updatePlatformBreakdown('ctr', data);
            UIManager.updatePlatformBreakdown('conversions', data);

            UIManager.updateDecisionTrail();
        }

        const timestamp = document.getElementById('lastUpdated');
        if (timestamp) {
            timestamp.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
        }
    },

    setupEventListeners() {
        const pillButtons = document.querySelectorAll('.pill-btn');
        pillButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                pillButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const viewMode = btn.dataset.view;
                AppState.timelineView = viewMode;
                console.log('Switching timeline view to:', viewMode);

                if (AppState.processedData) {
                    UIManager.updateCharts(AppState.processedData);
                }
            });
        });

        const timePeriod = document.getElementById('lookbackPeriod');
        if (timePeriod) {
            timePeriod.addEventListener('change', (e) => {
                AppState.lookbackDays = parseInt(e.target.value);
                this.loadData();
            });
        }

        const userMenuBtn = document.getElementById('userMenuBtn');
        const userDropdown = document.getElementById('userDropdown');
        if (userMenuBtn && userDropdown) {
            userMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                userDropdown.style.display =
                    userDropdown.style.display === 'block' ? 'none' : 'block';
            });

            document.addEventListener('click', (e) => {
                if (!userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
                    userDropdown.style.display = 'none';
                }
            });
        }

        const orgBtn = document.getElementById('orgDropdownBtn');
        const orgMenu = document.getElementById('orgDropdownMenu');
        if (orgBtn && orgMenu) {
            orgBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                orgMenu.classList.toggle('show');
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!orgBtn.contains(e.target) && !orgMenu.contains(e.target)) {
                    orgMenu.classList.remove('show');
                }
            });
        } else {
            console.warn('Organization dropdown elements not found:', {
                orgBtn: !!orgBtn,
                orgMenu: !!orgMenu
            });
        }

        const matrixBtn = document.getElementById('optimizationMatrixBtn');
        const sidebar = document.getElementById('optimizationSidebar');
        const sidebarClose = document.getElementById('sidebarClose');

        if (matrixBtn && sidebar) {
            matrixBtn.addEventListener('click', () => {
                sidebar.classList.add('open');
            });
        }

        if (sidebarClose && sidebar) {
            sidebarClose.addEventListener('click', () => {
                sidebar.classList.remove('open');
            });
        }
    }
};

window.ClearLift = {
    Dashboard,
    AppState,

    flipKPICard(metric) {
        const card = document.getElementById(`kpiCard-${metric}`);
        if (card) {
            card.classList.toggle('flipped');
        }
    },

    navigateTo(page) {
        console.log(`Navigating to ${page}`);
    },

    showHelp() {
        console.log('Showing help');
    },

    enableAutoPilot() {
        console.log('Enabling auto-pilot mode');
    },

    switchTimelineToplatform(platform) {
        console.log(`Switching timeline to show ${platform} data`);

        document.querySelectorAll('.kpi-card.flipped').forEach(card => {
            card.classList.remove('flipped');
        });

        if (AppState.charts.timeline && AppState.processedData) {
            const platformData = AppState.processedData.platforms[platform];
            if (platformData) {
                console.log(`Updating timeline for ${platform}:`, platformData);

                const platformConfig = CONFIG.PLATFORMS[platform];
                if (platformConfig) {
                    const titleEl = document.querySelector('.timeline-section .card-title');
                    if (titleEl) {
                        titleEl.textContent = `CAC Timeline - ${platformConfig.name}`;
                    }
                }
            }
        }
    }
};


document.addEventListener('DOMContentLoaded', () => {
    const userName = sessionStorage.getItem('user_name') ||
                    localStorage.getItem('user_name') || '';
    const userEmail = sessionStorage.getItem('user_email') ||
                     localStorage.getItem('user_email') || '';
    const orgName = localStorage.getItem('current_org_name') || 'Select Organization';

    const userNameDisplay = document.getElementById('userNameDisplay');
    if (userNameDisplay) userNameDisplay.textContent = userName || userEmail.split('@')[0] || 'User';

    const userFullName = document.getElementById('userFullName');
    if (userFullName) userFullName.textContent = userName || 'User';

    const userEmailEl = document.getElementById('userEmail');
    if (userEmailEl) userEmailEl.textContent = userEmail;

    const userAvatar = document.getElementById('userAvatar');
    if (userAvatar && userName) {
        userAvatar.textContent = userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    }

    const currentOrgName = document.getElementById('currentOrgName');
    if (currentOrgName) currentOrgName.textContent = orgName;

    Dashboard.init();
});

window.Dashboard = Dashboard;