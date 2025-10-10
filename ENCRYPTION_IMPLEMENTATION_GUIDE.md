# Field-Level Encryption Implementation Guide

## Overview

This guide shows how to implement field-level encryption in ClearLift API using Cloudflare Workers Web Crypto API.

## Architecture

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Management**: Master key stored in Cloudflare Secrets Store
- **Search Strategy**: Deterministic hashing for exact-match lookups
- **Zero Dependencies**: Uses native Web Crypto API

## Data Storage Locations

### 1. Cloudflare D1 (Primary Database)
- **Location**: Database ID `89bd84be-b517-4c72-ab61-422384319361`
- **Sensitive Fields**:
  - `users.email` - PII
  - `users.identity_nonce` - Authentication data
  - `sessions.ip_address` - PII
  - `platform_connections.settings` - OAuth credentials
  - `invitations.email` - PII

### 2. Supabase (Ad Data)
- **Location**: `jwosqxmfezmnhrbbjlbx.supabase.co`
- **Encryption**: Handled by Supabase's built-in encryption at rest
- **Action Required**: None (uses Supabase native encryption)

### 3. R2 SQL (Analytics Events)
- **Location**: R2 bucket `clearlift-prod`
- **Sensitive Fields**: `user_id`, `anonymous_id`, geo data
- **Encryption**: R2 provides encryption at rest by default
- **Action Required**: None for at-rest encryption (already encrypted)

## Setup Instructions

### Step 1: Generate Master Key

```bash
# Generate a new master encryption key
npx tsx scripts/generate-encryption-key.ts

# Store in Cloudflare Secrets Store
npx wrangler secret put ENCRYPTION_KEY
# Paste the generated key when prompted
```

### Step 2: Update Environment Types

Add to `src/types.ts`:

```typescript
declare global {
  interface Env {
    DB: D1Database;
    ENCRYPTION_KEY: string;  // Add this line
    // ... other env vars
  }
}
```

### Step 3: Run Migration

```bash
# Apply encryption fields migration
npm run predeploy
# or for local development:
npm run seedLocalDb
```

### Step 4: Update D1Adapter

Here's an example of updating the `D1Adapter` to use encryption:

