/**
 * Google Ads API Connector for API Worker
 * Simplified version for listing client accounts
 */

const GOOGLE_ADS_API_VERSION = 'v22';
const GOOGLE_ADS_BASE_URL = 'https://googleads.googleapis.com';

interface GoogleAdsCustomerResponse {
  resourceName: string;
  customer?: {
    id: string;
    manager: boolean;
    descriptiveName?: string;
  };
}

interface GoogleAdsCustomerClientResponse {
  results?: {
    customerClient?: {
      id: string | number;
      manager: boolean;
      status: string;
      descriptiveName?: string;
      currencyCode?: string;
      timeZone?: string;
    };
  }[];
}

export interface GoogleAdsClientAccount {
  id: string;
  name: string;
  currencyCode?: string;
  timeZone?: string;
}

export class GoogleAdsConnector {
  private readonly accessToken: string;
  private readonly customerId: string;
  private readonly developerToken: string;

  constructor(accessToken: string, customerId: string, developerToken: string) {
    this.accessToken = accessToken;
    this.customerId = customerId;
    this.developerToken = developerToken;
  }

  /**
   * Check if this account is a manager account
   */
  async isManagerAccount(): Promise<boolean> {
    try {
      const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${this.customerId}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'developer-token': this.developerToken
        }
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as GoogleAdsCustomerResponse;
      return data.resourceName && data.customer?.manager === true;
    } catch (error) {
      console.error('Error checking if account is manager:', error);
      return false;
    }
  }

  /**
   * List all client accounts under this manager account
   */
  async listClientAccounts(): Promise<GoogleAdsClientAccount[]> {
    const query = `
      SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.manager,
        customer_client.status
      FROM customer_client
      WHERE customer_client.status IN ('ENABLED', 'CLOSED')
        AND customer_client.manager = false
    `.trim();

    const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${this.customerId}/googleAds:searchStream`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'developer-token': this.developerToken
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Ads API error: ${error}`);
    }

    const data = await response.json() as GoogleAdsCustomerClientResponse;
    const clientAccounts: GoogleAdsClientAccount[] = [];

    for (const result of data.results || []) {
      if (result.customerClient?.id) {
        clientAccounts.push({
          id: result.customerClient.id.toString(),
          name: result.customerClient.descriptiveName || `Account ${result.customerClient.id}`,
          currencyCode: result.customerClient.currencyCode,
          timeZone: result.customerClient.timeZone
        });
      }
    }

    return clientAccounts;
  }
}
