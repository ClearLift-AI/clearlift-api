# Complete Onboarding Page Implementation Guide

## Overview
This guide provides a complete implementation for a multi-step onboarding flow that takes users from registration through connecting their first data source (Stripe, Google Ads, Facebook Ads).

## Onboarding Flow Structure

```
1. Welcome & Registration
   ├── Create Account
   ├── Verify Email (optional)
   └── Organization Setup

2. Platform Connection
   ├── Select Platform(s)
   ├── Connect Stripe (Restricted API Key)
   ├── Connect Google Ads (OAuth)
   └── Connect Facebook Ads (OAuth)

3. Initial Data Sync
   ├── Configure Sync Settings
   ├── Start Initial Sync
   └── Show Progress

4. Dashboard Tour
   ├── Feature Highlights
   └── Next Steps
```

## Complete Onboarding Implementation

### 1. Main Onboarding Component

```jsx
// components/Onboarding/OnboardingFlow.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import WelcomeStep from './steps/WelcomeStep';
import RegistrationStep from './steps/RegistrationStep';
import PlatformSelectionStep from './steps/PlatformSelectionStep';
import StripeConnectionStep from './steps/StripeConnectionStep';
import OAuthConnectionStep from './steps/OAuthConnectionStep';
import DataSyncStep from './steps/DataSyncStep';
import CompletionStep from './steps/CompletionStep';

const ONBOARDING_STEPS = {
  WELCOME: 'welcome',
  REGISTRATION: 'registration',
  PLATFORM_SELECTION: 'platform_selection',
  PLATFORM_CONNECTION: 'platform_connection',
  DATA_SYNC: 'data_sync',
  COMPLETION: 'completion'
};

function OnboardingFlow() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(ONBOARDING_STEPS.WELCOME);
  const [onboardingData, setOnboardingData] = useState({
    user: null,
    session: null,
    organization: null,
    selectedPlatforms: [],
    connections: [],
    syncJobs: []
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Check if user is already logged in
  useEffect(() => {
    const checkExistingSession = async () => {
      const token = localStorage.getItem('clearlift_session');
      if (token) {
        try {
          const response = await fetch('https://api.clearlift.ai/v1/user/me', {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (response.ok) {
            const data = await response.json();
            setOnboardingData(prev => ({
              ...prev,
              user: data.data.user,
              session: { token }
            }));

            // Skip to platform selection if already registered
            setCurrentStep(ONBOARDING_STEPS.PLATFORM_SELECTION);
          }
        } catch (err) {
          console.error('Session check failed:', err);
        }
      }
    };

    checkExistingSession();
  }, []);

  const handleStepComplete = (stepData) => {
    setOnboardingData(prev => ({ ...prev, ...stepData }));

    // Navigate to next step
    switch (currentStep) {
      case ONBOARDING_STEPS.WELCOME:
        setCurrentStep(ONBOARDING_STEPS.REGISTRATION);
        break;
      case ONBOARDING_STEPS.REGISTRATION:
        setCurrentStep(ONBOARDING_STEPS.PLATFORM_SELECTION);
        break;
      case ONBOARDING_STEPS.PLATFORM_SELECTION:
        setCurrentStep(ONBOARDING_STEPS.PLATFORM_CONNECTION);
        break;
      case ONBOARDING_STEPS.PLATFORM_CONNECTION:
        setCurrentStep(ONBOARDING_STEPS.DATA_SYNC);
        break;
      case ONBOARDING_STEPS.DATA_SYNC:
        setCurrentStep(ONBOARDING_STEPS.COMPLETION);
        break;
      case ONBOARDING_STEPS.COMPLETION:
        navigate('/dashboard');
        break;
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case ONBOARDING_STEPS.WELCOME:
        return <WelcomeStep onContinue={() => handleStepComplete({})} />;

      case ONBOARDING_STEPS.REGISTRATION:
        return (
          <RegistrationStep
            onComplete={(data) => handleStepComplete(data)}
            error={error}
          />
        );

      case ONBOARDING_STEPS.PLATFORM_SELECTION:
        return (
          <PlatformSelectionStep
            onComplete={(platforms) => handleStepComplete({ selectedPlatforms: platforms })}
          />
        );

      case ONBOARDING_STEPS.PLATFORM_CONNECTION:
        return (
          <PlatformConnectionHub
            platforms={onboardingData.selectedPlatforms}
            session={onboardingData.session}
            organization={onboardingData.organization}
            onComplete={(connections) => handleStepComplete({ connections })}
          />
        );

      case ONBOARDING_STEPS.DATA_SYNC:
        return (
          <DataSyncStep
            connections={onboardingData.connections}
            session={onboardingData.session}
            onComplete={(syncJobs) => handleStepComplete({ syncJobs })}
          />
        );

      case ONBOARDING_STEPS.COMPLETION:
        return (
          <CompletionStep
            organization={onboardingData.organization}
            connections={onboardingData.connections}
            onContinue={() => navigate('/dashboard')}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="onboarding-container">
      <div className="onboarding-header">
        <div className="logo">
          <img src="/logo.svg" alt="ClearLift" />
        </div>
        <OnboardingProgress currentStep={currentStep} />
      </div>

      <div className="onboarding-content">
        {renderStep()}
      </div>

      <div className="onboarding-footer">
        {currentStep !== ONBOARDING_STEPS.WELCOME && (
          <button
            className="back-button"
            onClick={() => setCurrentStep(getPreviousStep(currentStep))}
          >
            Back
          </button>
        )}
      </div>
    </div>
  );
}

export default OnboardingFlow;
```

