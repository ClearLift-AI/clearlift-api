# ClearLift Frontend Complete Implementation Guide

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture & Infrastructure](#architecture--infrastructure)
3. [Project Setup](#project-setup)
4. [Core Application Structure](#core-application-structure)
5. [Authentication Implementation](#authentication-implementation)
6. [Dashboard Pages](#dashboard-pages)
7. [API Integration Layer](#api-integration-layer)
8. [Component Library](#component-library)
9. [State Management](#state-management)
10. [Production Deployment](#production-deployment)
11. [Monitoring & Analytics](#monitoring--analytics)
12. [Security Implementation](#security-implementation)

---

## 1. Project Overview

### Product Description
ClearLift is a multi-tenant analytics platform that aggregates data from various sources (Stripe, Google Ads, Facebook Ads) to provide unified business intelligence.

### Domain Structure
```
clearlift.ai           → Marketing site (Next.js static)
app.clearlift.ai       → Main application (React SPA)
api.clearlift.ai       → API endpoints (Cloudflare Workers)
docs.clearlift.ai      → Documentation (Docusaurus)
status.clearlift.ai    → Status page (Statuspage.io or custom)
```

### Tech Stack
```yaml
Framework: Next.js 14+ (App Router)
Language: TypeScript 5.3+
Styling: TailwindCSS 3.4+
UI Library: shadcn/ui
State: Zustand + React Query
Forms: React Hook Form + Zod
Charts: Recharts / Tremor
Testing: Vitest + Playwright
Deployment: Cloudflare Pages
```

---

## 2. Architecture & Infrastructure

### Repository Structure
```
clearlift-frontend/
├── apps/
│   ├── marketing/          # clearlift.ai
│   │   ├── app/
│   │   ├── components/
│   │   └── public/
│   ├── dashboard/          # app.clearlift.ai
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   ├── hooks/
│   │   └── services/
│   └── docs/              # docs.clearlift.ai
│       └── docusaurus/
├── packages/
│   ├── ui/                # Shared UI components
│   ├── api-client/        # API integration layer
│   ├── types/             # Shared TypeScript types
│   └── utils/             # Shared utilities
├── .github/
│   └── workflows/         # CI/CD pipelines
├── docker/
├── scripts/
└── turbo.json            # Turborepo config
```

### Monorepo Setup
```bash
# Initialize monorepo with Turborepo
npx create-turbo@latest clearlift-frontend
cd clearlift-frontend

# Install dependencies
npm install

# Setup workspaces in package.json
{
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

---

## 3. Project Setup

### 3.1 Initialize Dashboard App
```bash
# Create Next.js app for dashboard
cd apps
npx create-next-app@latest dashboard --typescript --tailwind --app --src-dir --import-alias "@/*"

cd dashboard

# Install essential dependencies
npm install @tanstack/react-query zustand react-hook-form zod
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu
npm install recharts date-fns clsx tailwind-merge
npm install lucide-react

# Dev dependencies
npm install -D @types/node @tanstack/eslint-plugin-query
```

### 3.2 Environment Configuration
```env
# apps/dashboard/.env.local
NEXT_PUBLIC_API_URL=http://localhost:8787
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_STRIPE_PUBLIC_KEY=pk_test_...

# apps/dashboard/.env.production
NEXT_PUBLIC_API_URL=https://api.clearlift.ai
NEXT_PUBLIC_APP_URL=https://app.clearlift.ai
NEXT_PUBLIC_STRIPE_PUBLIC_KEY=pk_live_...
```

### 3.3 TypeScript Configuration
```json
// apps/dashboard/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": {
      "@/*": ["./src/*"],
      "@ui/*": ["../../packages/ui/*"],
      "@api/*": ["../../packages/api-client/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

---

## 4. Core Application Structure

### 4.1 App Router Layout
```tsx
// apps/dashboard/app/layout.tsx
import { Inter } from 'next/font/google'
import { Providers } from '@/components/providers'
import { Toaster } from '@/components/ui/toaster'
import '@/styles/globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'ClearLift - Unified Analytics Dashboard',
  description: 'Connect, analyze, and optimize your business data',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  )
}
```

### 4.2 Providers Setup
```tsx
// apps/dashboard/components/providers.tsx
'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { ThemeProvider } from 'next-themes'
import { useState } from 'react'
import { AuthProvider } from '@/contexts/auth'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            gcTime: 5 * 60 * 1000, // 5 minutes
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AuthProvider>
          {children}
        </AuthProvider>
      </ThemeProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

### 4.3 Route Structure
```
app/
├── (auth)/
│   ├── login/
│   │   └── page.tsx
│   ├── register/
│   │   └── page.tsx
│   ├── reset-password/
│   │   └── page.tsx
│   └── layout.tsx
├── (dashboard)/
│   ├── dashboard/
│   │   └── page.tsx
│   ├── analytics/
│   │   ├── overview/
│   │   ├── conversions/
│   │   └── revenue/
│   ├── connectors/
│   │   ├── page.tsx
│   │   └── [provider]/
│   ├── settings/
│   │   ├── profile/
│   │   ├── organization/
│   │   └── billing/
│   └── layout.tsx
├── onboarding/
│   └── page.tsx
└── api/
    └── auth/
        └── callback/
```

---

## 5. Authentication Implementation

### 5.1 Auth Service
```typescript
// packages/api-client/src/services/auth.ts
import { apiClient } from '../client'

export interface User {
  id: string
  email: string
  name: string
  avatar_url?: string
}

export interface Session {
  token: string
  expires_at: string
  user: User
}

export interface Organization {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'viewer'
}

export class AuthService {
  async register(data: {
    email: string
    password: string
    name: string
    organization_name: string
  }): Promise<Session> {
    const response = await apiClient.post('/v1/auth/register', data)
    return response.data.data
  }

  async login(email: string, password: string): Promise<Session> {
    const response = await apiClient.post('/v1/auth/login', { email, password })
    return response.data.data
  }

  async logout(): Promise<void> {
    await apiClient.post('/v1/auth/logout')
  }

  async getMe(): Promise<User> {
    const response = await apiClient.get('/v1/user/me')
    return response.data.data.user
  }

  async getOrganizations(): Promise<Organization[]> {
    const response = await apiClient.get('/v1/user/organizations')
    return response.data.data.organizations
  }

  async refreshSession(): Promise<Session> {
    const response = await apiClient.post('/v1/auth/refresh')
    return response.data.data
  }
}

export const authService = new AuthService()
```

### 5.2 Auth Context
```tsx
// apps/dashboard/contexts/auth.tsx
'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService, type User, type Organization } from '@api/services/auth'

interface AuthContextType {
  user: User | null
  organizations: Organization[] | null
  currentOrg: Organization | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  register: (data: any) => Promise<void>
  switchOrganization: (orgId: string) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [organizations, setOrganizations] = useState<Organization[] | null>(null)
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null)
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

      const [userData, orgsData] = await Promise.all([
        authService.getMe(),
        authService.getOrganizations(),
      ])

      setUser(userData)
      setOrganizations(orgsData)

      // Set default org
      const savedOrgId = localStorage.getItem('clearlift_current_org')
      const defaultOrg = orgsData.find(o => o.id === savedOrgId) || orgsData[0]
      setCurrentOrg(defaultOrg)
    } catch (error) {
      console.error('Auth check failed:', error)
      localStorage.removeItem('clearlift_session')
    } finally {
      setLoading(false)
    }
  }

  const login = async (email: string, password: string) => {
    const session = await authService.login(email, password)
    localStorage.setItem('clearlift_session', session.token)
    await checkAuth()
    router.push('/dashboard')
  }

  const logout = async () => {
    await authService.logout()
    localStorage.removeItem('clearlift_session')
    localStorage.removeItem('clearlift_current_org')
    setUser(null)
    setOrganizations(null)
    setCurrentOrg(null)
    router.push('/login')
  }

  const register = async (data: any) => {
    const session = await authService.register(data)
    localStorage.setItem('clearlift_session', session.token)
    await checkAuth()
    router.push('/onboarding')
  }

  const switchOrganization = (orgId: string) => {
    const org = organizations?.find(o => o.id === orgId)
    if (org) {
      setCurrentOrg(org)
      localStorage.setItem('clearlift_current_org', orgId)
      router.refresh()
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        organizations,
        currentOrg,
        loading,
        login,
        logout,
        register,
        switchOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
```

### 5.3 Protected Route Middleware
```tsx
// apps/dashboard/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const publicPaths = ['/login', '/register', '/reset-password']

export function middleware(request: NextRequest) {
  const token = request.cookies.get('clearlift_session')
  const { pathname } = request.nextUrl

  // Check if path is public
  const isPublicPath = publicPaths.some(path => pathname.startsWith(path))

  // Redirect to login if no token on protected route
  if (!token && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Redirect to dashboard if token exists on public route
  if (token && isPublicPath) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
```

---

## 6. Dashboard Pages

### 6.1 Main Dashboard
```tsx
// apps/dashboard/app/(dashboard)/dashboard/page.tsx
'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Overview } from '@/components/analytics/overview'
import { RecentActivity } from '@/components/analytics/recent-activity'
import { MetricCards } from '@/components/analytics/metric-cards'
import { useAnalytics } from '@/hooks/use-analytics'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { Skeleton } from '@/components/ui/skeleton'

export default function DashboardPage() {
  const { data, isLoading } = useAnalytics()

  if (isLoading) {
    return <DashboardSkeleton />
  }

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
        <div className="flex items-center space-x-2">
          <DateRangePicker />
        </div>
      </div>

      <MetricCards metrics={data?.metrics} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <Overview data={data?.overview} />
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <RecentActivity activities={data?.activities} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
```

### 6.2 Connectors Page
```tsx
// apps/dashboard/app/(dashboard)/connectors/page.tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConnectorCard } from '@/components/connectors/connector-card'
import { ConnectDialog } from '@/components/connectors/connect-dialog'
import { useConnectors } from '@/hooks/use-connectors'
import { Plus } from 'lucide-react'

const AVAILABLE_CONNECTORS = [
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payment processing and subscriptions',
    icon: '/icons/stripe.svg',
    authType: 'api_key' as const,
  },
  {
    id: 'google',
    name: 'Google Ads',
    description: 'Search and display advertising',
    icon: '/icons/google-ads.svg',
    authType: 'oauth' as const,
  },
  {
    id: 'facebook',
    name: 'Facebook Ads',
    description: 'Social media advertising',
    icon: '/icons/facebook.svg',
    authType: 'oauth' as const,
  },
]

export default function ConnectorsPage() {
  const { connectors, isLoading, connect, disconnect, test } = useConnectors()
  const [selectedConnector, setSelectedConnector] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const handleConnect = (connector: any) => {
    setSelectedConnector(connector)
    setDialogOpen(true)
  }

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Data Sources</h2>
          <p className="text-muted-foreground">
            Connect your platforms to start syncing data
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Connection
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            onDisconnect={() => disconnect(connector.id)}
            onTest={() => test(connector.id)}
            onSync={() => {/* handle sync */}}
          />
        ))}

        {AVAILABLE_CONNECTORS.filter(
          (ac) => !connectors.some((c) => c.platform === ac.id)
        ).map((available) => (
          <Card
            key={available.id}
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => handleConnect(available)}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <img src={available.icon} alt={available.name} className="h-6 w-6" />
                {available.name}
              </CardTitle>
              <CardDescription>{available.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" className="w-full">
                Connect
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connector={selectedConnector}
        onConnect={connect}
      />
    </div>
  )
}
```

---

## 7. API Integration Layer

### 7.1 API Client Setup
```typescript
// packages/api-client/src/client.ts
import axios, { AxiosInstance, AxiosError } from 'axios'

class APIClient {
  private client: AxiosInstance
  private refreshPromise: Promise<any> | null = null

  constructor() {
    this.client = axios.create({
      baseURL: process.env.NEXT_PUBLIC_API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.setupInterceptors()
  }

  private setupInterceptors() {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        const token = this.getToken()
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
        return config
      },
      (error) => Promise.reject(error)
    )

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as any

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true

          if (!this.refreshPromise) {
            this.refreshPromise = this.refreshToken()
          }

          try {
            await this.refreshPromise
            this.refreshPromise = null
            return this.client(originalRequest)
          } catch (refreshError) {
            this.refreshPromise = null
            this.logout()
            return Promise.reject(refreshError)
          }
        }

        return Promise.reject(error)
      }
    )
  }

  private getToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('clearlift_session')
    }
    return null
  }

  private async refreshToken(): Promise<void> {
    try {
      const response = await this.client.post('/v1/auth/refresh')
      const { token } = response.data.data
      localStorage.setItem('clearlift_session', token)
    } catch (error) {
      throw error
    }
  }

  private logout() {
    localStorage.removeItem('clearlift_session')
    window.location.href = '/login'
  }

  // HTTP methods
  get = this.client.get
  post = this.client.post
  put = this.client.put
  patch = this.client.patch
  delete = this.client.delete
}

export const apiClient = new APIClient()
```

### 7.2 React Query Hooks
```typescript
// apps/dashboard/hooks/use-analytics.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { analyticsService } from '@api/services/analytics'
import { useAuth } from '@/contexts/auth'
import { DateRange } from '@/types'

export function useAnalytics(dateRange?: DateRange) {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: ['analytics', currentOrg?.id, dateRange],
    queryFn: () => analyticsService.getOverview(currentOrg!.id, dateRange),
    enabled: !!currentOrg,
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

export function useConversions(dateRange?: DateRange) {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: ['conversions', currentOrg?.id, dateRange],
    queryFn: () => analyticsService.getConversions(currentOrg!.id, dateRange),
    enabled: !!currentOrg,
  })
}

export function useRevenue(dateRange?: DateRange) {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: ['revenue', currentOrg?.id, dateRange],
    queryFn: () => analyticsService.getRevenue(currentOrg!.id, dateRange),
    enabled: !!currentOrg,
  })
}
```

---

## 8. Component Library

### 8.1 Design System Setup
```typescript
// packages/ui/src/theme/tokens.ts
export const tokens = {
  colors: {
    primary: {
      50: '#f0f9ff',
      100: '#e0f2fe',
      200: '#bae6fd',
      300: '#7dd3fc',
      400: '#38bdf8',
      500: '#0ea5e9',
      600: '#0284c7',
      700: '#0369a1',
      800: '#075985',
      900: '#0c4a6e',
      950: '#082f49',
    },
    gray: {
      50: '#f9fafb',
      100: '#f3f4f6',
      200: '#e5e7eb',
      300: '#d1d5db',
      400: '#9ca3af',
      500: '#6b7280',
      600: '#4b5563',
      700: '#374151',
      800: '#1f2937',
      900: '#111827',
      950: '#030712',
    },
  },
  spacing: {
    xs: '0.5rem',
    sm: '0.75rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
    '2xl': '3rem',
    '3xl': '4rem',
  },
  typography: {
    fontFamily: {
      sans: ['Inter', 'system-ui', 'sans-serif'],
      mono: ['Fira Code', 'monospace'],
    },
    fontSize: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '2xl': '1.5rem',
      '3xl': '1.875rem',
      '4xl': '2.25rem',
    },
  },
  animation: {
    duration: {
      fast: '150ms',
      normal: '300ms',
      slow: '500ms',
    },
    easing: {
      easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
      easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
      easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
    },
  },
}
```

### 8.2 Shared Components
```tsx
// packages/ui/src/components/data-table.tsx
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
}

export function DataTable<TData, TValue>({
  columns,
  data,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="rounded-md border">
      <table className="w-full">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-4 py-2 text-left">
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="h-24 text-center">
                No results.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
```

---

## 9. State Management

### 9.1 Organization Store
```typescript
// apps/dashboard/stores/organization.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OrganizationState {
  currentOrgId: string | null
  setCurrentOrgId: (id: string) => void
  preferences: Record<string, any>
  updatePreferences: (prefs: Record<string, any>) => void
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set) => ({
      currentOrgId: null,
      setCurrentOrgId: (id) => set({ currentOrgId: id }),
      preferences: {},
      updatePreferences: (prefs) =>
        set((state) => ({
          preferences: { ...state.preferences, ...prefs },
        })),
    }),
    {
      name: 'organization-storage',
    }
  )
)
```

### 9.2 UI Store
```typescript
// apps/dashboard/stores/ui.ts
import { create } from 'zustand'

interface UIState {
  sidebarOpen: boolean
  toggleSidebar: () => void
  commandMenuOpen: boolean
  setCommandMenuOpen: (open: boolean) => void
  theme: 'light' | 'dark' | 'system'
  setTheme: (theme: 'light' | 'dark' | 'system') => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  commandMenuOpen: false,
  setCommandMenuOpen: (open) => set({ commandMenuOpen: open }),
  theme: 'system',
  setTheme: (theme) => set({ theme }),
}))
```

---

## 10. Production Deployment

### 10.1 Build Configuration
```javascript
// apps/dashboard/next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL}/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
```

### 10.2 Cloudflare Pages Setup
```yaml
# .github/workflows/deploy.yml
name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build
        env:
          NEXT_PUBLIC_API_URL: ${{ secrets.API_URL }}
          NEXT_PUBLIC_APP_URL: ${{ secrets.APP_URL }}

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: clearlift-dashboard
          directory: apps/dashboard/out
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

