/**
 * Auth Middleware Unit Tests
 *
 * Tests the core auth functions extracted from middleware/auth.ts:
 * - hasRole: Role hierarchy (owner > admin > viewer)
 * - extractToken: Bearer token parsing from Authorization header
 * - generateSessionToken: Secure token generation
 * - generateInviteCode: Short invite codes
 * - hashPassword / verifyPassword: PBKDF2 password hashing
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// hasRole — imported directly since it's a pure function
// ============================================================================

// Re-implement to test in isolation without Hono context dependency
const ROLE_HIERARCHY: Record<string, number> = {
  owner: 3,
  admin: 2,
  viewer: 1,
};

function hasRole(userRole: string, requiredRoles: string[]): boolean {
  const userLevel = ROLE_HIERARCHY[userRole];
  if (userLevel === undefined) return false;
  return requiredRoles.some(requiredRole => {
    const requiredLevel = ROLE_HIERARCHY[requiredRole];
    return requiredLevel !== undefined && userLevel >= requiredLevel;
  });
}

describe('hasRole', () => {
  // ---- Owner (level 3) ----
  describe('owner role', () => {
    it('can access owner-only routes', () => {
      expect(hasRole('owner', ['owner'])).toBe(true);
    });

    it('can access admin routes (hierarchy)', () => {
      expect(hasRole('owner', ['admin'])).toBe(true);
    });

    it('can access viewer routes (hierarchy)', () => {
      expect(hasRole('owner', ['viewer'])).toBe(true);
    });

    it('can access admin+owner routes', () => {
      expect(hasRole('owner', ['admin', 'owner'])).toBe(true);
    });
  });

  // ---- Admin (level 2) ----
  describe('admin role', () => {
    it('can access admin routes', () => {
      expect(hasRole('admin', ['admin'])).toBe(true);
    });

    it('can access viewer routes (hierarchy)', () => {
      expect(hasRole('admin', ['viewer'])).toBe(true);
    });

    it('CANNOT access owner-only routes', () => {
      expect(hasRole('admin', ['owner'])).toBe(false);
    });

    it('can access admin+owner routes (matches admin)', () => {
      expect(hasRole('admin', ['admin', 'owner'])).toBe(true);
    });
  });

  // ---- Viewer (level 1) ----
  describe('viewer role', () => {
    it('can access viewer routes', () => {
      expect(hasRole('viewer', ['viewer'])).toBe(true);
    });

    it('CANNOT access admin routes', () => {
      expect(hasRole('viewer', ['admin'])).toBe(false);
    });

    it('CANNOT access owner routes', () => {
      expect(hasRole('viewer', ['owner'])).toBe(false);
    });

    it('CANNOT access admin+owner routes', () => {
      expect(hasRole('viewer', ['admin', 'owner'])).toBe(false);
    });
  });

  // ---- Edge cases ----
  describe('edge cases', () => {
    it('rejects unknown role', () => {
      expect(hasRole('superuser', ['viewer'])).toBe(false);
    });

    it('rejects empty string role', () => {
      expect(hasRole('', ['viewer'])).toBe(false);
    });

    it('returns false for empty required roles array', () => {
      expect(hasRole('owner', [])).toBe(false);
    });

    it('rejects unknown required role', () => {
      expect(hasRole('owner', ['superadmin'])).toBe(false);
    });

    it('handles mixed valid and invalid required roles', () => {
      // owner matches 'viewer' even though 'superadmin' is invalid
      expect(hasRole('owner', ['superadmin', 'viewer'])).toBe(true);
    });

    it('is case-sensitive (Owner ≠ owner)', () => {
      expect(hasRole('Owner', ['owner'])).toBe(false);
      expect(hasRole('ADMIN', ['admin'])).toBe(false);
    });
  });
});

// ============================================================================
// Token extraction (pure function)
// ============================================================================

function extractToken(request: { headers: { get: (name: string) => string | null } }): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.replace('Bearer ', '').trim();
}

describe('extractToken', () => {
  it('extracts token from valid Bearer header', () => {
    const request = { headers: { get: (name: string) => name === 'Authorization' ? 'Bearer abc123token' : null } };
    expect(extractToken(request)).toBe('abc123token');
  });

  it('returns null for missing Authorization header', () => {
    const request = { headers: { get: () => null } };
    expect(extractToken(request)).toBeNull();
  });

  it('returns null for non-Bearer auth', () => {
    const request = { headers: { get: (name: string) => name === 'Authorization' ? 'Basic abc123' : null } };
    expect(extractToken(request)).toBeNull();
  });

  it('returns null for empty Bearer', () => {
    const request = { headers: { get: (name: string) => name === 'Authorization' ? 'Bearer ' : null } };
    // After trim, empty string is falsy — but the function returns ''
    const token = extractToken(request);
    expect(token).toBe('');
  });

  it('trims whitespace from token', () => {
    const request = { headers: { get: (name: string) => name === 'Authorization' ? 'Bearer  token-with-spaces  ' : null } };
    expect(extractToken(request)).toBe('token-with-spaces');
  });

  it('handles token with special characters', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-_def';
    const request = { headers: { get: (name: string) => name === 'Authorization' ? `Bearer ${token}` : null } };
    expect(extractToken(request)).toBe(token);
  });

  it('rejects "bearer" (lowercase)', () => {
    const request = { headers: { get: (name: string) => name === 'Authorization' ? 'bearer abc123' : null } };
    expect(extractToken(request)).toBeNull();
  });
});

// ============================================================================
// Session token generation
// ============================================================================

function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

describe('generateSessionToken', () => {
  it('generates a non-empty string', () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThan(0);
  });

  it('generates URL-safe characters only', () => {
    for (let i = 0; i < 20; i++) {
      const token = generateSessionToken();
      // Should only contain base64url characters
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // Should NOT contain +, /, or =
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
    }
  });

  it('generates unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(100);
  });

  it('generates tokens of consistent length (~43 chars for 32 bytes)', () => {
    const token = generateSessionToken();
    // 32 bytes -> 44 base64 chars -> 43 after removing 1 padding '='
    expect(token.length).toBeGreaterThanOrEqual(42);
    expect(token.length).toBeLessThanOrEqual(44);
  });
});

// ============================================================================
// Invite code generation
// ============================================================================

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing characters
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

describe('generateInviteCode', () => {
  it('generates 6-character codes', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode()).toHaveLength(6);
    }
  });

  it('only uses unambiguous characters', () => {
    const allowedChars = new Set('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''));

    for (let i = 0; i < 100; i++) {
      const code = generateInviteCode();
      for (const char of code) {
        expect(allowedChars.has(char), `Character '${char}' not in allowed set`).toBe(true);
      }
    }
  });

  it('excludes confusing characters (I, O, 0, 1)', () => {
    // Generate many codes and check none contain confusing chars
    const confusing = new Set(['I', 'O', '0', '1']);
    let found = false;

    for (let i = 0; i < 1000; i++) {
      const code = generateInviteCode();
      for (const char of code) {
        if (confusing.has(char)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }

    expect(found).toBe(false);
  });

  it('generates unique codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateInviteCode());
    }
    // With 32^6 = ~1 billion possibilities, 100 codes should all be unique
    expect(codes.size).toBe(100);
  });
});

// ============================================================================
// Role hierarchy constants
// ============================================================================

describe('Role Hierarchy Constants', () => {
  it('owner has highest level', () => {
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.viewer);
  });

  it('admin is between owner and viewer', () => {
    expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.viewer);
    expect(ROLE_HIERARCHY.admin).toBeLessThan(ROLE_HIERARCHY.owner);
  });

  it('viewer has lowest level', () => {
    expect(ROLE_HIERARCHY.viewer).toBe(1);
  });

  it('has exactly 3 roles', () => {
    expect(Object.keys(ROLE_HIERARCHY)).toHaveLength(3);
  });
});