### 2. Registration Step Component

```jsx
// components/Onboarding/steps/RegistrationStep.jsx
import React, { useState } from 'react';

function RegistrationStep({ onComplete, error: externalError }) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
    organizationName: ''
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const validateForm = () => {
    const newErrors = {};

    if (!formData.email || !/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = 'Valid email is required';
    }

    if (!formData.password || formData.password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
    }

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    if (!formData.name) {
      newErrors.name = 'Name is required';
    }

    if (!formData.organizationName) {
      newErrors.organizationName = 'Organization name is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) return;

    setLoading(true);
    setErrors({});

    try {
      const response = await fetch('https://api.clearlift.ai/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          name: formData.name,
          organization_name: formData.organizationName
        })
      });

      const data = await response.json();

      if (data.success) {
        // Store session token
        localStorage.setItem('clearlift_session', data.data.session.token);

        // Pass data to parent component
        onComplete({
          user: data.data.user,
          session: data.data.session,
          organization: data.data.organization
        });
      } else {
        setErrors({ submit: data.error.message });
      }
    } catch (err) {
      setErrors({ submit: 'Registration failed. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="registration-step">
      <div className="step-header">
        <h2>Create Your Account</h2>
        <p>Start your journey to better analytics</p>
      </div>

      <form onSubmit={handleSubmit} className="registration-form">
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="name">Full Name</label>
            <input
              id="name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className={errors.name ? 'error' : ''}
              placeholder="John Doe"
            />
            {errors.name && <span className="error-message">{errors.name}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className={errors.email ? 'error' : ''}
              placeholder="john@example.com"
            />
            {errors.email && <span className="error-message">{errors.email}</span>}
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="organizationName">Organization Name</label>
          <input
            id="organizationName"
            type="text"
            value={formData.organizationName}
            onChange={(e) => setFormData({ ...formData, organizationName: e.target.value })}
            className={errors.organizationName ? 'error' : ''}
            placeholder="Acme Corporation"
          />
          {errors.organizationName && <span className="error-message">{errors.organizationName}</span>}
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className={errors.password ? 'error' : ''}
              placeholder="••••••••"
            />
            {errors.password && <span className="error-message">{errors.password}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              type="password"
              value={formData.confirmPassword}
              onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
              className={errors.confirmPassword ? 'error' : ''}
              placeholder="••••••••"
            />
            {errors.confirmPassword && <span className="error-message">{errors.confirmPassword}</span>}
          </div>
        </div>

        {(errors.submit || externalError) && (
          <div className="alert alert-error">
            {errors.submit || externalError}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={loading}
        >
          {loading ? 'Creating Account...' : 'Create Account'}
        </button>

        <p className="terms-notice">
          By creating an account, you agree to our{' '}
          <a href="/terms" target="_blank">Terms of Service</a> and{' '}
          <a href="/privacy" target="_blank">Privacy Policy</a>
        </p>
      </form>
    </div>
  );
}

export default RegistrationStep;
```

### 3. Platform Selection Step