### 10.3 Domain Configuration
```bash
# Cloudflare Pages Custom Domains
app.clearlift.ai → clearlift-dashboard.pages.dev
docs.clearlift.ai → clearlift-docs.pages.dev
clearlift.ai → clearlift-marketing.pages.dev

# DNS Records (in Cloudflare Dashboard)
CNAME app → clearlift-dashboard.pages.dev
CNAME docs → clearlift-docs.pages.dev
CNAME @ → clearlift-marketing.pages.dev
```

### 10.4 Environment Variables
```bash
# Set in Cloudflare Pages Dashboard
NEXT_PUBLIC_API_URL=https://api.clearlift.ai
NEXT_PUBLIC_APP_URL=https://app.clearlift.ai
NEXT_PUBLIC_STRIPE_PUBLIC_KEY=pk_live_...
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
NEXT_PUBLIC_FACEBOOK_APP_ID=...
NEXT_PUBLIC_SENTRY_DSN=...
NEXT_PUBLIC_POSTHOG_KEY=...
```

---

## 11. Monitoring & Analytics

### 11.1 Error Tracking (Sentry)
```typescript
// apps/dashboard/lib/sentry.ts
import * as Sentry from '@sentry/nextjs'

export function initSentry() {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.1,
      beforeSend(event, hint) {
        // Filter sensitive data
        if (event.request?.cookies) {
          delete event.request.cookies
        }
        return event
      },
    })
  }
}
```