```typescript
// src/adapters/d1.ts

import { FieldEncryption } from '../utils/crypto';

export class D1Adapter {
  private encryption: FieldEncryption | null = null;

  constructor(private db: D1Database, private encryptionKey?: string) {
    // Initialize encryption if key is provided
    if (encryptionKey) {
      FieldEncryption.create(encryptionKey).then(enc => {
        this.encryption = enc;
      });
    }
  }

  /**
   * Find user by email (with encrypted email support)
   */
  async findUserByEmail(email: string): Promise<User | null> {
    if (!this.encryption) {
      // Fallback to plaintext search (for backwards compatibility)
      return this.db
        .prepare("SELECT * FROM users WHERE email = ?")
        .bind(email)
        .first<User>();
    }

    // Generate search hash
    const hash = await this.encryption.searchHash(email);

    // Search by hash
    const result = await this.db
      .prepare("SELECT * FROM users WHERE email_hash = ?")
      .bind(hash)
      .first<User & { email_encrypted: string }>();

    if (!result) return null;

    // Decrypt email before returning
    const decryptedEmail = await this.encryption.decrypt(result.email_encrypted);

    return {
      ...result,
      email: decryptedEmail
    };
  }

  /**
   * Create user with encrypted email
   */
  async createUser(userData: {
    email: string;
    name: string;
    issuer: string;
    access_sub: string;
  }): Promise<string> {
    const userId = crypto.randomUUID();

    if (!this.encryption) {
      // Fallback to plaintext (shouldn't happen in production)
      await this.db
        .prepare(`
          INSERT INTO users (id, email, name, issuer, access_sub, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `)
        .bind(userId, userData.email, userData.name, userData.issuer, userData.access_sub)
        .run();

      return userId;
    }

    // Encrypt email
    const { encrypted, hash } = await this.encryption.encryptWithHash(userData.email);

    await this.db
      .prepare(`
        INSERT INTO users (
          id, email, email_encrypted, email_hash,
          name, issuer, access_sub, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        userId,
        userData.email,        // Keep plaintext temporarily for migration
        encrypted,              // Encrypted version
        hash,                   // Search hash
        userData.name,
        userData.issuer,
        userData.access_sub
      )
      .run();

    return userId;
  }

  /**
   * Create session with encrypted IP
   */
  async createSession(
    userId: string,
    ipAddress: string,
    userAgent: string,
    expiresAt: string
  ): Promise<string> {
    const token = crypto.randomUUID();

    if (!this.encryption) {
      await this.db
        .prepare(`
          INSERT INTO sessions (token, user_id, ip_address, user_agent, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(token, userId, ipAddress, userAgent, expiresAt)
        .run();

      return token;
    }

    // Encrypt IP address
    const encryptedIp = await this.encryption.encrypt(ipAddress);

    await this.db
      .prepare(`
        INSERT INTO sessions (
          token, user_id, ip_address, ip_address_encrypted,
          user_agent, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(token, userId, ipAddress, encryptedIp, userAgent, expiresAt)
      .run();

    return token;
  }
}
```

### Step 5: Update Initialization

In your endpoints or middleware, initialize D1Adapter with encryption:

```typescript
// Before
const d1 = new D1Adapter(c.env.DB);

// After
const d1 = new D1Adapter(c.env.DB, c.env.ENCRYPTION_KEY);
```

## Migration Strategy (Since You're Pre-Launch)

Since there's no production data yet, you can choose:

### Option A: Fresh Start (Recommended)
1. Drop and recreate all tables with encryption columns
2. All new data is encrypted from day 1
3. Remove plaintext columns entirely

### Option B: Dual-Write Pattern
1. Keep plaintext columns for backward compatibility
2. Write to both plaintext and encrypted columns
3. Gradually migrate code to read from encrypted
4. Remove plaintext columns once migration is complete

## Security Considerations

### What This Protects Against
✅ Database dumps/backups being readable
✅ Unauthorized access to D1 database
✅ Insider threats with database access
✅ Compliance requirements (GDPR, CCPA)

### What This Does NOT Protect Against
❌ Memory dumps while data is decrypted
❌ Compromise of the master encryption key
❌ SQL injection (use parameterized queries)
❌ Application-level vulnerabilities

### Key Management Best Practices
1. **Never commit keys to git** - Use Cloudflare Secrets Store only
2. **Rotate keys periodically** - Plan for key rotation strategy
3. **Backup keys securely** - Store in password manager/HSM
4. **Use different keys for dev/prod** - Separate environments

## Performance Impact

- **Encryption**: ~0.1-0.5ms per field
- **Decryption**: ~0.1-0.5ms per field
- **Hash generation**: ~0.05ms per field
- **Overall**: Minimal impact (<5ms) for typical queries

## Testing Encryption

```typescript
// tests/crypto.test.ts
import { describe, it, expect } from 'vitest';
import { FieldEncryption } from '../src/utils/crypto';

describe('FieldEncryption', () => {
  it('should encrypt and decrypt values', async () => {
    const key = await FieldEncryption.generateMasterKey();
    const crypto = await FieldEncryption.create(key);

    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
    expect(encrypted).not.toBe(plaintext);
  });

  it('should generate consistent search hashes', async () => {
    const key = await FieldEncryption.generateMasterKey();
    const crypto = await FieldEncryption.create(key);

    const hash1 = await crypto.searchHash('test@example.com');
    const hash2 = await crypto.searchHash('test@example.com');
    const hash3 = await crypto.searchHash('TEST@EXAMPLE.COM'); // Case insensitive

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
  });

  it('should produce different ciphertexts for same plaintext', async () => {
    const key = await FieldEncryption.generateMasterKey();
    const crypto = await FieldEncryption.create(key);

    const plaintext = 'test@example.com';
    const encrypted1 = await crypto.encrypt(plaintext);
    const encrypted2 = await crypto.encrypt(plaintext);

    // Different ciphertexts (due to random IV)
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to same value
    expect(await crypto.decrypt(encrypted1)).toBe(plaintext);
    expect(await crypto.decrypt(encrypted2)).toBe(plaintext);
  });
});
```

## Rollout Checklist

- [ ] Generate master encryption key
- [ ] Store key in Cloudflare Secrets Store (production)
- [ ] Add ENCRYPTION_KEY to local .env (development)
- [ ] Run migration to add encrypted columns
- [ ] Update D1Adapter with encryption logic
- [ ] Update all user creation/update endpoints
- [ ] Update session creation endpoints
- [ ] Add unit tests for encryption
- [ ] Test end-to-end on development
- [ ] Deploy to production
- [ ] Monitor for errors
- [ ] (Optional) Remove plaintext columns after validation

## Future Enhancements

1. **Key Rotation**: Implement versioned encryption keys
2. **Column-Level Keys**: Different keys for different data types
3. **Audit Logging**: Log all encryption/decryption operations
4. **R2 Event Encryption**: Encrypt PII in analytics events before writing to R2
5. **Supabase RLS**: Use Row-Level Security for additional access control
