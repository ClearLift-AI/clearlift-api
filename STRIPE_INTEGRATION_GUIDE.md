# Stripe Integration Guide for Frontend Developers

## Overview
This guide explains how to integrate Stripe connection functionality into the ClearLift frontend application. Users can connect their Stripe accounts using restricted API keys to sync payment data.

## Authentication Flow

### 1. User Registration/Login
```javascript
// Register a new user
POST https://api.clearlift.ai/v1/auth/register
{
  "email": "user@example.com",
  "password": "SecurePassword123",
  "name": "John Doe",
  "organization_name": "Acme Corp"
}

// Response
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "name": "..." },
    "session": {
      "token": "Bearer_Token_Here",
      "expires_at": "2025-11-15T..."
    },
    "organization": {
      "id": "org-uuid-here",
      "name": "Acme Corp",
      "slug": "acme-corp"
    }
  }
}

// Or login existing user
POST https://api.clearlift.ai/v1/auth/login
{
  "email": "user@example.com",
  "password": "SecurePassword123"
}
```

### 2. Store Session Token
```javascript
// Store the session token for authenticated requests
const sessionToken = response.data.session.token;
localStorage.setItem('clearlift_session', sessionToken);

// Use in all subsequent API calls
const headers = {
  'Authorization': `Bearer ${sessionToken}`,
  'Content-Type': 'application/json'
};
```

## Stripe Connection Flow

### 1. UI Requirements

Create a Stripe connection form with:
- **API Key Input**: Secure text field for Stripe API key
- **Lookback Period**: Number input (1-365 days) - defaults to 30 days
- **Auto-sync Toggle**: Enable/disable automatic syncing (15 minute intervals)
- **Test Mode Indicator**: Show if using test vs live key

**Note**: The connector now exclusively tracks `payment_intents` with `status='succeeded'`. Invoice line items are automatically included when available.

### 2. Stripe API Key Validation (Frontend)

```javascript
function validateStripeKey(apiKey) {
  // Check format: must start with sk_test_ or sk_live_
  const isValid = /^(sk_test_|sk_live_)[a-zA-Z0-9]{24,}$/.test(apiKey);
  const isTestMode = apiKey.startsWith('sk_test_');

  return { isValid, isTestMode };
}

// Example usage
const apiKeyInput = document.getElementById('stripe-api-key');
const { isValid, isTestMode } = validateStripeKey(apiKeyInput.value);

if (!isValid) {
  showError('Invalid Stripe API key format');
  return;
}

if (isTestMode) {
  showWarning('Using test mode - only test data will be synced');
}
```

### 3. Connect Stripe Account

```javascript
async function connectStripeAccount(orgId, apiKey, options = {}) {
  const payload = {
    organization_id: orgId,
    api_key: apiKey,
    // sync_mode removed - always tracks payment_intents
    lookback_days: options.lookbackDays || 30,
    auto_sync: options.autoSync !== false
  };

  try {
    const response = await fetch('https://api.clearlift.ai/v1/connectors/stripe/connect', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.success) {
      // Connection successful
      const { connection_id, account_info } = data.data;

      // Display success with account details
      showSuccess(`Connected to Stripe account: ${account_info.business_name || account_info.stripe_account_id}`);

      // Store connection ID for future operations
      return connection_id;
    } else {
      // Handle errors
      handleStripeError(data.error);
    }
  } catch (error) {
    console.error('Connection failed:', error);
    showError('Failed to connect Stripe account');
  }
}
```

### 4. Error Handling

```javascript
function handleStripeError(error) {
  switch (error.code) {
    case 'INVALID_API_KEY':
      showError('Invalid Stripe API key. Please check your key and try again.');
      break;
    case 'INVALID_CONFIG':
      showError('This Stripe account cannot accept charges. Please check your Stripe account settings.');
      break;
    case 'ALREADY_EXISTS':
      showError('This Stripe account is already connected to your organization.');
      break;
    case 'FORBIDDEN':
      showError('You do not have permission to connect accounts for this organization.');
      break;
    default:
      showError(error.message || 'Failed to connect Stripe account');
  }
}
```