### 11.2 Analytics (PostHog)
```typescript
// apps/dashboard/lib/analytics.ts
import posthog from 'posthog-js'

export function initAnalytics() {
  if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      api_host: 'https://app.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
    })
  }
}

export function trackEvent(event: string, properties?: Record<string, any>) {
  if (typeof window !== 'undefined') {
    posthog.capture(event, properties)
  }
}

export function identifyUser(userId: string, traits?: Record<string, any>) {
  if (typeof window !== 'undefined') {
    posthog.identify(userId, traits)
  }
}
```

### 11.3 Performance Monitoring
```typescript
// apps/dashboard/lib/performance.ts
export function reportWebVitals(metric: any) {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    id: metric.id,
    label: metric.label,
  })

  // Send to analytics
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/vitals', body)
  } else {
    fetch('/api/vitals', {
      method: 'POST',
      body,
      keepalive: true,
    })
  }
}
```

---

## 12. Security Implementation

### 12.1 Content Security Policy
```typescript
// apps/dashboard/middleware.ts
export function setSecurityHeaders(response: NextResponse) {
  response.headers.set(
    'Content-Security-Policy',
    `
      default-src 'self';
      script-src 'self' 'unsafe-eval' 'unsafe-inline' https://app.posthog.com;
      style-src 'self' 'unsafe-inline';
      img-src 'self' blob: data: https:;
      font-src 'self' data:;
      connect-src 'self' https://api.clearlift.ai https://app.posthog.com;
      frame-ancestors 'none';
    `.replace(/\s{2,}/g, ' ').trim()
  )

  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  )

  return response
}
```

