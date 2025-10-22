# ClearLift Frontend Onboarding Developer Guide

## Table of Contents
1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Authentication Flow](#authentication-flow)
4. [Onboarding Steps](#onboarding-steps)
5. [API Reference](#api-reference)
6. [Implementation Guide](#implementation-guide)
7. [Code Examples](#code-examples)
8. [Error Handling](#error-handling)
9. [Testing Guide](#testing-guide)
10. [Current Limitations](#current-limitations)

## Overview

ClearLift's onboarding system is designed to take new users from registration through to viewing their first analytics data. This guide provides everything needed to implement the frontend onboarding experience.

### Key Concepts
- **Session-based authentication** with 30-day Bearer tokens
- **Email verification** required for new accounts
- **Password reset** via emailed tokens
- **Multi-tenant architecture** where users belong to organizations
- **Role-based access control** (Owner, Admin, Viewer)
- **Progressive onboarding** with skippable steps
- **Platform connections** via API keys (Stripe) and OAuth (Google, Facebook)

## System Architecture

### Authentication Model
```typescript
interface User {
  id: string;
  email: string;
  name: string;
  created_at: string;
  last_login_at?: string;
}

interface Session {
  token: string;
  expires_at: string;
  user_id: string;
}

interface Organization {
  id: string;
  name: string;
  slug: string;
  subscription_tier: 'free' | 'pro' | 'enterprise';
  role?: 'owner' | 'admin' | 'viewer'; // User's role in this org
}
```

### Onboarding State Machine
```
┌─────────┐     ┌──────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────┐
│Register │────▶│  Verify   │────▶│  Welcome  │────▶│   Connect   │────▶│   Sync   │────▶│ Complete │
└─────────┘     │   Email   │     └──────────┘     │  Platforms  │     │   Data   │     └──────────┘
                └──────────┘                        └─────────────┘     └──────────┘
                                                           │                   │
                                                           └───────────────────┘
                                                              (Can skip to)
```

## Authentication Flow

### 1. Registration Flow (With Email Verification)

#### API Endpoint
```http
POST https://api.clearlift.ai/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "organization_name": "Acme Corp"  // Optional
}
```

#### Response
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "name": "John Doe"
    },
    "session": {
      "token": "clf_sess_1234567890abcdef",
      "expires_at": "2025-11-17T10:00:00Z"
    },
    "organization": {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "name": "Acme Corp",
      "slug": "acme-corp"
    }
  }
}
```

**Important**: After registration, a verification email is automatically sent. The user's email remains unverified (`email_verified: false`) until they click the verification link.

#### Frontend Implementation
```typescript
// services/auth.service.ts
export class AuthService {
  async register(data: RegisterData): Promise<AuthResponse> {
    try {
      const response = await axios.post('/v1/auth/register', data);

      // Store session token
      this.storeSession(response.data.data.session);

      // Store current organization if created
      if (response.data.data.organization) {
        this.setCurrentOrganization(response.data.data.organization);
      }

      return response.data.data;
    } catch (error) {
      if (error.response?.status === 409) {
        throw new Error('An account with this email already exists');
      }
      throw error;
    }
  }

  private storeSession(session: Session): void {
    // Use secure storage method
    localStorage.setItem('clf_session', session.token);
    localStorage.setItem('clf_session_expires', session.expires_at);
  }
}
```

### 2. Login Flow

#### API Endpoint
```http
POST https://api.clearlift.ai/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

#### Response
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "name": "John Doe"
    },
    "session": {
      "token": "clf_sess_1234567890abcdef",
      "expires_at": "2025-11-17T10:00:00Z"
    },
    "organizations": [
      {
        "id": "660e8400-e29b-41d4-a716-446655440001",
        "name": "Acme Corp",
        "slug": "acme-corp",
        "role": "owner"
      },
      {
        "id": "770e8400-e29b-41d4-a716-446655440002",
        "name": "Partner Co",
        "slug": "partner-co",
        "role": "viewer"
      }
    ]
  }
}
```

#### Frontend Implementation
```typescript
// components/Login.tsx
export const Login: React.FC = () => {
  const [organizations, setOrganizations] = useState<Organization[]>([]);

  const handleLogin = async (credentials: LoginCredentials) => {
    const response = await authService.login(credentials);

    if (response.organizations.length === 0) {
      // No organizations - redirect to create one
      navigate('/onboarding/create-organization');
    } else if (response.organizations.length === 1) {
      // Single org - auto-select
      authService.setCurrentOrganization(response.organizations[0]);
      navigate('/dashboard');
    } else {
      // Multiple orgs - show selector
      setOrganizations(response.organizations);
      setShowOrgSelector(true);
    }
  };
};
```

### 3. Email Verification

#### Verify Email Endpoint
```http
POST https://api.clearlift.ai/v1/auth/verify-email
Content-Type: application/json

{
  "token": "uuid-verification-token"
}
```

#### Response (Success)
```json
{
  "success": true,
  "data": {
    "message": "Email verified successfully",
    "user": {
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

#### Resend Verification Email
```http
POST https://api.clearlift.ai/v1/auth/resend-verification
Content-Type: application/json

{
  "email": "user@example.com"
}
```

#### Frontend Implementation
```typescript
// components/VerifyEmail.tsx
export const VerifyEmail: React.FC = () => {
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token } = useParams(); // From URL: /verify-email?token=xxx

  useEffect(() => {
    if (token) {
      verifyEmail();
    }
  }, [token]);

  const verifyEmail = async () => {
    setVerifying(true);
    try {
      const response = await axios.post('/v1/auth/verify-email', { token });
      setVerified(true);
      // Redirect to dashboard after 3 seconds
      setTimeout(() => navigate('/dashboard'), 3000);
    } catch (error: any) {
      if (error.response?.data?.code === 'TOKEN_EXPIRED') {
        setError('Your verification link has expired. Please request a new one.');
      } else if (error.response?.data?.code === 'TOKEN_USED') {
        setError('This email has already been verified.');
      } else {
        setError('Invalid verification link.');
      }
    } finally {
      setVerifying(false);
    }
  };

  const resendVerification = async () => {
    const email = prompt('Enter your email address:');
    if (email) {
      await axios.post('/v1/auth/resend-verification', { email });
      alert('If an unverified account exists, a new verification email has been sent.');
    }
  };

  return (
    <div className="verify-email">
      {verifying && <p>Verifying your email...</p>}
      {verified && (
        <div>
          <h2>✓ Email Verified!</h2>
          <p>Your email has been verified successfully. Redirecting to dashboard...</p>
        </div>
      )}
      {error && (
        <div>
          <p className="error">{error}</p>
          <button onClick={resendVerification}>Request New Verification Email</button>
        </div>
      )}
    </div>
  );
};
```

### 4. Password Reset

#### Request Password Reset
```http
POST https://api.clearlift.ai/v1/auth/password-reset-request
Content-Type: application/json

{
  "email": "user@example.com"
}
```

#### Reset Password with Token
```http
POST https://api.clearlift.ai/v1/auth/password-reset
Content-Type: application/json

{
  "token": "uuid-reset-token",
  "new_password": "NewSecurePass123!"
}
```

#### Frontend Implementation
```typescript
// components/PasswordReset.tsx
export const PasswordReset: React.FC = () => {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const { token } = useParams();

  useEffect(() => {
    if (token) {
      setStep('reset');
    }
  }, [token]);

  const requestReset = async (email: string) => {
    await axios.post('/v1/auth/password-reset-request', { email });
    alert('If an account exists, a password reset email has been sent.');
  };

  const resetPassword = async (newPassword: string) => {
    try {
      await axios.post('/v1/auth/password-reset', {
        token,
        new_password: newPassword
      });
      alert('Password reset successfully! Please login with your new password.');
      navigate('/login');
    } catch (error: any) {
      if (error.response?.data?.code === 'INVALID_TOKEN') {
        alert('Invalid or expired reset token. Please request a new one.');
        setStep('request');
      }
    }
  };

  return step === 'request' ? (
    <RequestResetForm onSubmit={requestReset} />
  ) : (
    <ResetPasswordForm onSubmit={resetPassword} />
  );
};
```

### 5. Session Management

#### Axios Interceptor Setup
```typescript
// config/axios.config.ts
import axios from 'axios';

axios.defaults.baseURL = 'https://api.clearlift.ai';

// Request interceptor - add auth token
axios.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('clf_session');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - handle token refresh
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const response = await axios.post('/v1/auth/refresh');
        const newToken = response.data.data.session.token;
        localStorage.setItem('clf_session', newToken);

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return axios(originalRequest);
      } catch (refreshError) {
        // Refresh failed - redirect to login
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
```

## Onboarding Steps

### Step 1: Welcome Screen

No API call needed - this is purely frontend.

```typescript
// components/onboarding/WelcomeStep.tsx
export const WelcomeStep: React.FC = () => {
  const { markStepComplete } = useOnboarding();

  const handleContinue = async () => {
    await markStepComplete('welcome');
    navigate('/onboarding/connect');
  };

  return (
    <div className="onboarding-welcome">
      <h1>Welcome to ClearLift!</h1>
      <p>Let's get your analytics set up in just a few steps.</p>
      <button onClick={handleContinue}>Get Started</button>
    </div>
  );
};
```

### Step 2: Connect Platforms

#### Stripe Connection (API Key)

##### API Endpoint
```http
POST https://api.clearlift.ai/v1/connectors/stripe/connect
Authorization: Bearer {token}
Content-Type: application/json

{
  "organization_id": "660e8400-e29b-41d4-a716-446655440001",
  "api_key": "sk_live_51ABC...",
  "sync_mode": "charges",        // Optional: 'charges' | 'payment_intents' | 'invoices'
  "lookback_days": 30,           // Optional: 1-365
  "auto_sync": true              // Optional: Enable automatic syncing
}
```

##### Response
```json
{
  "success": true,
  "data": {
    "connection_id": "conn_1234567890",
    "account_info": {
      "stripe_account_id": "acct_1ABC2DEF3GHI",
      "business_name": "Acme Corp",
      "country": "US",
      "default_currency": "usd",
      "charges_enabled": true
    }
  }
}
```

##### Frontend Implementation
```typescript
// components/onboarding/StripeConnector.tsx
export const StripeConnector: React.FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const validateApiKey = (key: string): boolean => {
    const pattern = /^(sk_test_|sk_live_)[a-zA-Z0-9]{24,}$/;
    return pattern.test(key);
  };

  const handleConnect = async () => {
    if (!validateApiKey(apiKey)) {
      setError('Invalid Stripe API key format');
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const response = await axios.post('/v1/connectors/stripe/connect', {
        organization_id: getCurrentOrgId(),
        api_key: apiKey,
        sync_mode: 'charges',
        lookback_days: 30,
        auto_sync: true
      });

      // Success - store connection info
      storeConnection('stripe', response.data.data);

      // Mark step complete
      await markStepComplete('connect_services');

      // Navigate to next step
      navigate('/onboarding/sync-status');

    } catch (error: any) {
      if (error.response?.data?.code === 'INVALID_API_KEY') {
        setError('This API key is invalid. Please check it in your Stripe dashboard.');
      } else if (error.response?.data?.code === 'ALREADY_EXISTS') {
        setError('This Stripe account is already connected.');
      } else {
        setError('Failed to connect Stripe. Please try again.');
      }
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="stripe-connector">
      <h2>Connect Your Stripe Account</h2>

      <div className="mode-selector">
        <label>
          <input
            type="radio"
            checked={!isLiveMode}
            onChange={() => setIsLiveMode(false)}
          />
          Test Mode
        </label>
        <label>
          <input
            type="radio"
            checked={isLiveMode}
            onChange={() => setIsLiveMode(true)}
          />
          Live Mode
        </label>
      </div>

      <div className="api-key-input">
        <label>Stripe API Key</label>
        <input
          type="password"
          placeholder={isLiveMode ? "sk_live_..." : "sk_test_..."}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={error ? 'error' : ''}
        />
        {error && <span className="error-message">{error}</span>}
      </div>

      <div className="help-text">
        <p>Find your API key in your Stripe Dashboard:</p>
        <ol>
          <li>Go to Stripe Dashboard → Developers → API Keys</li>
          <li>Create a restricted key with read-only permissions</li>
          <li>Copy the key and paste it above</li>
        </ol>
      </div>

      <button
        onClick={handleConnect}
        disabled={isConnecting || !apiKey}
      >
        {isConnecting ? 'Connecting...' : 'Connect Stripe'}
      </button>
    </div>
  );
};
```

#### Test Stripe Connection

##### API Endpoint
```http
POST https://api.clearlift.ai/v1/connectors/stripe/{connection_id}/test
Authorization: Bearer {token}
```

##### Response (Success)
```json
{
  "success": true,
  "data": {
    "success": true,
    "account": {
      "id": "acct_1ABC2DEF3GHI",
      "name": "Acme Corp",
      "country": "US",
      "charges_enabled": true
    },
    "recent_charges": 5,
    "message": "Connection is working correctly"
  }
}
```

### Step 3: Monitor Sync Progress

#### Check Sync Status

##### API Endpoint
```http
GET https://api.clearlift.ai/v1/connectors/{connection_id}/sync-status
Authorization: Bearer {token}
```

##### Response
```json
{
  "success": true,
  "data": {
    "status": "running",
    "progress": 65,
    "last_sync": "2025-10-17T10:00:00Z",
    "next_sync": "2025-10-17T10:15:00Z",
    "records_synced": 1250,
    "errors": []
  }
}
```

##### Frontend Implementation
```typescript
// components/onboarding/SyncProgress.tsx
export const SyncProgress: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [isFirstSyncComplete, setIsFirstSyncComplete] = useState(false);

  useEffect(() => {
    const checkSyncStatus = async () => {
      const connections = getStoredConnections();

      for (const connection of connections) {
        const response = await axios.get(
          `/v1/connectors/${connection.id}/sync-status`
        );

        setSyncStatus(response.data.data);

        if (response.data.data.status === 'complete' &&
            response.data.data.records_synced > 0) {
          setIsFirstSyncComplete(true);
          await markStepComplete('first_sync');
        }
      }
    };

    // Poll every 5 seconds
    const interval = setInterval(checkSyncStatus, 5000);
    checkSyncStatus(); // Initial check

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="sync-progress">
      <h2>Syncing Your Data</h2>

      {syncStatus && (
        <div className="progress-indicator">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${syncStatus.progress}%` }}
            />
          </div>

          <p>Status: {syncStatus.status}</p>
          <p>Records synced: {syncStatus.records_synced}</p>

          {syncStatus.status === 'complete' && (
            <div className="success-message">
              <p>✓ Initial sync complete!</p>
              <button onClick={() => navigate('/dashboard')}>
                View Dashboard
              </button>
            </div>
          )}

          {syncStatus.errors.length > 0 && (
            <div className="error-list">
              <h3>Sync Errors:</h3>
              {syncStatus.errors.map((error, idx) => (
                <p key={idx} className="error">{error}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="skip-option">
        <button
          className="link-button"
          onClick={() => navigate('/dashboard')}
        >
          Skip and continue to dashboard
        </button>
      </div>
    </div>
  );
};
```

## Organization Management

### Create Organization

#### API Endpoint
```http
POST https://api.clearlift.ai/v1/organizations
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "My New Company",
  "slug": "my-new-company"  // Optional - auto-generated if not provided
}
```

### Invite Team Members

#### API Endpoint
```http
POST https://api.clearlift.ai/v1/organizations/{org_id}/invite
Authorization: Bearer {token}
Content-Type: application/json

{
  "email": "teammate@example.com",
  "role": "viewer"  // 'viewer' | 'admin' | 'owner'
}
```

#### Response
```json
{
  "success": true,
  "data": {
    "invitation": {
      "id": "inv_123456",
      "email": "teammate@example.com",
      "role": "viewer",
      "invite_code": "ABC123",
      "expires_at": "2025-10-24T10:00:00Z"
    }
  }
}
```

### Join Organization with Invite Code

#### API Endpoint
```http
POST https://api.clearlift.ai/v1/organizations/join
Authorization: Bearer {token}
Content-Type: application/json

{
  "invite_code": "ABC123"
}
```

## State Management

### Redux/Context Setup
```typescript
// store/onboarding.store.ts
interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: string[];
  connections: PlatformConnection[];
  syncStatus: SyncStatus | null;
  error: string | null;
}

const initialState: OnboardingState = {
  currentStep: 'welcome',
  completedSteps: [],
  connections: [],
  syncStatus: null,
  error: null
};

// Actions
const MARK_STEP_COMPLETE = 'MARK_STEP_COMPLETE';
const ADD_CONNECTION = 'ADD_CONNECTION';
const UPDATE_SYNC_STATUS = 'UPDATE_SYNC_STATUS';
const SET_ERROR = 'SET_ERROR';

// Reducer
export const onboardingReducer = (
  state = initialState,
  action: OnboardingAction
): OnboardingState => {
  switch (action.type) {
    case MARK_STEP_COMPLETE:
      return {
        ...state,
        completedSteps: [...state.completedSteps, action.payload.step],
        currentStep: getNextStep(action.payload.step)
      };

    case ADD_CONNECTION:
      return {
        ...state,
        connections: [...state.connections, action.payload.connection]
      };

    case UPDATE_SYNC_STATUS:
      return {
        ...state,
        syncStatus: action.payload.status
      };

    case SET_ERROR:
      return {
        ...state,
        error: action.payload.error
      };

    default:
      return state;
  }
};
```

## Error Handling

### Common Error Codes
```typescript
enum ErrorCode {
  // Authentication
  USER_EXISTS = 409,           // Email already registered
  INVALID_CREDENTIALS = 401,    // Wrong email/password
  SESSION_EXPIRED = 401,        // Token expired

  // Validation
  INVALID_REQUEST = 400,        // Bad request data
  INVALID_API_KEY = 400,        // Stripe key format wrong

  // Permissions
  FORBIDDEN = 403,              // No access to resource
  NOT_FOUND = 404,              // Resource doesn't exist

  // Rate Limiting
  RATE_LIMITED = 429,           // Too many requests

  // Server
  INTERNAL_ERROR = 500,         // Server error
}
```

### Error Handler Component
```typescript
// components/ErrorHandler.tsx
export const ErrorHandler: React.FC<{ error: any }> = ({ error }) => {
  const getErrorMessage = (error: any): string => {
    if (error.response?.data?.message) {
      return error.response.data.message;
    }

    switch (error.response?.status) {
      case 409:
        return 'This resource already exists';
      case 401:
        return 'Please login to continue';
      case 403:
        return 'You don\'t have permission to do this';
      case 429:
        return 'Too many requests. Please wait a moment.';
      case 500:
        return 'Something went wrong. Please try again.';
      default:
        return 'An unexpected error occurred';
    }
  };

  return (
    <div className="error-container">
      <p className="error-message">{getErrorMessage(error)}</p>
    </div>
  );
};
```

## UI/UX Recommendations

### Onboarding Progress Indicator
```typescript
// components/onboarding/ProgressIndicator.tsx
export const ProgressIndicator: React.FC = () => {
  const { currentStep, completedSteps } = useOnboarding();

  const steps = [
    { id: 'welcome', label: 'Welcome', icon: '👋' },
    { id: 'connect', label: 'Connect Platforms', icon: '🔗' },
    { id: 'sync', label: 'Sync Data', icon: '🔄' },
    { id: 'complete', label: 'Ready!', icon: '✅' }
  ];

  return (
    <div className="progress-indicator">
      {steps.map((step, index) => (
        <div
          key={step.id}
          className={`step ${
            completedSteps.includes(step.id) ? 'completed' : ''
          } ${currentStep === step.id ? 'current' : ''}`}
        >
          <div className="step-icon">{step.icon}</div>
          <div className="step-label">{step.label}</div>
          {index < steps.length - 1 && <div className="step-connector" />}
        </div>
      ))}
    </div>
  );
};
```

### Loading States
```typescript
// components/LoadingButton.tsx
export const LoadingButton: React.FC<{
  loading: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ loading, onClick, children }) => {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`btn ${loading ? 'btn-loading' : ''}`}
    >
      {loading ? (
        <>
          <span className="spinner" />
          Processing...
        </>
      ) : (
        children
      )}
    </button>
  );
};
```

## Testing Guide

### Test Scenarios

#### Authentication Tests
```typescript
// tests/auth.test.ts
describe('Authentication', () => {
  test('Registration with organization', async () => {
    const response = await authService.register({
      email: 'test@example.com',
      password: 'TestPass123!',
      name: 'Test User',
      organization_name: 'Test Org'
    });

    expect(response.user).toBeDefined();
    expect(response.session.token).toBeDefined();
    expect(response.organization).toBeDefined();
    expect(response.organization.name).toBe('Test Org');
  });

  test('Login with multiple organizations', async () => {
    const response = await authService.login({
      email: 'multi@example.com',
      password: 'TestPass123!'
    });

    expect(response.organizations).toHaveLength(2);
    expect(response.organizations[0].role).toBeDefined();
  });

  test('Handle expired session', async () => {
    // Mock 401 response
    mockAxios.onGet('/v1/test').reply(401);

    // Should trigger refresh
    const refreshSpy = jest.spyOn(authService, 'refreshSession');

    await axios.get('/v1/test');

    expect(refreshSpy).toHaveBeenCalled();
  });
});
```

#### Platform Connection Tests
```typescript
// tests/connectors.test.ts
describe('Platform Connectors', () => {
  test('Stripe connection with valid API key', async () => {
    const response = await connectorsService.connectStripe({
      organization_id: 'org_123',
      api_key: 'sk_test_1234567890abcdef'
    });

    expect(response.connection_id).toBeDefined();
    expect(response.account_info.charges_enabled).toBe(true);
  });

  test('Handle invalid Stripe API key', async () => {
    await expect(
      connectorsService.connectStripe({
        organization_id: 'org_123',
        api_key: 'invalid_key'
      })
    ).rejects.toThrow('Invalid Stripe API key format');
  });
});
```

### E2E Test Checklist
- [ ] Complete registration flow with organization creation
- [ ] Login and organization selection
- [ ] Connect Stripe with test API key
- [ ] Monitor sync progress
- [ ] Navigate to dashboard after onboarding
- [ ] Invite team member
- [ ] Join organization with invite code
- [ ] Handle session expiry gracefully
- [ ] Test rate limiting behavior

## Current Limitations

### Recently Implemented ✅
1. **Email Verification** - Users receive verification email via SendGrid
2. **Password Reset Email** - Full password reset flow with emailed links
3. **Organization Invitations** - Email invites sent automatically

### Not Yet Implemented
1. **Google OAuth** - Endpoint exists but OAuth flow not complete
2. **Facebook OAuth** - Endpoint exists but OAuth flow not complete
3. **Real-time Sync Updates** - Must poll for status
4. **Payment Integration** - All users on free tier
5. **Two-Factor Authentication** - Not available

### Known Issues
1. **CORS** - Configured for specific domains only
2. **Rate Limiting** - 5 requests per 15 minutes on auth endpoints
3. **Session Length** - Fixed 30 days, no remember me option
4. **Sync Delays** - Cron runs every 15 minutes

### Workarounds
```typescript
// Handling sync delays - show estimated time
const getEstimatedSyncTime = (recordCount: number): string => {
  if (recordCount < 1000) return '5-10 minutes';
  if (recordCount < 10000) return '15-30 minutes';
  return '30-60 minutes';
};

// Rate limiting - implement client-side throttling
const throttledApiCall = throttle(apiCall, 3000); // Max 1 call per 3 seconds
```

## Security Considerations

### Token Storage
```typescript
// Use httpOnly cookies when possible
const storeSession = (token: string): void => {
  // Preferred: Server sets httpOnly cookie
  // Fallback: Encrypted localStorage
  const encrypted = encrypt(token, getEncryptionKey());
  localStorage.setItem('clf_session_secure', encrypted);
};
```

### API Key Handling
```typescript
// Never log or display full API keys
const maskApiKey = (key: string): string => {
  if (key.length < 20) return '***';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
};
```

### Input Validation
```typescript
// Validate all user inputs
const validateEmail = (email: string): boolean => {
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern.test(email);
};

const validatePassword = (password: string): boolean => {
  return password.length >= 8 && password.length <= 128;
};
```

## Support & Resources

### API Documentation
- Base URL: `https://api.clearlift.ai`
- OpenAPI Spec: `/openapi.json`
- Test Account: Use `sk_test_` keys for Stripe

### Development Environment
```bash
# Local API
http://localhost:8787

# Environment variables
REACT_APP_API_URL=https://api.clearlift.ai
REACT_APP_APP_URL=https://app.clearlift.ai
```

### Common Issues & Solutions

**Issue**: CORS errors
**Solution**: Ensure requests are from allowed origins (app.clearlift.ai, localhost:3000)

**Issue**: 401 on all requests
**Solution**: Check token expiry, implement refresh flow

**Issue**: Stripe connection fails
**Solution**: Verify API key format and permissions in Stripe dashboard

**Issue**: Sync never completes
**Solution**: Check connection status, manually trigger sync if needed

## Next Steps

1. **Implement Core Components**
   - Registration/Login forms
   - Organization selector
   - Onboarding wizard container
   - Platform connector components

2. **Add State Management**
   - Redux or Context for global state
   - Local storage for persistence
   - Session management

3. **Build UI Components**
   - Progress indicators
   - Loading states
   - Error boundaries
   - Success notifications

4. **Testing**
   - Unit tests for services
   - Integration tests for API calls
   - E2E tests for full flow

5. **Optimization**
   - Code splitting for onboarding
   - Lazy loading for platform connectors
   - Caching for organization data

---

**Version**: 1.0.0
**Last Updated**: October 2025
**API Version**: v1
**Author**: ClearLift Engineering Team