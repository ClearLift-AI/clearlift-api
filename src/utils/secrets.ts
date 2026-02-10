/**
 * Utility functions for accessing Secrets Store bindings
 */

import type { AppContext } from "../types";
import { structuredLog } from './structured-logger';

/**
 * Helper to get a secret value from either Secrets Store binding or plain string
 * Handles both async bindings and regular environment variables
 */
export async function getSecret(
  value: any | undefined,
  defaultValue?: string
): Promise<string | undefined> {
  if (!value) return defaultValue;

  // If it's a Secrets Store binding with .get() method
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      return await value.get();
    } catch (error) {
      structuredLog('ERROR', 'Failed to get secret from Secrets Store', { service: 'secrets', error: error instanceof Error ? error.message : String(error) });
      return defaultValue;
    }
  }

  // If it's a plain string (for local dev or regular env vars)
  if (typeof value === 'string') {
    return value;
  }

  return defaultValue;
}

/**
 * Get multiple secrets at once for better performance
 */
export async function getSecrets(
  env: any,
  keys: string[]
): Promise<Record<string, string | undefined>> {
  const results: Record<string, string | undefined> = {};

  await Promise.all(
    keys.map(async (key) => {
      results[key] = await getSecret(env[key]);
    })
  );

  return results;
}

/**
 * Validate that required secrets are present
 */
export async function validateRequiredSecrets(
  env: any,
  requiredKeys: string[]
): Promise<{ valid: boolean; missing: string[] }> {
  const missing: string[] = [];

  for (const key of requiredKeys) {
    const value = await getSecret(env[key]);
    if (!value) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}