### 12.2 Input Sanitization
```typescript
// packages/ui/src/utils/sanitize.ts
import DOMPurify from 'isomorphic-dompurify'

export function sanitizeHTML(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
  })
}

export function sanitizeInput(input: string): string {
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .trim()
    .slice(0, 1000) // Limit length
}
```

---

## 13. Complete Onboarding Implementation

### 13.1 Onboarding Flow Architecture
```typescript
// apps/dashboard/app/onboarding/types.ts
export interface OnboardingState {
  currentStep: number
  completedSteps: string[]
  user: {
    id: string
    email: string
    name: string
  }
  organization: {
    id: string
    name: string
    slug: string
  }
  platforms: {
    selected: string[]
    connected: ConnectionStatus[]
  }
  syncJobs: SyncJob[]
}

export interface ConnectionStatus {
  platform: string
  connectionId: string
  status: 'pending' | 'connected' | 'failed'
  accountInfo?: any
  error?: string
}

export interface SyncJob {
  id: string
  connectionId: string
  platform: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress?: number
  recordsProcessed?: number
  error?: string
}
```

### 13.2 Main Onboarding Page
```tsx
// apps/dashboard/app/onboarding/page.tsx
'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth'
import { OnboardingProgress } from './components/progress'
import { WelcomeStep } from './steps/welcome'
import { OrganizationSetup } from './steps/organization'
import { PlatformSelection } from './steps/platforms'
import { PlatformConnection } from './steps/connection'
import { DataSync } from './steps/sync'
import { OnboardingComplete } from './steps/complete'
import { trackEvent } from '@/lib/analytics'

const STEPS = [
  { id: 'welcome', title: 'Welcome', component: WelcomeStep },
  { id: 'organization', title: 'Organization Setup', component: OrganizationSetup },
  { id: 'platforms', title: 'Select Platforms', component: PlatformSelection },
  { id: 'connection', title: 'Connect Accounts', component: PlatformConnection },
  { id: 'sync', title: 'Initial Sync', component: DataSync },
  { id: 'complete', title: 'All Set!', component: OnboardingComplete },
]

export default function OnboardingPage() {
  const router = useRouter()
  const { user, currentOrg } = useAuth()
  const [currentStep, setCurrentStep] = useState(0)
  const [onboardingData, setOnboardingData] = useState({
    organization: null,
    selectedPlatforms: [],
    connections: [],
    syncJobs: [],
  })

  useEffect(() => {
    // Track onboarding start
    trackEvent('onboarding_started', { step: STEPS[currentStep].id })
  }, [])

  const handleNext = (data?: any) => {
    // Update onboarding data
    if (data) {
      setOnboardingData(prev => ({ ...prev, ...data }))
    }

    // Track step completion
    trackEvent('onboarding_step_completed', {
      step: STEPS[currentStep].id,
      nextStep: STEPS[currentStep + 1]?.id,
    })

    // Move to next step or complete
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      completeOnboarding()
    }
  }

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleSkip = () => {
    trackEvent('onboarding_step_skipped', { step: STEPS[currentStep].id })
    handleNext()
  }

  const completeOnboarding = async () => {
    try {
      // Mark onboarding as complete in backend
      await fetch('/api/v1/user/onboarding/complete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('clearlift_session')}`,
        },
      })

      trackEvent('onboarding_completed', {
        platformsConnected: onboardingData.connections.length,
        syncJobsStarted: onboardingData.syncJobs.length,
      })

      // Redirect to dashboard
      router.push('/dashboard')
    } catch (error) {
      console.error('Failed to complete onboarding:', error)
    }
  }

  const StepComponent = STEPS[currentStep].component

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <div className="container mx-auto px-4 py-8">
        <OnboardingProgress
          currentStep={currentStep}
          totalSteps={STEPS.length}
          steps={STEPS}
        />

        <div className="mt-8 max-w-4xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <StepComponent
                data={onboardingData}
                onNext={handleNext}
                onBack={handleBack}
                onSkip={handleSkip}
                isFirstStep={currentStep === 0}
                isLastStep={currentStep === STEPS.length - 1}
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
```

### 13.3 Platform Connection Component
```tsx
// apps/dashboard/app/onboarding/steps/connection.tsx
'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StripeConnector } from '../connectors/stripe'
import { OAuthConnector } from '../connectors/oauth'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'

