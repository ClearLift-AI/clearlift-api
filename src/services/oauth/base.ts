/**
 * CANONICAL: Base OAuth 2.0 Provider (RFC 9700 Compliant - 2025)
 *
 * This is the canonical OAuth implementation with all provider types defined.
 * A copy exists in clearlift-cron/shared/oauth/base.ts for workflow use.
 *
 * @see clearlift-cron/docs/SHARED_CODE.md section 9 for documentation
 *
 * Abstract class for OAuth 2.0 flows with different providers.
 * Implements OAuth 2.0 Security Best Current Practice (BCP 214).
 *
 * Security Features:
 * - PKCE (Proof Key for Code Exchange) - MANDATORY per RFC 9700
 * - CSRF protection via state parameter
 * - Secure error handling (no sensitive data leakage)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9700
 * @see https://datatracker.ietf.org/doc/html/rfc7636 (PKCE)
 */

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  raw?: any;
}

/**
 * PKCE code challenge method
 */
export type PKCEMethod = 'S256' | 'plain';

/**
 * PKCE challenge pair for authorization flow
 */
export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: PKCEMethod;
}

export abstract class OAuthProvider {
  protected config: OAuthConfig;
  protected readonly REQUEST_TIMEOUT_MS = 30000; // 30 seconds

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  /**
   * Generate PKCE code verifier and challenge (RFC 7636)
   *
   * Code verifier: 43-128 character random string
   * Code challenge: Base64-URL-encoded SHA256 hash of verifier
   *
   * @returns PKCE challenge pair
   */
  async generatePKCEChallenge(): Promise<PKCEChallenge> {
    // Generate cryptographically secure random code verifier (43-128 chars)
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const codeVerifier = this.base64URLEncode(array);

    // Create SHA-256 hash of code verifier
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const codeChallenge = this.base64URLEncode(new Uint8Array(hashBuffer));

    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: 'S256'
    };
  }

  /**
   * Base64-URL encode (without padding, RFC 4648)
   */
  private base64URLEncode(buffer: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Generate OAuth authorization URL with PKCE
   *
   * IMPORTANT: Caller must store pkce.codeVerifier securely and pass it to
   * exchangeCodeForToken(). Store in session/database, NOT in URL/cookie.
   *
   * @param state - CSRF protection state token (store server-side)
   * @param pkce - PKCE challenge (generate via generatePKCEChallenge())
   * @param additionalParams - Provider-specific parameters
   * @returns Authorization URL to redirect user to
   */
  getAuthorizationUrl(
    state: string,
    pkce: PKCEChallenge,
    additionalParams?: Record<string, string>
  ): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      ...additionalParams
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token (with PKCE)
   *
   * IMPORTANT: Must provide the same codeVerifier that was used to generate
   * the codeChallenge in getAuthorizationUrl().
   *
   * @param code - Authorization code from OAuth callback
   * @param codeVerifier - PKCE code verifier (from generatePKCEChallenge)
   * @returns OAuth tokens including access_token and optional refresh_token
   * @throws Error if token exchange fails
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthTokens> {
    console.log('Exchanging code for token with PKCE', {
      tokenUrl: this.config.tokenUrl,
      redirectUri: this.config.redirectUri,
      hasClientId: !!this.config.clientId,
      hasClientSecret: !!this.config.clientSecret,
      hasCode: !!code,
      hasCodeVerifier: !!codeVerifier
    });

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: this.config.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier // PKCE verification
        }).toString(),
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Token exchange failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });

        // Try to parse error response
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMessage = typeof errorJson.error === 'string'
              ? errorJson.error
              : errorJson.error.message || JSON.stringify(errorJson.error);
          }
        } catch (e) {
          // Use raw error text
        }

        throw new Error(`Token exchange failed (${response.status}): ${errorMessage}`);
      }

      const tokens = await response.json() as OAuthTokens;
      console.log('Token exchange successful', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error) {
        // Re-throw AbortError with friendly message
        if (error.name === 'AbortError') {
          throw new Error('OAuth token exchange timed out');
        }
        // Sanitize error message to prevent secret leakage
        const sanitizedMessage = this.sanitizeErrorMessage(error.message);
        throw new Error(`OAuth token exchange failed: ${sanitizedMessage}`);
      }
      throw new Error('OAuth token exchange failed');
    }
  }

  /**
   * Sanitize error messages to prevent leaking sensitive data
   * Removes client_secret, access_token, refresh_token patterns
   */
  private sanitizeErrorMessage(message: string): string {
    // Patterns that might contain sensitive data
    const sensitivePatterns = [
      /client_secret[=:]\s*[^\s&,}]*/gi,
      /access_token[=:]\s*[^\s&,}]*/gi,
      /refresh_token[=:]\s*[^\s&,}]*/gi,
      /secret[=:]\s*[^\s&,}]*/gi,
      /password[=:]\s*[^\s&,}]*/gi,
      /api_key[=:]\s*[^\s&,}]*/gi,
    ];

    let sanitized = message;
    for (const pattern of sensitivePatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Get user information from provider
   * Must be implemented by each provider
   */
  abstract getUserInfo(accessToken: string): Promise<OAuthUserInfo>;

  /**
   * Validate access token
   * Must be implemented by each provider
   */
  abstract validateToken(accessToken: string): Promise<boolean>;
}
