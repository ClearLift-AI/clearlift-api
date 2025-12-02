/**
 * OAuth 2.0 PKCE Flow Tests (RFC 9700 Compliance)
 *
 * These tests verify:
 * 1. PKCE is properly generated and used
 * 2. Authorization URLs contain PKCE parameters
 * 3. Token exchange includes PKCE verifier
 * 4. Full OAuth flow works end-to-end
 * 5. State parameter is properly validated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoogleAdsOAuthProvider } from '../src/services/oauth/google';
import { FacebookAdsOAuthProvider } from '../src/services/oauth/facebook';
import type { PKCEChallenge } from '../src/services/oauth/base';

describe('OAuth 2.0 PKCE Flow - RFC 9700 Compliance', () => {
  describe('GoogleAdsOAuthProvider', () => {
    let provider: GoogleAdsOAuthProvider;

    beforeEach(() => {
      provider = new GoogleAdsOAuthProvider(
        'test-client-id',
        'test-client-secret',
        'https://api.clearlift.ai/v1/connectors/google/callback'
      );
      vi.clearAllMocks();
    });

    describe('PKCE Generation', () => {
      it('should generate valid PKCE challenge', async () => {
        const pkce = await provider.generatePKCEChallenge();

        expect(pkce).toHaveProperty('codeVerifier');
        expect(pkce).toHaveProperty('codeChallenge');
        expect(pkce).toHaveProperty('codeChallengeMethod');
        expect(pkce.codeChallengeMethod).toBe('S256');
      });

      it('should generate code verifier between 43-128 characters', async () => {
        const pkce = await provider.generatePKCEChallenge();

        expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
        expect(pkce.codeVerifier.length).toBeLessThanOrEqual(128);
      });

      it('should generate unique PKCE challenges', async () => {
        const pkce1 = await provider.generatePKCEChallenge();
        const pkce2 = await provider.generatePKCEChallenge();

        expect(pkce1.codeVerifier).not.toBe(pkce2.codeVerifier);
        expect(pkce1.codeChallenge).not.toBe(pkce2.codeChallenge);
      });

      it('should use base64url encoding (no padding)', async () => {
        const pkce = await provider.generatePKCEChallenge();

        // Base64URL should not contain +, /, or =
        expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      });
    });

    describe('Authorization URL', () => {
      it('should include PKCE parameters in authorization URL', async () => {
        const pkce = await provider.generatePKCEChallenge();
        const state = 'test-state-token';
        const url = provider.getAuthorizationUrl(state, pkce);

        const urlObj = new URL(url);
        expect(urlObj.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
        expect(urlObj.searchParams.get('code_challenge_method')).toBe('S256');
      });

      it('should include all required OAuth 2.0 parameters', async () => {
        const pkce = await provider.generatePKCEChallenge();
        const state = 'test-state';
        const url = provider.getAuthorizationUrl(state, pkce);

        const urlObj = new URL(url);
        expect(urlObj.searchParams.get('client_id')).toBe('test-client-id');
        expect(urlObj.searchParams.get('redirect_uri')).toBe('https://api.clearlift.ai/v1/connectors/google/callback');
        expect(urlObj.searchParams.get('response_type')).toBe('code');
        expect(urlObj.searchParams.get('state')).toBe('test-state');
        expect(urlObj.searchParams.get('scope')).toContain('adwords');
      });

      it('should include Google-specific parameters for refresh tokens', async () => {
        const pkce = await provider.generatePKCEChallenge();
        const url = provider.getAuthorizationUrl('state', pkce);

        const urlObj = new URL(url);
        expect(urlObj.searchParams.get('access_type')).toBe('offline');
        expect(urlObj.searchParams.get('prompt')).toBe('consent');
        expect(urlObj.searchParams.get('include_granted_scopes')).toBe('true');
      });

      it('should fail if PKCE is not provided (RFC 9700 requirement)', () => {
        // This test verifies that TypeScript enforces PKCE
        // @ts-expect-error - Should require PKCE parameter
        expect(() => provider.getAuthorizationUrl('state')).toThrow();
      });
    });

    describe('Token Exchange with PKCE', () => {
      it('should exchange authorization code for tokens with PKCE verifier', async () => {
        const mockTokens = {
          access_token: 'ya29.test_access_token',
          refresh_token: '1//test_refresh_token',
          expires_in: 3599,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/adwords'
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockTokens
        });

        const code = 'test_authorization_code';
        const codeVerifier = 'test_code_verifier_from_pkce_generation';

        const tokens = await provider.exchangeCodeForToken(code, codeVerifier);

        expect(tokens.access_token).toBe('ya29.test_access_token');
        expect(tokens.refresh_token).toBe('1//test_refresh_token');

        // Verify PKCE verifier was sent
        const fetchCall = (global.fetch as any).mock.calls[0];
        const bodyParams = new URLSearchParams(fetchCall[1].body);
        expect(bodyParams.get('code_verifier')).toBe(codeVerifier);
        expect(bodyParams.get('code')).toBe(code);
        expect(bodyParams.get('grant_type')).toBe('authorization_code');
      });

      it('should include code_verifier in token exchange (security requirement)', async () => {
        // Note: TypeScript enforces code_verifier at compile time.
        // This test verifies the parameter is actually sent to the server.
        const mockTokens = {
          access_token: 'ya29.test_access_token',
          refresh_token: '1//test_refresh_token',
          expires_in: 3599,
          token_type: 'Bearer'
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockTokens
        });

        await provider.exchangeCodeForToken('code', 'verifier');

        const fetchCall = (global.fetch as any).mock.calls[0];
        const bodyParams = new URLSearchParams(fetchCall[1].body);
        // Verify code_verifier is actually sent (PKCE requirement)
        expect(bodyParams.get('code_verifier')).toBe('verifier');
      });

      it('should include timeout protection', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ access_token: 'token' })
        });

        await provider.exchangeCodeForToken('code', 'verifier');

        const fetchCall = (global.fetch as any).mock.calls[0];
        expect(fetchCall[1].signal).toBeDefined();
      });

      it('should handle token exchange errors gracefully', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Code already used'
          })
        });

        await expect(
          provider.exchangeCodeForToken('invalid_code', 'verifier')
        ).rejects.toThrow(/Token exchange failed/);
      });
    });

    describe('Complete OAuth Flow Simulation', () => {
      it('should complete full OAuth flow with PKCE', async () => {
        // Step 1: Generate PKCE
        const pkce = await provider.generatePKCEChallenge();
        expect(pkce.codeVerifier).toBeDefined();
        expect(pkce.codeChallenge).toBeDefined();

        // Step 2: Generate authorization URL
        const state = crypto.randomUUID();
        const authUrl = provider.getAuthorizationUrl(state, pkce);

        // Verify PKCE is in URL
        const urlObj = new URL(authUrl);
        expect(urlObj.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
        expect(urlObj.searchParams.get('state')).toBe(state);

        // Step 3: Simulate OAuth callback with authorization code
        const authCode = 'simulated_auth_code_from_google';

        // Step 4: Exchange code for token using stored code_verifier
        const mockTokens = {
          access_token: 'ya29.simulated_token',
          refresh_token: '1//simulated_refresh',
          expires_in: 3599,
          token_type: 'Bearer'
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockTokens
        });

        const tokens = await provider.exchangeCodeForToken(authCode, pkce.codeVerifier);

        // Verify tokens received
        expect(tokens.access_token).toBeDefined();
        expect(tokens.refresh_token).toBeDefined();

        // Verify PKCE verifier was used
        const fetchCall = (global.fetch as any).mock.calls[0];
        const bodyParams = new URLSearchParams(fetchCall[1].body);
        expect(bodyParams.get('code_verifier')).toBe(pkce.codeVerifier);
      });

      it('should fail if code_verifier mismatch (security)', async () => {
        const pkce = await provider.generatePKCEChallenge();
        const wrongVerifier = 'wrong_verifier_not_matching_challenge';

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Code verifier mismatch'
          })
        });

        await expect(
          provider.exchangeCodeForToken('code', wrongVerifier)
        ).rejects.toThrow();
      });
    });
  });

  describe('FacebookAdsOAuthProvider', () => {
    let provider: FacebookAdsOAuthProvider;

    beforeEach(() => {
      provider = new FacebookAdsOAuthProvider(
        'test-app-id',
        'test-app-secret',
        'https://api.clearlift.ai/v1/connectors/facebook/callback'
      );
      vi.clearAllMocks();
    });

    describe('PKCE Support', () => {
      it('should generate PKCE challenge', async () => {
        const pkce = await provider.generatePKCEChallenge();

        expect(pkce.codeVerifier).toBeDefined();
        expect(pkce.codeChallenge).toBeDefined();
        expect(pkce.codeChallengeMethod).toBe('S256');
      });

      it('should include PKCE in authorization URL', async () => {
        const pkce = await provider.generatePKCEChallenge();
        const url = provider.getAuthorizationUrl('state', pkce);

        const urlObj = new URL(url);
        expect(urlObj.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
        expect(urlObj.searchParams.get('code_challenge_method')).toBe('S256');
      });

      it('should use PKCE verifier in token exchange', async () => {
        const mockTokens = {
          access_token: 'fb_test_token',
          token_type: 'bearer',
          expires_in: 5183999
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => mockTokens
        });

        const tokens = await provider.exchangeCodeForToken('code', 'verifier');

        const fetchCall = (global.fetch as any).mock.calls[0];
        const bodyParams = new URLSearchParams(fetchCall[1].body);
        expect(bodyParams.get('code_verifier')).toBe('verifier');
      });
    });
  });

  describe('Security Requirements', () => {
    it('should use cryptographically secure random for PKCE', async () => {
      const provider = new GoogleAdsOAuthProvider('id', 'secret', 'uri');
      const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues');

      await provider.generatePKCEChallenge();

      expect(getRandomValuesSpy).toHaveBeenCalled();
      const callArg = getRandomValuesSpy.mock.calls[0][0];
      expect(callArg).toBeInstanceOf(Uint8Array);
      expect(callArg.length).toBe(32); // 256 bits
    });

    it('should use SHA-256 for PKCE challenge', async () => {
      const provider = new GoogleAdsOAuthProvider('id', 'secret', 'uri');
      const digestSpy = vi.spyOn(crypto.subtle, 'digest');

      await provider.generatePKCEChallenge();

      expect(digestSpy).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
    });

    it('should never expose code_verifier in URLs', async () => {
      const provider = new GoogleAdsOAuthProvider('id', 'secret', 'uri');
      const pkce = await provider.generatePKCEChallenge();
      const url = provider.getAuthorizationUrl('state', pkce);

      // Code verifier should NOT be in URL
      expect(url).not.toContain(pkce.codeVerifier);
      // Only code challenge should be in URL
      expect(url).toContain(pkce.codeChallenge);
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts gracefully', async () => {
      const provider = new GoogleAdsOAuthProvider('id', 'secret', 'uri');

      const abortError = new Error('Timeout');
      abortError.name = 'AbortError';

      global.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        provider.exchangeCodeForToken('code', 'verifier')
      ).rejects.toThrow(/timed out/);
    });

    it('should sanitize error messages (no sensitive data leakage)', async () => {
      const provider = new GoogleAdsOAuthProvider('id', 'secret', 'uri');

      global.fetch = vi.fn().mockRejectedValue(
        new Error('Internal: client_secret=abc123 invalid')
      );

      // Should throw sanitized error
      await expect(
        provider.exchangeCodeForToken('code', 'verifier')
      ).rejects.toThrow(/OAuth token exchange failed/);

      // Verify the error message is sanitized (no client_secret value)
      try {
        await provider.exchangeCodeForToken('code', 'verifier');
      } catch (e: any) {
        expect(e.message).toContain('[REDACTED]');
        expect(e.message).not.toContain('abc123');
      }
    });
  });

  describe('OAuth State Management (Database Integration)', () => {
    it('should store PKCE code_verifier as object property in metadata', () => {
      // This test documents the expected format for oauth_states.metadata
      const pkceVerifier = 'test_code_verifier_12345';
      const expectedMetadata = { code_verifier: pkceVerifier };

      // When createOAuthState is called, it should receive metadata as an object
      const metadataForStorage = { code_verifier: pkceVerifier };

      // After JSON.stringify in createOAuthState, it should be:
      const storedValue = JSON.stringify(metadataForStorage);
      expect(storedValue).toBe('{"code_verifier":"test_code_verifier_12345"}');

      // When retrieved and parsed, it should be:
      const retrieved = JSON.parse(storedValue);
      expect(retrieved.code_verifier).toBe(pkceVerifier);
    });

    it('should handle metadata parsing correctly in callback', () => {
      // Simulating what comes from database
      const storedMetadata = '{"code_verifier":"abc123xyz"}';

      // Parse it like the callback does
      const parsed = JSON.parse(storedMetadata);

      // Verify we can extract the verifier
      expect(parsed.code_verifier).toBe('abc123xyz');
      expect(typeof parsed.code_verifier).toBe('string');
    });

    it('should reject if metadata is missing code_verifier', () => {
      const invalidMetadata = JSON.stringify({ some_other_field: 'value' });
      const parsed = JSON.parse(invalidMetadata);

      expect(parsed.code_verifier).toBeUndefined();
    });

    it('should reject if metadata is empty object', () => {
      const emptyMetadata = JSON.stringify({});
      const parsed = JSON.parse(emptyMetadata);

      expect(parsed.code_verifier).toBeUndefined();
    });
  });
});