```jsx
// components/Onboarding/steps/PlatformSelectionStep.jsx
import React, { useState } from 'react';

const AVAILABLE_PLATFORMS = [
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payment processing and subscription data',
    icon: '💳',
    authType: 'api_key',
    popular: true
  },
  {
    id: 'google',
    name: 'Google Ads',
    description: 'Search and display advertising data',
    icon: '🔍',
    authType: 'oauth',
    popular: true
  },
  {
    id: 'facebook',
    name: 'Facebook Ads',
    description: 'Social media advertising data',
    icon: '👥',
    authType: 'oauth',
    popular: true
  },
  {
    id: 'tiktok',
    name: 'TikTok Ads',
    description: 'Video advertising platform data',
    icon: '🎵',
    authType: 'oauth',
    comingSoon: true
  }
];

function PlatformSelectionStep({ onComplete }) {
  const [selectedPlatforms, setSelectedPlatforms] = useState([]);

  const togglePlatform = (platformId) => {
    setSelectedPlatforms(prev => {
      if (prev.includes(platformId)) {
        return prev.filter(id => id !== platformId);
      }
      return [...prev, platformId];
    });
  };

  const handleContinue = () => {
    if (selectedPlatforms.length === 0) {
      alert('Please select at least one platform to continue');
      return;
    }
    onComplete(selectedPlatforms);
  };

  return (
    <div className="platform-selection-step">
      <div className="step-header">
        <h2>Connect Your Data Sources</h2>
        <p>Select the platforms you want to sync data from</p>
      </div>

      <div className="platform-grid">
        {AVAILABLE_PLATFORMS.map(platform => (
          <div
            key={platform.id}
            className={`platform-card ${selectedPlatforms.includes(platform.id) ? 'selected' : ''} ${platform.comingSoon ? 'disabled' : ''}`}
            onClick={() => !platform.comingSoon && togglePlatform(platform.id)}
          >
            <div className="platform-icon">{platform.icon}</div>
            <h3>{platform.name}</h3>
            <p>{platform.description}</p>

            {platform.popular && !platform.comingSoon && (
              <span className="badge badge-popular">Popular</span>
            )}

            {platform.comingSoon && (
              <span className="badge badge-coming-soon">Coming Soon</span>
            )}

            {selectedPlatforms.includes(platform.id) && (
              <div className="selected-indicator">✓</div>
            )}
          </div>
        ))}
      </div>

      <div className="step-actions">
        <button
          className="btn btn-primary btn-lg"
          onClick={handleContinue}
          disabled={selectedPlatforms.length === 0}
        >
          Continue with {selectedPlatforms.length} platform{selectedPlatforms.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

export default PlatformSelectionStep;
```

### 4. Platform Connection Hub

```jsx
// components/Onboarding/steps/PlatformConnectionHub.jsx
import React, { useState, useEffect } from 'react';
import StripeConnectionForm from './connections/StripeConnectionForm';
import OAuthConnectionFlow from './connections/OAuthConnectionFlow';

function PlatformConnectionHub({ platforms, session, organization, onComplete }) {
  const [currentPlatformIndex, setCurrentPlatformIndex] = useState(0);
  const [connections, setConnections] = useState([]);
  const [error, setError] = useState(null);

  const currentPlatform = platforms[currentPlatformIndex];

  const handleConnectionComplete = (connectionData) => {
    setConnections(prev => [...prev, connectionData]);

    if (currentPlatformIndex < platforms.length - 1) {
      // Move to next platform
      setCurrentPlatformIndex(prev => prev + 1);
    } else {
      // All platforms connected
      onComplete(connections);
    }
  };

  const handleSkip = () => {
    if (currentPlatformIndex < platforms.length - 1) {
      setCurrentPlatformIndex(prev => prev + 1);
    } else {
      onComplete(connections);
    }
  };

  const renderConnectionForm = () => {
    switch (currentPlatform) {
      case 'stripe':
        return (
          <StripeConnectionForm
            session={session}
            organizationId={organization.id}
            onSuccess={handleConnectionComplete}
            onError={setError}
          />
        );

      case 'google':
      case 'facebook':
        return (
          <OAuthConnectionFlow
            platform={currentPlatform}
            session={session}
            organizationId={organization.id}
            onSuccess={handleConnectionComplete}
            onError={setError}
          />
        );

      default:
        return <div>Unsupported platform: {currentPlatform}</div>;
    }
  };

  return (
    <div className="platform-connection-hub">
      <div className="connection-progress">
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{
              width: `${((currentPlatformIndex + 1) / platforms.length) * 100}%`
            }}
          />
        </div>
        <p className="progress-text">
          Connecting platform {currentPlatformIndex + 1} of {platforms.length}
        </p>
      </div>

      <div className="connection-content">
        {renderConnectionForm()}
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
        </div>
      )}

      <div className="connection-actions">
        <button
          className="btn btn-secondary"
          onClick={handleSkip}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

export default PlatformConnectionHub;
```