## Managing Stripe Connections

### 1. List Connected Platforms
```javascript
async function getConnectedPlatforms(orgId) {
  const response = await fetch(`https://api.clearlift.ai/v1/connectors/connected?org_id=${orgId}`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });

  const data = await response.json();

  // Filter for Stripe connections
  const stripeConnections = data.data.connections.filter(c => c.platform === 'stripe');
  return stripeConnections;
}
```

### 2. Test Connection
```javascript
async function testStripeConnection(connectionId) {
  const response = await fetch(`https://api.clearlift.ai/v1/connectors/stripe/${connectionId}/test`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (data.data.success) {
    showSuccess(`Connection working! Found ${data.data.recent_payment_intents} recent payment_intents`);
  } else {
    showError(`Connection test failed: ${data.data.message}`);
  }
}
```

### 3. Trigger Manual Sync
```javascript
async function triggerSync(connectionId, syncType = 'incremental') {
  const response = await fetch(`https://api.clearlift.ai/v1/connectors/stripe/${connectionId}/sync`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sync_type: syncType,
      date_from: '2025-01-01', // Optional
      date_to: '2025-10-16'    // Optional
    })
  });

  const data = await response.json();

  if (data.success) {
    showSuccess(`Sync job queued (Job ID: ${data.data.job_id})`);
    // Poll for sync status
    pollSyncStatus(connectionId);
  }
}
```

### 4. Monitor Sync Status
```javascript
async function getSyncStatus(connectionId) {
  const response = await fetch(`https://api.clearlift.ai/v1/connectors/${connectionId}/sync-status`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });

  const data = await response.json();
  return data.data.sync_status;
}

