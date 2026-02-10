/**
 * Authentication utility functions
 */

import { structuredLog } from './structured-logger';

/**
 * Hash a password using Web Crypto API
 */
export async function hashPassword(password: string): Promise<string> {
  // Generate a salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Convert password to Uint8Array
  const encoder = new TextEncoder();
  const passwordData = encoder.encode(password);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordData,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // Derive bits using PBKDF2
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  // Convert to base64 for storage
  const hashArray = new Uint8Array(hashBuffer);
  const saltAndHash = new Uint8Array(salt.length + hashArray.length);
  saltAndHash.set(salt, 0);
  saltAndHash.set(hashArray, salt.length);

  return btoa(String.fromCharCode(...saltAndHash));
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    // Decode from base64
    const saltAndHash = Uint8Array.from(atob(hash), c => c.charCodeAt(0));

    // Extract salt (first 16 bytes)
    const salt = saltAndHash.slice(0, 16);
    const storedHash = saltAndHash.slice(16);

    // Hash the provided password with the same salt
    const encoder = new TextEncoder();
    const passwordData = encoder.encode(password);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData,
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    const hashBuffer = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );

    const hashArray = new Uint8Array(hashBuffer);

    // Constant-time comparison to prevent timing attacks
    const computedBuffer = new Uint8Array(hashArray).buffer;
    const storedBuffer = new Uint8Array(storedHash).buffer;
    if (computedBuffer.byteLength !== storedBuffer.byteLength) return false;

    const { timingSafeEqual } = await import('node:crypto');
    return timingSafeEqual(Buffer.from(computedBuffer), Buffer.from(storedBuffer));
  } catch (error) {
    structuredLog('ERROR', 'Password verification error', { service: 'auth-utils', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Generate a secure session token
 */
export function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate a short invite code
 */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing characters
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}