import { ConversionEvent } from '../services/eventAnalytics';

// Sample data pools
const EVENT_TYPES = [
  'page_view', 'add_to_cart', 'checkout', 'purchase',
  'signup', 'login', 'subscription', 'download',
  'video_play', 'form_submit', 'click', 'scroll'
];

const UTM_SOURCES = [
  'google', 'facebook', 'twitter', 'linkedin', 'instagram',
  'email', 'direct', 'organic', 'referral', 'youtube'
];

const UTM_MEDIUMS = [
  'cpc', 'cpm', 'social', 'email', 'organic',
  'referral', 'display', 'video', 'affiliate'
];

const UTM_CAMPAIGNS = [
  'summer_sale', 'black_friday', 'new_product', 'brand_awareness',
  'retargeting', 'newsletter', 'webinar', 'ebook_download'
];

const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'tv', 'wearable'];

const BROWSERS = [
  'Chrome', 'Safari', 'Firefox', 'Edge', 'Opera',
  'Samsung Internet', 'UC Browser', 'Mobile Safari'
];

const COUNTRIES = [
  'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'BR',
  'IN', 'CN', 'MX', 'ES', 'IT', 'NL', 'SE', 'KR'
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'];

export interface GenerateOptions {
  organizationId: string;
  count: number;
  startDate?: Date;
  endDate?: Date;
  eventTypes?: string[];
  includeJourneys?: boolean;
  seed?: number;
}

export class EventGenerator {
  private userPool: string[] = [];
  private sessionPool: string[] = [];
  private random: () => number;

  constructor(seed?: number) {
    // Simple seeded random if needed
    if (seed !== undefined) {
      let s = seed;
      this.random = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    } else {
      this.random = Math.random;
    }

    // Initialize user pool
    for (let i = 0; i < 100; i++) {
      this.userPool.push(`user_${this.generateId(8)}`);
    }
  }

  /**
   * Generate multiple random events
   */
  generateEvents(options: GenerateOptions): ConversionEvent[] {
    const {
      organizationId,
      count,
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      endDate = new Date(),
      eventTypes = EVENT_TYPES,
      includeJourneys = false,
    } = options;

    if (includeJourneys) {
      return this.generateJourneyEvents(organizationId, count, startDate, endDate);
    }

    const events: ConversionEvent[] = [];
    const timeRange = endDate.getTime() - startDate.getTime();

    for (let i = 0; i < count; i++) {
      const timestamp = new Date(
        startDate.getTime() + this.random() * timeRange
      );
      events.push(this.generateSingleEvent(organizationId, timestamp, eventTypes));
    }

    return events.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Generate a single random event
   */
  private generateSingleEvent(
    organizationId: string,
    timestamp: Date,
    eventTypes: string[]
  ): ConversionEvent {
    const eventType = this.randomChoice(eventTypes);
    
    // Generate event value based on type
    let eventValue = 0;
    if (eventType === 'purchase') {
      eventValue = Math.round((10 + this.random() * 490) * 100) / 100;
    } else if (['subscription', 'checkout'].includes(eventType)) {
      eventValue = Math.round((20 + this.random() * 180) * 100) / 100;
    } else if (eventType === 'add_to_cart') {
      eventValue = Math.round((5 + this.random() * 95) * 100) / 100;
    }

    // Select or create user/session
    const userId = this.randomChoice(this.userPool);
    let sessionId: string;
    
    if (this.sessionPool.length > 0 && this.random() < 0.7) {
      sessionId = this.randomChoice(this.sessionPool);
    } else {
      sessionId = `session_${this.generateId(12)}`;
      this.sessionPool.push(sessionId);
      if (this.sessionPool.length > 50) {
        this.sessionPool.shift();
      }
    }

    const event: ConversionEvent = {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      event_id: `evt_${this.generateId(12)}`,
      timestamp: timestamp.toISOString(),
      event_type: eventType,
      event_value: eventValue,
      currency: eventValue > 0 ? this.randomChoice(CURRENCIES) : 'USD',
      user_id: userId,
      session_id: sessionId,
    };

    // Add optional fields with varying probability
    if (this.random() < 0.8) {
      event.utm_source = this.randomChoice(UTM_SOURCES);
      event.utm_medium = this.randomChoice(UTM_MEDIUMS);
      
      if (this.random() < 0.6) {
        event.utm_campaign = this.randomChoice(UTM_CAMPAIGNS);
      }
    }

    if (this.random() < 0.9) {
      event.device_type = this.randomChoice(DEVICE_TYPES);
      event.browser = this.randomChoice(BROWSERS);
    }

    if (this.random() < 0.95) {
      event.country = this.randomChoice(COUNTRIES);
    }

    if (this.random() < 0.3) {
      const pathLength = Math.floor(this.random() * 4) + 1;
      const pathSources: string[] = [];
      for (let i = 0; i < pathLength; i++) {
        pathSources.push(this.randomChoice(UTM_SOURCES));
      }
      event.attribution_path = pathSources.join(' > ');
    }

    return event;
  }

  /**
   * Generate user journey events
   */
  private generateJourneyEvents(
    organizationId: string,
    totalEvents: number,
    startDate: Date,
    endDate: Date
  ): ConversionEvent[] {
    const events: ConversionEvent[] = [];
    const eventsPerJourney = 5; // Average events per journey
    const numJourneys = Math.floor(totalEvents / eventsPerJourney);
    const timeRange = endDate.getTime() - startDate.getTime();

    for (let i = 0; i < numJourneys; i++) {
      const journeyStart = new Date(
        startDate.getTime() + this.random() * timeRange
      );
      const userId = `user_${this.generateId(8)}`;
      const sessionId = `session_${this.generateId(12)}`;
      
      const journey = this.generateUserJourney(
        organizationId,
        userId,
        sessionId,
        journeyStart
      );
      
      events.push(...journey);
    }

    return events.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Generate a realistic user journey
   */
  private generateUserJourney(
    organizationId: string,
    userId: string,
    sessionId: string,
    startTime: Date
  ): ConversionEvent[] {
    const journey: ConversionEvent[] = [];
    let currentTime = new Date(startTime);

    // Typical user journey sequence
    const journeySequence: Array<[string, number, number]> = [
      ['page_view', 0, 0],
      ['click', 1, 0],
      ['page_view', 2, 0],
      ['add_to_cart', 5, 20 + this.random() * 80],
      ['checkout', 8, 0],
      ['purchase', 10, 20 + this.random() * 80],
    ];

    // Randomly truncate journey (not all users complete purchase)
    const journeyLength = this.random() < 0.6 
      ? journeySequence.length 
      : Math.floor(2 + this.random() * 3);

    const utmSource = this.randomChoice(UTM_SOURCES);
    const utmMedium = this.randomChoice(UTM_MEDIUMS);
    const utmCampaign = this.randomChoice(UTM_CAMPAIGNS);
    const deviceType = this.randomChoice(DEVICE_TYPES);
    const browser = this.randomChoice(BROWSERS);
    const country = this.randomChoice(COUNTRIES);

    for (let i = 0; i < Math.min(journeyLength, journeySequence.length); i++) {
      const [eventType, minutesLater, value] = journeySequence[i];
      currentTime = new Date(currentTime.getTime() + minutesLater * 60 * 1000);

      const event: ConversionEvent = {
        id: crypto.randomUUID(),
        organization_id: organizationId,
        event_id: `evt_${this.generateId(12)}`,
        timestamp: currentTime.toISOString(),
        event_type: eventType,
        event_value: value,
        currency: 'USD',
        user_id: userId,
        session_id: sessionId,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        device_type: deviceType,
        browser: browser,
        country: country,
      };

      journey.push(event);
    }

    return journey;
  }

  /**
   * Helper to pick random element from array
   */
  private randomChoice<T>(array: T[]): T {
    return array[Math.floor(this.random() * array.length)];
  }

  /**
   * Generate random ID
   */
  private generateId(length: number): string {
    const chars = 'abcdef0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(this.random() * chars.length)];
    }
    return result;
  }

  /**
   * Generate sample events with specific patterns
   */
  static generateSampleData(options: GenerateOptions): ConversionEvent[] {
    const generator = new EventGenerator(options.seed);
    return generator.generateEvents(options);
  }
}