### 5. Stripe Connection Form

```jsx
// components/Onboarding/steps/connections/StripeConnectionForm.jsx
import React, { useState } from 'react';

function StripeConnectionForm({ session, organizationId, onSuccess, onError }) {
  const [apiKey, setApiKey] = useState('');
  const [syncSettings, setSyncSettings] = useState({
    syncMode: 'charges',
    lookbackDays: 30,
    autoSync: true
  });
  const [loading, setLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const validateApiKey = (key) => {
    return /^(sk_test_|sk_live_)[a-zA-Z0-9]{24,}$/.test(key);
  };

  const handleConnect = async (e) => {
    e.preventDefault();

    if (!validateApiKey(apiKey)) {
      onError('Invalid Stripe API key format. It should start with sk_test_ or sk_live_');
      return;
    }

    setLoading(true);
    onError(null);

    try {
      const response = await fetch('https://api.clearlift.ai/v1/connectors/stripe/connect', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          organization_id: organizationId,
          api_key: apiKey,
          ...syncSettings
        })
      });

      const data = await response.json();

      if (data.success) {
        onSuccess({
          platform: 'stripe',
          connectionId: data.data.connection_id,
          accountInfo: data.data.account_info
        });
      } else {
        onError(data.error.message);
      }
    } catch (err) {
      onError('Failed to connect Stripe account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stripe-connection-form">
      <div className="platform-header">
        <div className="platform-icon">💳</div>
        <h3>Connect Stripe</h3>
        <p>Sync your payment and subscription data</p>
      </div>

      <form onSubmit={handleConnect}>
        <div className="form-group">
          <label htmlFor="stripe-api-key">
            Stripe API Key
            <button
              type="button"
              className="help-toggle"
              onClick={() => setShowHelp(!showHelp)}
            >
              ?
            </button>
          </label>

          <input
            id="stripe-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_test_... or sk_live_..."
            required
          />

          {apiKey && !validateApiKey(apiKey) && (
            <p className="field-error">
              Invalid key format. Must start with sk_test_ or sk_live_
            </p>
          )}

          {apiKey && apiKey.startsWith('sk_test_') && (
            <p className="field-warning">
              ⚠️ Test mode: Only test data will be synced
            </p>
          )}
        </div>

        {showHelp && (
          <div className="help-panel">
            <h4>How to get your Stripe API Key:</h4>
            <ol>
              <li>Log in to your <a href="https://dashboard.stripe.com" target="_blank">Stripe Dashboard</a></li>
              <li>Navigate to Developers → API Keys</li>
              <li>Create a restricted key with read-only permissions</li>
              <li>Required permissions:
                <ul>
                  <li>Charges (Read)</li>
                  <li>Customers (Read)</li>
                  <li>Products (Read)</li>
                  <li>Prices (Read)</li>
                </ul>
              </li>
              <li>Copy the key and paste it here</li>
            </ol>
          </div>
        )}

        <div className="sync-settings">
          <h4>Sync Settings</h4>

          <div className="form-group">
            <label htmlFor="sync-mode">Data to sync</label>
            <select
              id="sync-mode"
              value={syncSettings.syncMode}
              onChange={(e) => setSyncSettings({ ...syncSettings, syncMode: e.target.value })}
            >
              <option value="charges">Charges</option>
              <option value="payment_intents">Payment Intents</option>
              <option value="invoices">Invoices</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="lookback-days">Historical data (days)</label>
            <input
              id="lookback-days"
              type="number"
              min="1"
              max="365"
              value={syncSettings.lookbackDays}
              onChange={(e) => setSyncSettings({ ...syncSettings, lookbackDays: parseInt(e.target.value) })}
            />
          </div>

          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={syncSettings.autoSync}
                onChange={(e) => setSyncSettings({ ...syncSettings, autoSync: e.target.checked })}
              />
              <span>Enable automatic daily syncing</span>
            </label>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={loading || !apiKey}
        >
          {loading ? 'Connecting...' : 'Connect Stripe Account'}
        </button>
      </form>
    </div>
  );
}

export default StripeConnectionForm;
```