function pollSyncStatus(connectionId) {
  const interval = setInterval(async () => {
    const status = await getSyncStatus(connectionId);

    updateSyncUI(status);

    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(interval);
    }
  }, 5000); // Poll every 5 seconds
}
```

### 5. Disconnect Platform
```javascript
async function disconnectStripe(connectionId) {
  if (!confirm('Are you sure you want to disconnect this Stripe account?')) {
    return;
  }

  const response = await fetch(`https://api.clearlift.ai/v1/connectors/${connectionId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });

  const data = await response.json();

  if (data.success) {
    showSuccess('Stripe account disconnected');
    refreshConnectionsList();
  }
}
```

## Complete React Component Example

```jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import { useOrganization } from './hooks/useOrganization';

function StripeConnector() {
  const { sessionToken } = useAuth();
  const { currentOrg } = useOrganization();
  const [apiKey, setApiKey] = useState('');
  // syncMode removed - always tracks payment_intents
  const [lookbackDays, setLookbackDays] = useState(30);
  const [autoSync, setAutoSync] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    loadConnections();
  }, [currentOrg]);

  const loadConnections = async () => {
    try {
      const response = await fetch(
        `https://api.clearlift.ai/v1/connectors/connected?org_id=${currentOrg.id}`,
        {
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        }
      );
      const data = await response.json();
      const stripeConnections = data.data.connections.filter(c => c.platform === 'stripe');
      setConnections(stripeConnections);
    } catch (err) {
      console.error('Failed to load connections:', err);
    }
  };

  const handleConnect = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Validate API key format
    if (!apiKey.match(/^(sk_test_|sk_live_)[a-zA-Z0-9]{24,}$/)) {
      setError('Invalid Stripe API key format');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('https://api.clearlift.ai/v1/connectors/stripe/connect', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          api_key: apiKey,
          // sync_mode removed - always tracks payment_intents
          lookback_days: lookbackDays,
          auto_sync: autoSync
        })
      });

      const data = await response.json();

      if (data.success) {
        // Clear form
        setApiKey('');

        // Reload connections
        await loadConnections();

        // Show success message
        alert(`Successfully connected to Stripe account: ${data.data.account_info.business_name || data.data.account_info.stripe_account_id}`);
      } else {
        setError(data.error.message);
      }
    } catch (err) {
      setError('Failed to connect Stripe account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stripe-connector">
      <h2>Connect Stripe Account</h2>

      {connections.length > 0 && (
        <div className="existing-connections">
          <h3>Connected Accounts</h3>
          {connections.map(conn => (
            <div key={conn.id} className="connection-card">
              <span>{conn.account_name}</span>
              <button onClick={() => disconnectStripe(conn.id)}>Disconnect</button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleConnect}>
        <div className="form-group">
          <label htmlFor="api-key">Stripe API Key</label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_test_... or sk_live_..."
            required
          />
          <small>
            Get your API key from <a href="https://dashboard.stripe.com/apikeys" target="_blank">Stripe Dashboard</a>
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="sync-mode">Sync Mode</label>
          <select
            id="sync-mode"
            disabled={true}
          >
            <option value="payment_intents">Payment Intents (succeeded only)</option>
          </select>
          <p className="text-sm text-gray-500 mt-1">
            Automatically tracks succeeded payment_intents with invoice line items when available.
            See <a href="https://docs.clearlift.ai/stripe-migration" className="text-blue-600 underline">migration guide</a> for details.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="lookback">Lookback Period (days)</label>
          <input
            id="lookback"
            type="number"
            min="1"
            max="365"
            value={lookbackDays}
            onChange={(e) => setLookbackDays(parseInt(e.target.value))}
          />
        </div>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
            />
            Enable automatic syncing
          </label>
        </div>

        {error && (
          <div className="error-message">{error}</div>
        )}

        <button type="submit" disabled={loading}>
          {loading ? 'Connecting...' : 'Connect Stripe Account'}
        </button>
      </form>
    </div>
  );
}

export default StripeConnector;
```

## Security Best Practices

1. **Never store API keys in frontend code**
2. **Always use HTTPS for API calls**
3. **Implement proper session management**
4. **Show clear indicators for test vs live mode**
5. **Confirm before disconnecting accounts**
6. **Mask API keys in UI (show only last 4 characters)**
7. **Implement rate limiting on frontend**
8. **Log all connection attempts for audit**

## Troubleshooting

### Common Issues

1. **"Invalid API key format"**
   - Ensure key starts with `sk_test_` or `sk_live_`
   - Key must be at least 24 characters after prefix
   - Check for extra spaces or line breaks

2. **"This Stripe account cannot accept charges"**
   - Stripe account may not be fully activated
   - Check Stripe dashboard for account status

3. **"Already connected"**
   - The same Stripe account is already linked
   - Disconnect existing connection first

4. **"Unauthorized"**
   - Session token may have expired
   - User needs to log in again

5. **Rate limiting**
   - API limits: 100 requests per minute
   - Implement exponential backoff for retries

## Getting Stripe API Keys

Guide users to:
1. Log in to [Stripe Dashboard](https://dashboard.stripe.com)
2. Navigate to Developers → API Keys
3. Create a restricted key with read-only permissions for:
   - Charges
   - Customers
   - Products
   - Prices
   - Payment Intents
   - Invoices
4. Copy the key (starts with `sk_test_` or `sk_live_`)
5. Never share or expose the key publicly

## Next Steps

After successful connection:
1. Data will begin syncing based on settings
2. View analytics in the dashboard
3. Set up filters for data segmentation
4. Configure webhooks for real-time updates (future feature)
5. Monitor sync status and health

## Support

For issues or questions:
- Check sync status: `GET /v1/connectors/{connection_id}/sync-status`
- Test connection: `POST /v1/connectors/stripe/{connection_id}/test`
- View error logs in the dashboard
- Contact support with connection ID and error messages