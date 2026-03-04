/**
 * Internal Auth Verification
 *
 * Shared utility for verifying internal service-to-service authentication.
 * Used by endpoints called via service bindings (clearlift-cron → clearlift-api).
 *
 * Auth: X-Internal-Key header with HMAC-SHA256 constant-time comparison.
 */

import { getSecret } from "./secrets";
import { structuredLog } from "./structured-logger";

/**
 * Verify internal auth (shared secret via X-Internal-Key header)
 *
 * CF-Worker header alone is spoofable — require shared secret validation.
 * Service bindings between workers should pass the INTERNAL_API_KEY.
 *
 * @param request - The incoming request (raw Request or Hono context)
 * @param env - Worker environment bindings
 * @returns true if the request is authenticated
 */
export async function verifyInternalAuth(
  request: { header: (name: string) => string | undefined | null } | Request,
  env: { INTERNAL_API_KEY?: any }
): Promise<boolean> {
  const internalKey = 'header' in request && typeof (request as any).header === 'function'
    ? (request as any).header("X-Internal-Key")
    : (request as Request).headers.get("X-Internal-Key");

  if (!internalKey) {
    return false;
  }

  try {
    const internalApiKeyBinding = env.INTERNAL_API_KEY;
    if (!internalApiKeyBinding) {
      structuredLog('WARN', 'INTERNAL_API_KEY binding not configured, denying internal request', { endpoint: 'internal-auth', step: 'auth_check' });
      return false;
    }
    const expectedKey = await getSecret(internalApiKeyBinding);
    if (!expectedKey) {
      return false;
    }
    // Constant-time comparison via HMAC
    const encoder = new TextEncoder();
    const a = encoder.encode(internalKey);
    const b = encoder.encode(expectedKey);
    if (a.byteLength !== b.byteLength) return false;
    const keyA = await crypto.subtle.importKey('raw', a, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigA = await crypto.subtle.sign('HMAC', keyA, b);
    const keyB = await crypto.subtle.importKey('raw', b, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigB = await crypto.subtle.sign('HMAC', keyB, a);
    const sigArrayA = new Uint8Array(sigA);
    const sigArrayB = new Uint8Array(sigB);
    let result = 0;
    for (let i = 0; i < sigArrayA.length; i++) {
      result |= sigArrayA[i] ^ sigArrayB[i];
    }
    return result === 0;
  } catch (e) {
    structuredLog('ERROR', 'Internal auth verification failed', { endpoint: 'internal-auth', step: 'auth_check', error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