### 6. OAuth Connection Flow

```jsx
// components/Onboarding/steps/connections/OAuthConnectionFlow.jsx
import React, { useState, useEffect } from 'react';

function OAuthConnectionFlow({ platform, session, organizationId, onSuccess, onError }) {
  const [loading, setLoading] = useState(false);
  const [authWindow, setAuthWindow] = useState(null);

  const PLATFORM_INFO = {
    google: {
      name: 'Google Ads',
      icon: '🔍',
      scopes: ['Google Ads account data', 'Campaign performance', 'Keyword analytics']
    },
    facebook: {
      name: 'Facebook Ads',
      icon: '👥',
      scopes: ['Ad account access', 'Campaign insights', 'Audience data']
    }
  };

  const handleOAuthConnect = async () => {
    setLoading(true);
    onError(null);

    try {
      // Get OAuth URL from API
      const response = await fetch(`https://api.clearlift.ai/v1/connectors/${platform}/connect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          organization_id: organizationId,
          redirect_uri: `${window.location.origin}/onboarding/callback`
        })
      });

      const data = await response.json();

      if (data.success) {
        // Open OAuth window
        const width = 600;
        const height = 700;
        const left = window.screen.width / 2 - width / 2;
        const top = window.screen.height / 2 - height / 2;

        const authWin = window.open(
          data.data.authorization_url,
          'oauth',
          `width=${width},height=${height},left=${left},top=${top}`
        );

        setAuthWindow(authWin);

        // Listen for OAuth callback
        const checkInterval = setInterval(() => {
          try {
            if (authWin.closed) {
              clearInterval(checkInterval);
              setLoading(false);
              onError('Authorization cancelled');
              return;
            }

            // Check if redirected back to our domain
            if (authWin.location.href.includes('/onboarding/callback')) {
              const urlParams = new URLSearchParams(authWin.location.search);
              const success = urlParams.get('success');
              const connectionId = urlParams.get('connection_id');
              const error = urlParams.get('error');

              authWin.close();
              clearInterval(checkInterval);

              if (success === 'true' && connectionId) {
                onSuccess({
                  platform,
                  connectionId,
                  accountInfo: {} // Will be fetched separately if needed
                });
              } else {
                onError(error || 'Connection failed');
              }

              setLoading(false);
            }
          } catch (e) {
            // Cross-origin error is expected until redirect
          }
        }, 1000);
      } else {
        onError(data.error.message);
        setLoading(false);
      }
    } catch (err) {
      onError('Failed to initiate OAuth connection');
      setLoading(false);
    }
  };

  const info = PLATFORM_INFO[platform];

  return (
    <div className="oauth-connection-flow">
      <div className="platform-header">
        <div className="platform-icon">{info.icon}</div>
        <h3>Connect {info.name}</h3>
        <p>Authorize ClearLift to access your advertising data</p>
      </div>

      <div className="oauth-info">
        <div className="permissions-list">
          <h4>Permissions requested:</h4>
          <ul>
            {info.scopes.map((scope, index) => (
              <li key={index}>
                <span className="permission-icon">✓</span>
                {scope}
              </li>
            ))}
          </ul>
        </div>

        <div className="security-notice">
          <div className="notice-icon">🔒</div>
          <div className="notice-content">
            <h4>Secure Connection</h4>
            <p>
              Your credentials are never stored. We only receive a secure token
              to access your data on your behalf.
            </p>
          </div>
        </div>
      </div>

      <button
        className="btn btn-primary btn-lg oauth-button"
        onClick={handleOAuthConnect}
        disabled={loading}
      >
        {loading ? (
          <>Waiting for authorization...</>
        ) : (
          <>
            <span className="platform-icon">{info.icon}</span>
            Connect {info.name}
          </>
        )}
      </button>

      {loading && (
        <p className="oauth-help">
          A new window should have opened. Please complete the authorization there.
          <br />
          <button
            className="link-button"
            onClick={() => authWindow && authWindow.focus()}
          >
            Click here if the window didn't open
          </button>
        </p>
      )}
    </div>
  );
}

export default OAuthConnectionFlow;
```

### 7. Onboarding Styles

```css
/* styles/onboarding.css */

.onboarding-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  flex-direction: column;
}

.onboarding-header {
  padding: 2rem;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
}