export function PlatformConnection({ data, onNext, onBack, onSkip }) {
  const [connections, setConnections] = useState<Map<string, ConnectionStatus>>(new Map())
  const [currentPlatform, setCurrentPlatform] = useState(0)
  const platforms = data.selectedPlatforms

  const handleConnectionSuccess = (platform: string, connectionData: any) => {
    setConnections(prev => {
      const updated = new Map(prev)
      updated.set(platform, {
        status: 'connected',
        connectionId: connectionData.connection_id,
        accountInfo: connectionData.account_info,
      })
      return updated
    })

    // Auto-advance to next platform
    if (currentPlatform < platforms.length - 1) {
      setTimeout(() => {
        setCurrentPlatform(currentPlatform + 1)
      }, 1500)
    }
  }

  const handleConnectionError = (platform: string, error: string) => {
    setConnections(prev => {
      const updated = new Map(prev)
      updated.set(platform, {
        status: 'failed',
        error,
      })
      return updated
    })
  }

  const handleContinue = () => {
    const connectedPlatforms = Array.from(connections.entries())
      .filter(([_, status]) => status.status === 'connected')
      .map(([platform, status]) => ({
        platform,
        connectionId: status.connectionId,
        accountInfo: status.accountInfo,
      }))

    onNext({ connections: connectedPlatforms })
  }

  const renderConnector = (platform: string) => {
    switch (platform) {
      case 'stripe':
        return (
          <StripeConnector
            organizationId={data.organization.id}
            onSuccess={(data) => handleConnectionSuccess('stripe', data)}
            onError={(error) => handleConnectionError('stripe', error)}
          />
        )
      case 'google':
      case 'facebook':
        return (
          <OAuthConnector
            platform={platform}
            organizationId={data.organization.id}
            onSuccess={(data) => handleConnectionSuccess(platform, data)}
            onError={(error) => handleConnectionError(platform, error)}
          />
        )
      default:
        return null
    }
  }

  const getConnectionStatus = (platform: string) => {
    const status = connections.get(platform)
    if (!status) return null

    switch (status.status) {
      case 'connected':
        return (
          <div className="flex items-center text-green-600">
            <CheckCircle2 className="w-5 h-5 mr-2" />
            Connected
          </div>
        )
      case 'failed':
        return (
          <div className="flex items-center text-red-600">
            <XCircle className="w-5 h-5 mr-2" />
            Failed: {status.error}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect Your Accounts</CardTitle>
        <CardDescription>
          Connect your platforms to start syncing data. You can always add more later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Platform Tabs */}
        <div className="flex space-x-2 border-b">
          {platforms.map((platform, index) => (
            <button
              key={platform}
              onClick={() => setCurrentPlatform(index)}
              className={`
                px-4 py-2 font-medium transition-colors relative
                ${currentPlatform === index
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
            >
              {platform.charAt(0).toUpperCase() + platform.slice(1)}
              {connections.get(platform)?.status === 'connected' && (
                <CheckCircle2 className="w-4 h-4 ml-2 inline text-green-600" />
              )}
            </button>
          ))}
        </div>

        {/* Connection Form */}
        <div className="min-h-[400px]">
          {platforms[currentPlatform] && (
            <div className="space-y-4">
              {renderConnector(platforms[currentPlatform])}
              {getConnectionStatus(platforms[currentPlatform])}
            </div>
          )}
        </div>

        {/* Summary */}
        {connections.size > 0 && (
          <Alert>
            <AlertDescription>
              Connected {Array.from(connections.values()).filter(c => c.status === 'connected').length} of {platforms.length} platforms
            </AlertDescription>
          </Alert>
        )}

        {/* Actions */}
        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <div className="space-x-2">
            <Button variant="ghost" onClick={onSkip}>
              Skip Remaining
            </Button>
            <Button
              onClick={handleContinue}
              disabled={connections.size === 0}
            >
              Continue
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

---

## 14. Platform Syncing & Data Management

### 14.1 Sync Service
```typescript
// packages/api-client/src/services/sync.ts
export interface SyncJob {
  id: string
  organization_id: string
  connection_id: string
  platform: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  job_type: 'full' | 'incremental'
  started_at?: string
  completed_at?: string
  records_processed?: number
  error_message?: string
  metadata?: Record<string, any>
}

export class SyncService {
  async triggerSync(connectionId: string, options?: {
    syncType?: 'full' | 'incremental'
    dateFrom?: string
    dateTo?: string
  }): Promise<{ job_id: string }> {
    const response = await apiClient.post(
      `/v1/connectors/stripe/${connectionId}/sync`,
      options
    )
    return response.data.data
  }

  async getSyncStatus(connectionId: string): Promise<SyncJob> {
    const response = await apiClient.get(
      `/v1/connectors/${connectionId}/sync-status`
    )
    return response.data.data
  }

  async getSyncHistory(organizationId: string): Promise<SyncJob[]> {
    const response = await apiClient.get(
      `/v1/organizations/${organizationId}/sync-history`
    )
    return response.data.data
  }

  async cancelSync(jobId: string): Promise<void> {
    await apiClient.post(`/v1/sync-jobs/${jobId}/cancel`)
  }

  async retrySync(jobId: string): Promise<{ job_id: string }> {
    const response = await apiClient.post(`/v1/sync-jobs/${jobId}/retry`)
    return response.data.data
  }
}

export const syncService = new SyncService()
```

### 14.2 Real-time Sync Status Component
```tsx
// apps/dashboard/components/sync/sync-status-monitor.tsx
'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { syncService } from '@api/services/sync'
import { RefreshCw, Pause, Play, X } from 'lucide-react'

interface SyncStatusMonitorProps {
  connectionId: string
  platform: string
  onComplete?: () => void
}

export function SyncStatusMonitor({
  connectionId,
  platform,
  onComplete
}: SyncStatusMonitorProps) {
  const [isPolling, setIsPolling] = useState(true)

  const { data: syncStatus, refetch } = useQuery({
    queryKey: ['sync-status', connectionId],
    queryFn: () => syncService.getSyncStatus(connectionId),
    enabled: isPolling,
    refetchInterval: 2000, // Poll every 2 seconds
  })

  useEffect(() => {
    if (syncStatus?.status === 'completed' || syncStatus?.status === 'failed') {
      setIsPolling(false)
      if (syncStatus.status === 'completed' && onComplete) {
        onComplete()
      }
    }
  }, [syncStatus, onComplete])

  const handleRetry = async () => {
    if (syncStatus?.id) {
      await syncService.retrySync(syncStatus.id)
      setIsPolling(true)
      refetch()
    }
  }

  const handleCancel = async () => {
    if (syncStatus?.id) {
      await syncService.cancelSync(syncStatus.id)
      setIsPolling(false)
      refetch()
    }
  }

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'pending': return 'default'
      case 'running': return 'blue'
      case 'completed': return 'green'
      case 'failed': return 'destructive'
      default: return 'default'
    }
  }

  const calculateProgress = () => {
    if (!syncStatus) return 0
    if (syncStatus.status === 'completed') return 100
    if (syncStatus.status === 'failed') return 0

    // Calculate based on records processed vs estimated total
    const estimated = syncStatus.metadata?.estimated_records || 1000
    const processed = syncStatus.records_processed || 0
    return Math.min(100, (processed / estimated) * 100)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">
          {platform.charAt(0).toUpperCase() + platform.slice(1)} Sync Status
        </CardTitle>
        <Badge variant={getStatusColor(syncStatus?.status)}>
          {syncStatus?.status || 'Unknown'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        {syncStatus?.status === 'running' && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Progress</span>
              <span>{Math.round(calculateProgress())}%</span>
            </div>
            <Progress value={calculateProgress()} className="h-2" />
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Records Processed</p>
            <p className="font-medium">
              {syncStatus?.records_processed?.toLocaleString() || 0}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Sync Type</p>
            <p className="font-medium">
              {syncStatus?.job_type === 'full' ? 'Full Sync' : 'Incremental'}
            </p>
          </div>
        </div>

        {/* Time Info */}
        {syncStatus?.started_at && (
          <div className="text-sm">
            <p className="text-muted-foreground">Started</p>
            <p className="font-medium">
              {new Date(syncStatus.started_at).toLocaleString()}
            </p>
          </div>
        )}

        {/* Error Message */}
        {syncStatus?.status === 'failed' && syncStatus.error_message && (
          <div className="bg-destructive/10 text-destructive p-3 rounded-md text-sm">
            {syncStatus.error_message}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          {syncStatus?.status === 'running' && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsPolling(!isPolling)}
              >
                {isPolling ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" />
                    Pause Updates
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Resume Updates
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleCancel}
              >
                <X className="w-4 h-4 mr-2" />
                Cancel
              </Button>
            </>
          )}

          {syncStatus?.status === 'failed' && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetry}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry Sync
            </Button>
          )}

          {syncStatus?.status === 'completed' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Trigger New Sync
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
```

### 14.3 Stripe Connector Component
```tsx
// apps/dashboard/app/onboarding/connectors/stripe.tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { InfoCircle, Eye, EyeOff } from 'lucide-react'
import { connectorsService } from '@api/services/connectors'

interface StripeConnectorProps {
  organizationId: string
  onSuccess: (data: any) => void
  onError: (error: string) => void
}

export function StripeConnector({
  organizationId,
  onSuccess,
  onError
}: StripeConnectorProps) {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [syncMode, setSyncMode] = useState('charges')
  const [lookbackDays, setLookbackDays] = useState(30)
  const [autoSync, setAutoSync] = useState(true)
  const [loading, setLoading] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const validateApiKey = (key: string): boolean => {
    return /^(sk_test_|sk_live_)[a-zA-Z0-9]{24,}$/.test(key)
  }

  const isTestMode = apiKey.startsWith('sk_test_')

  const handleConnect = async () => {
    if (!validateApiKey(apiKey)) {
      onError('Invalid Stripe API key format')
      return
    }

    setLoading(true)

    try {
      const response = await connectorsService.connectStripe({
        organization_id: organizationId,
        api_key: apiKey,
        sync_mode: syncMode as 'charges' | 'payment_intents' | 'invoices',
        lookback_days: lookbackDays,
        auto_sync: autoSync,
      })

      onSuccess(response)
    } catch (error: any) {
      const message = error.response?.data?.error?.message || 'Failed to connect Stripe'
      onError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* API Key Input */}
      <div className="space-y-2">
        <Label htmlFor="api-key">
          Stripe API Key
          <button
            type="button"
            className="ml-2 text-muted-foreground hover:text-foreground"
            onClick={() => setShowHelp(!showHelp)}
          >
            <InfoCircle className="w-4 h-4 inline" />
          </button>
        </Label>
        <div className="relative">
          <Input
            id="api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_test_... or sk_live_..."
            className="pr-10"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? (
              <EyeOff className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Eye className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>

        {/* Validation Messages */}
        {apiKey && !validateApiKey(apiKey) && (
          <p className="text-sm text-destructive">
            Invalid key format. Must start with sk_test_ or sk_live_
          </p>
        )}

        {isTestMode && (
          <Alert className="mt-2">
            <AlertDescription className="text-sm">
              ⚠️ Test mode: Only test data will be synced. Use a live key for production data.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Help Section */}
      {showHelp && (
        <Card className="bg-muted/50">
          <CardContent className="pt-6">
            <h4 className="font-medium mb-3">How to get your Stripe API Key:</h4>
            <ol className="space-y-2 text-sm">
              <li>1. Log in to your <a href="https://dashboard.stripe.com" target="_blank" className="text-primary underline">Stripe Dashboard</a></li>
              <li>2. Navigate to <strong>Developers → API Keys</strong></li>
              <li>3. Click <strong>"Create restricted key"</strong></li>
              <li>4. Grant these <strong>Read</strong> permissions:
                <ul className="ml-4 mt-1 space-y-1">
                  <li>• Charges</li>
                  <li>• Customers</li>
                  <li>• Products</li>
                  <li>• Prices</li>
                  <li>• Payment Intents</li>
                  <li>• Invoices</li>
                </ul>
              </li>
              <li>5. Copy the key and paste it above</li>
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Sync Configuration */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">Sync Configuration</h3>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="sync-mode">Data to sync</Label>
            <Select value={syncMode} onValueChange={setSyncMode}>
              <SelectTrigger id="sync-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="charges">Charges</SelectItem>
                <SelectItem value="payment_intents">Payment Intents</SelectItem>
                <SelectItem value="invoices">Invoices</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="lookback">Historical data (days)</Label>
            <Input
              id="lookback"
              type="number"
              min="1"
              max="365"
              value={lookbackDays}
              onChange={(e) => setLookbackDays(parseInt(e.target.value))}
            />
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="auto-sync"
            checked={autoSync}
            onCheckedChange={(checked) => setAutoSync(checked as boolean)}
          />
          <Label htmlFor="auto-sync" className="font-normal">
            Enable automatic daily syncing
          </Label>
        </div>
      </div>

      {/* Connect Button */}
      <Button
        className="w-full"
        size="lg"
        onClick={handleConnect}
        disabled={!apiKey || !validateApiKey(apiKey) || loading}
      >
        {loading ? 'Connecting...' : 'Connect Stripe Account'}
      </Button>
    </div>
  )
}
```

### 14.4 OAuth Connector Component
```tsx
// apps/dashboard/app/onboarding/connectors/oauth.tsx
'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { connectorsService } from '@api/services/connectors'

interface OAuthConnectorProps {
  platform: 'google' | 'facebook'
  organizationId: string
  onSuccess: (data: any) => void
  onError: (error: string) => void
}

export function OAuthConnector({
  platform,
  organizationId,
  onSuccess,
  onError
}: OAuthConnectorProps) {
  const [loading, setLoading] = useState(false)
  const [authWindow, setAuthWindow] = useState<Window | null>(null)

  const platformInfo = {
    google: {
      name: 'Google Ads',
      icon: '🔍',
      color: 'bg-blue-600',
      permissions: [
        'View your Google Ads accounts',
        'View campaign performance data',
        'Access keyword analytics',
        'Read conversion tracking data'
      ]
    },
    facebook: {
      name: 'Facebook Ads',
      icon: '👥',
      color: 'bg-blue-500',
      permissions: [
        'Access your ad accounts',
        'View campaign insights',
        'Read audience analytics',
        'Access pixel data'
      ]
    }
  }

  const info = platformInfo[platform]

  const handleOAuthConnect = async () => {
    setLoading(true)

    try {
      // Get OAuth URL from backend
      const { authorization_url, state } = await connectorsService.initiateOAuth(
        platform,
        organizationId
      )

      // Open OAuth window
      const width = 600
      const height = 700
      const left = window.screen.width / 2 - width / 2
      const top = window.screen.height / 2 - height / 2

      const popup = window.open(
        authorization_url,
        'oauth-connect',
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      )

      setAuthWindow(popup)

      // Poll for completion
      const pollInterval = setInterval(() => {
        try {
          if (!popup || popup.closed) {
            clearInterval(pollInterval)
            setLoading(false)
            onError('Authorization cancelled')
            return
          }

          // Check if redirected back
          if (popup.location.href.includes('/callback')) {
            const url = new URL(popup.location.href)
            const success = url.searchParams.get('success')
            const connectionId = url.searchParams.get('connection_id')
            const error = url.searchParams.get('error')

            popup.close()
            clearInterval(pollInterval)

            if (success === 'true' && connectionId) {
              handleSuccess(connectionId)
            } else {
              setLoading(false)
              onError(error || 'Connection failed')
            }
          }
        } catch (e) {
          // Cross-origin error is expected
        }
      }, 1000)

      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval)
        if (popup && !popup.closed) {
          popup.close()
        }
        setLoading(false)
        onError('Authorization timeout')
      }, 5 * 60 * 1000)

    } catch (error: any) {
      setLoading(false)
      onError(error.message || 'Failed to initiate OAuth')
    }
  }

  const handleSuccess = async (connectionId: string) => {
    try {
      // Get connection details
      const connectionDetails = await connectorsService.getConnection(connectionId)
      setLoading(false)
      onSuccess({
        connection_id: connectionId,
        account_info: connectionDetails
      })
    } catch (error) {
      setLoading(false)
      onSuccess({ connection_id: connectionId })
    }
  }

  return (
    <div className="space-y-6">
      {/* Platform Info */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start space-x-4">
            <div className={`p-3 rounded-lg ${info.color} text-white text-2xl`}>
              {info.icon}
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-lg">{info.name}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Connect your {info.name} account to sync advertising data
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Permissions */}
      <div className="space-y-3">
        <h4 className="font-medium">Permissions requested:</h4>
        <ul className="space-y-2">
          {info.permissions.map((permission, index) => (
            <li key={index} className="flex items-start space-x-2">
              <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              <span className="text-sm">{permission}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Security Notice */}
      <Alert>
        <AlertDescription>
          🔒 Your credentials are never stored. We only receive a secure token to access your data on your behalf.
        </AlertDescription>
      </Alert>

      {/* Connect Button */}
      <Button
        className="w-full"
        size="lg"
        onClick={handleOAuthConnect}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Waiting for authorization...
          </>
        ) : (
          <>
            <span className="mr-2">{info.icon}</span>
            Connect {info.name}
          </>
        )}
      </Button>

      {/* Help Text */}
      {loading && (
        <p className="text-sm text-center text-muted-foreground">
          A popup window should have opened. Please complete the authorization there.
          <br />
          <button
            className="text-primary underline"
            onClick={() => authWindow?.focus()}
          >
            Click here if the popup was blocked
          </button>
        </p>
      )}
    </div>
  )
}
```

### 14.5 Data Sync Step
```tsx
// apps/dashboard/app/onboarding/steps/sync.tsx
'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SyncStatusMonitor } from '@/components/sync/sync-status-monitor'
import { syncService } from '@api/services/sync'
import { CheckCircle2, Loader2 } from 'lucide-react'

export function DataSync({ data, onNext, onBack, onSkip }) {
  const [syncJobs, setSyncJobs] = useState<Map<string, string>>(new Map())
  const [completedSyncs, setCompletedSyncs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Auto-start syncs
    if (data.connections.length > 0 && syncJobs.size === 0) {
      startInitialSyncs()
    }
  }, [data.connections])

  const startInitialSyncs = async () => {
    setLoading(true)

    for (const connection of data.connections) {
      try {
        const { job_id } = await syncService.triggerSync(connection.connectionId, {
          syncType: 'full',
        })

        setSyncJobs(prev => {
          const updated = new Map(prev)
          updated.set(connection.platform, job_id)
          return updated
        })
      } catch (error) {
        console.error(`Failed to start sync for ${connection.platform}:`, error)
      }
    }

    setLoading(false)
  }

  const handleSyncComplete = (platform: string) => {
    setCompletedSyncs(prev => {
      const updated = new Set(prev)
      updated.add(platform)
      return updated
    })
  }

  const allSyncsComplete = completedSyncs.size === data.connections.length

  const handleContinue = () => {
    const syncJobsList = Array.from(syncJobs.entries()).map(([platform, jobId]) => ({
      platform,
      jobId,
      status: completedSyncs.has(platform) ? 'completed' : 'running'
    }))

    onNext({ syncJobs: syncJobsList })
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Initial Data Sync</CardTitle>
        <CardDescription>
          We're syncing your historical data. This may take a few minutes depending on your data volume.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Sync Status for Each Platform */}
        {data.connections.map((connection) => (
          <div key={connection.platform} className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">
                {connection.platform.charAt(0).toUpperCase() + connection.platform.slice(1)}
              </h4>
              {completedSyncs.has(connection.platform) && (
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              )}
            </div>

            <SyncStatusMonitor
              connectionId={connection.connectionId}
              platform={connection.platform}
              onComplete={() => handleSyncComplete(connection.platform)}
            />
          </div>
        ))}

        {/* Summary */}
        <Alert>
          <AlertDescription>
            {completedSyncs.size} of {data.connections.length} syncs completed.
            {!allSyncsComplete && ' You can continue while syncs run in the background.'}
          </AlertDescription>
        </Alert>

        {/* Actions */}
        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Back
          </Button>
          <div className="space-x-2">
            <Button
              variant="ghost"
              onClick={onSkip}
              disabled={loading}
            >
              Continue in Background
            </Button>
            <Button
              onClick={handleContinue}
              disabled={loading}
            >
              {allSyncsComplete ? 'Complete Setup' : 'Continue'}
              {loading && <Loader2 className="w-4 h-4 ml-2 animate-spin" />}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

---

## Testing Strategy

### Unit Tests
```typescript
// apps/dashboard/__tests__/auth.test.ts
import { renderHook, act } from '@testing-library/react'
import { useAuth } from '@/contexts/auth'

describe('Auth Context', () => {
  it('should login user successfully', async () => {
    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.login('test@example.com', 'password123')
    })

    expect(result.current.user).toBeDefined()
    expect(result.current.user?.email).toBe('test@example.com')
  })
})
```

### E2E Tests
```typescript
// tests/e2e/onboarding.spec.ts
import { test, expect } from '@playwright/test'

test('complete onboarding flow', async ({ page }) => {
  // Register
  await page.goto('/register')
  await page.fill('[name="email"]', 'test@example.com')
  await page.fill('[name="password"]', 'SecurePass123')
  await page.fill('[name="organization_name"]', 'Test Org')
  await page.click('button[type="submit"]')

  // Onboarding
  await expect(page).toHaveURL('/onboarding')

  // Select platforms
  await page.click('text=Stripe')
  await page.click('text=Continue')

  // Connect Stripe
  await page.fill('[name="api_key"]', 'sk_test_...')
  await page.click('text=Connect')

  // Complete
  await expect(page).toHaveURL('/dashboard')
})
```

---

## Deployment Checklist

### Pre-Deployment
- [ ] Environment variables configured
- [ ] API endpoints tested
- [ ] Authentication flow verified
- [ ] Error tracking setup
- [ ] Analytics configured
- [ ] Security headers tested
- [ ] Performance optimizations applied
- [ ] Cross-browser testing completed

### Deployment Steps
1. Push code to GitHub main branch
2. GitHub Actions builds and tests
3. Cloudflare Pages deploys automatically
4. Verify deployment at staging URL
5. Update DNS records if needed
6. Test production endpoints
7. Monitor error tracking
8. Check analytics data flow

### Post-Deployment
- [ ] Verify all routes work
- [ ] Test authentication flow
- [ ] Check API integrations
- [ ] Monitor error rates
- [ ] Review performance metrics
- [ ] Update status page
- [ ] Notify team

---

## Quick Start Commands

```bash
# Clone and setup
git clone https://github.com/your-org/clearlift-frontend
cd clearlift-frontend
npm install

# Development
npm run dev         # Start all apps
npm run dev:dashboard  # Dashboard only
npm run dev:marketing  # Marketing site only

# Testing
npm run test        # Unit tests
npm run test:e2e    # E2E tests
npm run lint        # Linting

# Building
npm run build       # Build all apps
npm run build:dashboard  # Dashboard only

# Deployment
npm run deploy      # Deploy to Cloudflare Pages
```

---

## Support & Resources

### Documentation
- API Documentation: https://docs.clearlift.ai/api
- Component Library: https://docs.clearlift.ai/components
- Architecture Guide: https://docs.clearlift.ai/architecture

### Monitoring
- Status Page: https://status.clearlift.ai
- Sentry Dashboard: https://sentry.io/organizations/clearlift
- PostHog Analytics: https://app.posthog.com

### Team Resources
- GitHub: https://github.com/clearlift
- Slack: #clearlift-dev
- Figma: ClearLift Design System

---

This guide provides everything needed to build the complete ClearLift frontend from scratch to production. Follow each section sequentially for best results.