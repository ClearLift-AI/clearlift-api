# ClearLift Frontend Implementation Guide - Simplified

This guide covers ONLY the features that are currently implemented in the API backend. No speculation or future features.

## Table of Contents
1. [API Overview](#api-overview)
2. [Authentication](#authentication)
3. [User & Organization Management](#user--organization-management)
4. [Platform Connections](#platform-connections)
5. [Analytics Data Access](#analytics-data-access)
6. [Onboarding Flow](#onboarding-flow)

---

## 1. API Overview

### Base Configuration
```typescript
// config/api.ts
export const API_CONFIG = {
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'https://api.clearlift.ai',
  endpoints: {
    // All implemented endpoints listed below
  }
}
```

### API Client Setup
```typescript
// lib/api-client.ts
import axios from 'axios'

const apiClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('clearlift_session')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export default apiClient
```

---

## 2. Authentication

### Implemented Endpoints
- `POST /v1/auth/register` - Create new user with organization
- `POST /v1/auth/login` - User login
- `POST /v1/auth/logout` - Logout current session
- `POST /v1/auth/refresh` - Refresh session token
- `POST /v1/auth/password-reset-request` - Request password reset
- `POST /v1/auth/password-reset` - Reset password with token

### Registration
```typescript
interface RegisterRequest {
  email: string
  password: string  // min 8 chars
  name: string
  organization_name?: string
}

interface RegisterResponse {
  user: {
    id: string
    email: string
    name: string
  }
  session: {
    token: string
    expires_at: string
  }
  organization: {
    id: string
    name: string
    slug: string
  }
}

async function register(data: RegisterRequest): Promise<RegisterResponse> {
  const response = await apiClient.post('/v1/auth/register', data)

  // Store session token
  localStorage.setItem('clearlift_session', response.data.data.session.token)

  return response.data.data
}
```

### Login
```typescript
interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  user: {
    id: string
    email: string
    name: string
  }
  session: {
    token: string
    expires_at: string
  }
  organizations: Array<{
    id: string
    name: string
    slug: string
    role: 'owner' | 'admin' | 'viewer'
  }>
}

async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await apiClient.post('/v1/auth/login', { email, password })

  // Store session token
  localStorage.setItem('clearlift_session', response.data.data.session.token)

  return response.data.data
}
```

### Logout
```typescript
async function logout(): Promise<void> {
  await apiClient.post('/v1/auth/logout')
  localStorage.removeItem('clearlift_session')
}
```

---

## 3. User & Organization Management

### Implemented Endpoints
- `GET /v1/user/me` - Get current user profile
- `PATCH /v1/user/me` - Update user profile
- `GET /v1/user/organizations` - List user's organizations
- `POST /v1/organizations` - Create new organization
- `POST /v1/organizations/:org_id/invite` - Invite member
- `POST /v1/organizations/join` - Join via invitation
- `DELETE /v1/organizations/:org_id/members/:user_id` - Remove member

### Get User Profile
```typescript
interface UserProfile {
  id: string
  email: string
  name: string
  created_at: string
  last_login_at: string
}

async function getProfile(): Promise<UserProfile> {
  const response = await apiClient.get('/v1/user/me')
  return response.data.data.user
}
```

### Get User Organizations
```typescript
interface Organization {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'viewer'
  created_at: string
  org_tag: string  // For analytics filtering
  members_count: number
  platforms_count: number
}

async function getOrganizations(): Promise<Organization[]> {
  const response = await apiClient.get('/v1/user/organizations')
  return response.data.data.organizations
}
```

### Create Organization
```typescript
async function createOrganization(name: string): Promise<Organization> {
  const response = await apiClient.post('/v1/organizations', { name })
  return response.data.data.organization
}
```

---

## 4. Platform Connections

### Implemented Endpoints
- `GET /v1/connectors` - List available connectors
- `GET /v1/connectors/connected` - List connected platforms
- `POST /v1/connectors/:provider/connect` - OAuth flow (Google/Facebook)
- `GET /v1/connectors/:provider/callback` - OAuth callback
- `DELETE /v1/connectors/:connection_id` - Disconnect platform
- `GET /v1/connectors/:connection_id/sync-status` - Get sync status

### Stripe Specific
- `POST /v1/connectors/stripe/connect` - Connect with API key
- `PUT /v1/connectors/stripe/:connection_id/config` - Update config
- `POST /v1/connectors/stripe/:connection_id/sync` - Trigger sync
- `POST /v1/connectors/stripe/:connection_id/test` - Test connection

### Connect Stripe (API Key)
```typescript
interface StripeConnectRequest {
  organization_id: string
  api_key: string  // Format: sk_test_... or sk_live_...
  sync_mode?: 'charges' | 'payment_intents' | 'invoices'
  lookback_days?: number  // 1-365
  auto_sync?: boolean
}

interface StripeConnectResponse {
  connection_id: string
  account_info: {
    stripe_account_id: string
    business_name?: string
    country: string
    default_currency: string
    charges_enabled: boolean
  }
}

async function connectStripe(data: StripeConnectRequest): Promise<StripeConnectResponse> {
  const response = await apiClient.post('/v1/connectors/stripe/connect', data)
  return response.data.data
}
```

### OAuth Connection (Google/Facebook)
```typescript
interface OAuthInitResponse {
  authorization_url: string
  state: string
}

async function initiateOAuth(
  platform: 'google' | 'facebook',
  organizationId: string
): Promise<OAuthInitResponse> {
  const response = await apiClient.post(`/v1/connectors/${platform}/connect`, {
    organization_id: organizationId,
    redirect_uri: `${window.location.origin}/connectors/callback`
  })

  // Open OAuth window
  window.open(response.data.data.authorization_url, 'oauth', 'width=600,height=700')

  return response.data.data
}
```

### Get Connected Platforms
```typescript
interface ConnectedPlatform {
  id: string
  organization_id: string
  platform: 'stripe' | 'google' | 'facebook'
  account_id: string
  account_name: string
  connected_at: string
  last_sync_at?: string
  sync_status?: 'pending' | 'running' | 'completed' | 'failed'
}

async function getConnectedPlatforms(orgId: string): Promise<ConnectedPlatform[]> {
  const response = await apiClient.get('/v1/connectors/connected', {
    params: { org_id: orgId }
  })
  return response.data.data.connections
}
```

### Trigger Stripe Sync
```typescript
interface SyncRequest {
  sync_type?: 'full' | 'incremental'
  date_from?: string
  date_to?: string
}

interface SyncResponse {
  job_id: string
  message: string
}

async function triggerStripeSync(
  connectionId: string,
  options?: SyncRequest
): Promise<SyncResponse> {
  const response = await apiClient.post(
    `/v1/connectors/stripe/${connectionId}/sync`,
    options
  )
  return response.data.data
}
```

### Get Sync Status
```typescript
interface SyncStatus {
  connection_id: string
  platform: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at?: string
  completed_at?: string
  records_processed?: number
  error_message?: string
}

async function getSyncStatus(connectionId: string): Promise<SyncStatus> {
  const response = await apiClient.get(`/v1/connectors/${connectionId}/sync-status`)
  return response.data.data.sync_status
}
```

---

## 5. Analytics Data Access

### Implemented Endpoints
- `GET /v1/analytics/events` - Get event data
- `GET /v1/analytics/conversions` - Get conversion data
- `GET /v1/analytics/ads/:platform_slug` - Get ad platform data
- `GET /v1/analytics/stripe` - Get Stripe analytics
- `GET /v1/analytics/stripe/daily-aggregates` - Get daily Stripe aggregates
- `GET /v1/analytics/platforms/unified` - Get unified platform data
- `GET /v1/analytics/platforms/:platform` - Get specific platform data

### Get Events
```typescript
interface EventsRequest {
  org_id: string
  lookback?: string  // e.g., '24h', '7d', '30d'
  limit?: number
  offset?: number
}

interface Event {
  event_id: string
  event_type: string
  event_timestamp: string
  properties: Record<string, any>
}

async function getEvents(params: EventsRequest): Promise<Event[]> {
  const response = await apiClient.get('/v1/analytics/events', { params })
  return response.data.data.events
}
```

### Get Conversions
```typescript
interface ConversionsRequest {
  org_id: string
  date_from?: string
  date_to?: string
  group_by?: 'day' | 'week' | 'month'
}

interface ConversionData {
  date: string
  conversions: number
  revenue: number
  average_order_value: number
}

async function getConversions(params: ConversionsRequest): Promise<ConversionData[]> {
  const response = await apiClient.get('/v1/analytics/conversions', { params })
  return response.data.data.conversions
}
```

### Get Stripe Analytics
```typescript
interface StripeAnalyticsRequest {
  org_id: string
  connection_id: string
  date_from?: string
  date_to?: string
  metrics?: string[]  // ['revenue', 'customers', 'charges']
}

interface StripeAnalytics {
  revenue: {
    total: number
    currency: string
    by_period: Array<{ date: string; amount: number }>
  }
  customers: {
    total: number
    new: number
    recurring: number
  }
  charges: {
    successful: number
    failed: number
    refunded: number
  }
}

async function getStripeAnalytics(params: StripeAnalyticsRequest): Promise<StripeAnalytics> {
  const response = await apiClient.get('/v1/analytics/stripe', { params })
  return response.data.data
}
```

---

## 6. Onboarding Flow

### Implemented Endpoints
- `GET /v1/onboarding/status` - Get onboarding status
- `POST /v1/onboarding/start` - Start onboarding
- `POST /v1/onboarding/complete-step` - Mark step complete
- `POST /v1/onboarding/reset` - Reset onboarding

### Onboarding Status
```typescript
interface OnboardingStatus {
  user_id: string
  organization_id: string
  current_step: number
  completed_steps: string[]
  services_connected: number
  initial_sync_completed: boolean
  onboarding_completed: boolean
  started_at: string
  completed_at?: string
}

async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const response = await apiClient.get('/v1/onboarding/status')
  return response.data.data
}
```

### Complete Onboarding Step
```typescript
type OnboardingStep =
  | 'organization_created'
  | 'first_platform_connected'
  | 'initial_sync_started'
  | 'dashboard_toured'

async function completeOnboardingStep(step: OnboardingStep): Promise<void> {
  await apiClient.post('/v1/onboarding/complete-step', { step })
}
```

---

## Complete Implementation Example

### React Hook for Authentication
```typescript
// hooks/useAuth.ts
import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'

export function useAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    checkAuth()
  }, [])

  const checkAuth = async () => {
    try {
      const token = localStorage.getItem('clearlift_session')
      if (!token) {
        setLoading(false)
        return
      }

      const response = await apiClient.get('/v1/user/me')
      setUser(response.data.data.user)
    } catch (error) {
      localStorage.removeItem('clearlift_session')
    } finally {
      setLoading(false)
    }
  }

  const login = async (email: string, password: string) => {
    const data = await apiClient.post('/v1/auth/login', { email, password })
    localStorage.setItem('clearlift_session', data.data.data.session.token)
    setUser(data.data.data.user)
    router.push('/dashboard')
  }

  const logout = async () => {
    await apiClient.post('/v1/auth/logout')
    localStorage.removeItem('clearlift_session')
    setUser(null)
    router.push('/login')
  }

  return { user, loading, login, logout }
}
```

### Simple Onboarding Flow
```typescript
// pages/onboarding.tsx
import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'

const STEPS = [
  { id: 'organization', title: 'Setup Organization' },
  { id: 'connect', title: 'Connect Platform' },
  { id: 'sync', title: 'Initial Sync' },
  { id: 'complete', title: 'Complete' }
]

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0)
  const [status, setStatus] = useState(null)
  const router = useRouter()

  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = async () => {
    const response = await apiClient.get('/v1/onboarding/status')
    setStatus(response.data.data)

    // Determine current step based on status
    if (response.data.data.onboarding_completed) {
      router.push('/dashboard')
    } else if (response.data.data.services_connected > 0) {
      setCurrentStep(2)
    } else if (response.data.data.organization_id) {
      setCurrentStep(1)
    }
  }

  const connectStripe = async (apiKey: string) => {
    try {
      await apiClient.post('/v1/connectors/stripe/connect', {
        organization_id: status.organization_id,
        api_key: apiKey,
        sync_mode: 'charges',
        lookback_days: 30,
        auto_sync: true
      })

      // Mark step complete
      await apiClient.post('/v1/onboarding/complete-step', {
        step: 'first_platform_connected'
      })

      setCurrentStep(2)
    } catch (error) {
      console.error('Failed to connect Stripe:', error)
    }
  }

  const completeOnboarding = async () => {
    await apiClient.post('/v1/onboarding/complete-step', {
      step: 'dashboard_toured'
    })
    router.push('/dashboard')
  }

  return (
    <div>
      <h1>Welcome to ClearLift</h1>
      <div>Step {currentStep + 1} of {STEPS.length}: {STEPS[currentStep].title}</div>

      {currentStep === 1 && (
        <StripeConnectionForm onConnect={connectStripe} />
      )}

      {currentStep === 2 && (
        <SyncMonitor connectionId={status?.connection_id} />
      )}

      {currentStep === 3 && (
        <button onClick={completeOnboarding}>Go to Dashboard</button>
      )}
    </div>
  )
}
```

---

## Error Handling

All API responses follow this format:

### Success Response
```typescript
{
  success: true,
  data: { /* response data */ },
  meta: {
    timestamp: string
  }
}
```

### Error Response
```typescript
{
  success: false,
  error: {
    code: string,
    message: string
  }
}
```

### Common Error Codes
- `UNAUTHORIZED` - Invalid or expired session
- `FORBIDDEN` - Insufficient permissions
- `NOT_FOUND` - Resource not found
- `INVALID_REQUEST` - Invalid request parameters
- `USER_EXISTS` - Email already registered
- `INVALID_CREDENTIALS` - Wrong email/password

---

## Testing the API

### With cURL
```bash
# Register
curl -X POST https://api.clearlift.ai/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecurePass123","name":"Test User"}'

# Login
curl -X POST https://api.clearlift.ai/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecurePass123"}'

# Get profile (with session token)
curl -X GET https://api.clearlift.ai/v1/user/me \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"
```

---

## Production Deployment Notes

1. **Environment Variables**
   ```env
   NEXT_PUBLIC_API_URL=https://api.clearlift.ai
   ```

2. **Session Storage**
   - Session tokens stored in localStorage
   - Tokens expire after 30 days
   - Refresh endpoint available for token renewal

3. **Rate Limits**
   - 100 requests per minute per IP/user
   - Auth endpoints have stricter limits

4. **CORS**
   - API accepts requests from configured domains
   - Include credentials for cookie-based auth if needed

---

This guide covers ALL currently implemented API endpoints. Any features not listed here are NOT yet implemented.