.onboarding-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.onboarding-content > div {
  background: white;
  border-radius: 12px;
  padding: 3rem;
  max-width: 600px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

/* Progress Bar */
.onboarding-progress {
  max-width: 600px;
  margin: 0 auto;
}

.progress-steps {
  display: flex;
  justify-content: space-between;
  margin-top: 1rem;
}

.progress-step {
  flex: 1;
  text-align: center;
  position: relative;
}

.progress-step::after {
  content: '';
  position: absolute;
  top: 15px;
  left: 50%;
  width: 100%;
  height: 2px;
  background: rgba(255, 255, 255, 0.3);
  z-index: -1;
}

.progress-step:last-child::after {
  display: none;
}

.progress-step.completed::after {
  background: #10b981;
}

.step-indicator {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
}

.progress-step.active .step-indicator {
  background: white;
  color: #667eea;
}

.progress-step.completed .step-indicator {
  background: #10b981;
}

/* Platform Selection */
.platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
  margin: 2rem 0;
}

.platform-card {
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.platform-card:hover {
  border-color: #667eea;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.1);
}

.platform-card.selected {
  border-color: #667eea;
  background: #f0f4ff;
}

.platform-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.platform-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.selected-indicator {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  background: #10b981;
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Form Styles */
.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #374151;
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 1rem;
  transition: border-color 0.2s;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.form-group input.error {
  border-color: #ef4444;
}

.error-message {
  color: #ef4444;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

/* Buttons */
.btn {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.btn-primary {
  background: #667eea;
  color: white;
}

.btn-primary:hover {
  background: #5a67d8;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
}

.btn-secondary {
  background: #e5e7eb;
  color: #374151;
}

.btn-secondary:hover {
  background: #d1d5db;
}

.btn-lg {
  padding: 1rem 2rem;
  font-size: 1.125rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
}

/* Alerts */
.alert {
  padding: 1rem;
  border-radius: 6px;
  margin: 1rem 0;
}

.alert-error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fecaca;
}

.alert-warning {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
}

.alert-success {
  background: #d1fae5;
  color: #065f46;
  border: 1px solid #a7f3d0;
}

/* OAuth Specific */
.oauth-button {
  width: 100%;
  background: white;
  color: #374151;
  border: 2px solid #e5e7eb;
  font-size: 1.125rem;
}

.oauth-button:hover {
  background: #f9fafb;
  border-color: #667eea;
}

.permissions-list {
  background: #f9fafb;
  border-radius: 8px;
  padding: 1.5rem;
  margin: 1.5rem 0;
}

.permissions-list ul {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0 0;
}

.permissions-list li {
  padding: 0.5rem 0;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.permission-icon {
  color: #10b981;
  font-weight: bold;
}

.security-notice {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  margin: 1.5rem 0;
}

.notice-icon {
  font-size: 2rem;
}

.notice-content h4 {
  margin: 0 0 0.5rem 0;
  color: #1e40af;
}

.notice-content p {
  margin: 0;
  color: #3730a3;
  font-size: 0.875rem;
}

/* Help Panel */
.help-panel {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 1.5rem;
  margin: 1rem 0;
}

.help-toggle {
  background: #e5e7eb;
  border: none;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  margin-left: 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
  color: #6b7280;
}

.help-toggle:hover {
  background: #d1d5db;
}

/* Loading States */
.skeleton {
  background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%);
  background-size: 200% 100%;
  animation: loading 1.5s infinite;
}

@keyframes loading {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* Responsive Design */
@media (max-width: 768px) {
  .onboarding-content > div {
    padding: 2rem;
  }

  .platform-grid {
    grid-template-columns: 1fr;
  }

  .form-row {
    grid-template-columns: 1fr;
  }
}
```

## Key Features Implemented

1. **Multi-step Flow**: Clean progression through registration, platform selection, connection, and completion
2. **Progress Tracking**: Visual progress bar showing current step
3. **Platform Support**: Stripe (API key), Google Ads (OAuth), Facebook Ads (OAuth)
4. **Error Handling**: Comprehensive error messages and recovery options
5. **Security**: Secure token storage, OAuth flow, API key validation
6. **User Experience**: Skip options, back navigation, help text
7. **Responsive Design**: Works on desktop and mobile devices
8. **State Management**: Persists progress through the flow

## Next Steps for Implementation

1. **Add API endpoint for onboarding status tracking**
2. **Implement email verification (optional)**
3. **Add team invitation during onboarding**
