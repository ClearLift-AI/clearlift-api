/**
 * Field-level encryption using Web Crypto API
 *
 * Mirror of clearlift-cron/shared/utils/crypto.ts (CANONICAL SOURCE)
 * Keep in sync when making changes.
 *
 * Provides AES-GCM encryption for sensitive data stored in D1.
 * Uses envelope encryption pattern with master key from Cloudflare Secrets Store.
 *
 * @see clearlift-cron/shared/utils/crypto.ts (canonical)
 * @see clearlift-cron/docs/SHARED_CODE.md section 8
 *
 * Features:
 * - Authenticated encryption (AES-256-GCM)
 * - Random IV per encryption
 * - Search-friendly hashing for exact-match lookups (128-bit)
 * - CRYPTO_ERROR: prefixed errors for easy identification
 * - Zero external dependencies (uses Web Crypto API)
 */

export class FieldEncryption {
  private masterKey: CryptoKey;

  /**
   * Create encryption instance from base64-encoded master key
   *
   * @param masterKeyBase64 - 256-bit key encoded as base64 (from env.ENCRYPTION_KEY)
   * @throws Error if key is invalid, malformed, or wrong length
   */
  static async create(masterKeyBase64: string): Promise<FieldEncryption> {
    if (typeof masterKeyBase64 !== 'string') {
      throw new Error('CRYPTO_ERROR: Master key must be a string');
    }

    if (!masterKeyBase64) {
      throw new Error('CRYPTO_ERROR: Master key is required');
    }

    // Validate base64 format
    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    if (!base64Regex.test(masterKeyBase64)) {
      throw new Error('CRYPTO_ERROR: Master key must be valid base64');
    }

    try {
      const masterKeyBytes = Uint8Array.from(atob(masterKeyBase64), c => c.charCodeAt(0));

      if (masterKeyBytes.length !== 32) {
        throw new Error('CRYPTO_ERROR: Master key must be 32 bytes (256 bits)');
      }

      const masterKey = await crypto.subtle.importKey(
        'raw',
        masterKeyBytes,
        { name: 'AES-GCM', length: 256 },
        false, // not extractable
        ['encrypt', 'decrypt']
      );

      return new FieldEncryption(masterKey);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CRYPTO_ERROR:')) {
        throw error;
      }
      throw new Error('CRYPTO_ERROR: Failed to initialize encryption (invalid key format)');
    }
  }

  /**
   * Generate a new random master key (for initial setup)
   * Run this once and store the result in Cloudflare Secrets Store
   *
   * @returns Base64-encoded 256-bit AES key
   */
  static async generateMasterKey(): Promise<string> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable (only for initial generation)
      ['encrypt', 'decrypt']
    ) as CryptoKey;

    const exported = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
    const keyArray = new Uint8Array(exported);

    // Convert to base64 without spread operator
    let binary = '';
    for (let i = 0; i < keyArray.length; i++) {
      binary += String.fromCharCode(keyArray[i]);
    }
    return btoa(binary);
  }

  private constructor(masterKey: CryptoKey) {
    this.masterKey = masterKey;
  }

  /**
   * Encrypt a field value
   *
   * Format: base64([iv(12 bytes)][encrypted data + auth tag])
   *
   * @param plaintext - Value to encrypt (must be non-empty string)
   * @returns Base64-encoded encrypted value
   * @throws Error if plaintext is empty or encryption fails
   */
  async encrypt(plaintext: string): Promise<string> {
    if (typeof plaintext !== 'string') {
      throw new Error('CRYPTO_ERROR: Plaintext must be a string');
    }

    if (!plaintext) {
      throw new Error('CRYPTO_ERROR: Cannot encrypt empty value');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // Generate random 12-byte IV (recommended for GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    try {
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          tagLength: 128 // 16-byte authentication tag
        },
        this.masterKey,
        data
      );

      // Combine IV + ciphertext+tag
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);

      // Encode to base64 for storage (avoid spread operator for TS compatibility)
      let binary = '';
      for (let i = 0; i < combined.length; i++) {
        binary += String.fromCharCode(combined[i]);
      }
      return btoa(binary);
    } catch (error) {
      throw new Error('CRYPTO_ERROR: Encryption operation failed');
    }
  }

  /**
   * Decrypt a field value
   *
   * @param ciphertext - Base64-encoded encrypted value
   * @returns Decrypted plaintext
   * @throws Error if ciphertext is invalid or decryption fails
   */
  async decrypt(ciphertext: string): Promise<string> {
    if (typeof ciphertext !== 'string') {
      throw new Error('CRYPTO_ERROR: Ciphertext must be a string');
    }

    if (!ciphertext) {
      throw new Error('CRYPTO_ERROR: Cannot decrypt empty value');
    }

    // Validate base64 format
    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    if (!base64Regex.test(ciphertext)) {
      throw new Error('CRYPTO_ERROR: Ciphertext must be valid base64');
    }

    try {
      const decoded = atob(ciphertext);
      const combined = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        combined[i] = decoded.charCodeAt(i);
      }

      if (combined.length < 12) {
        throw new Error('CRYPTO_ERROR: Invalid ciphertext format');
      }

      // Extract IV (first 12 bytes) and encrypted data
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          tagLength: 128
        },
        this.masterKey,
        encrypted
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CRYPTO_ERROR:')) {
        throw error;
      }
      throw new Error('CRYPTO_ERROR: Decryption failed (invalid ciphertext or wrong key)');
    }
  }

  /**
   * Generate a deterministic hash for encrypted field lookups
   *
   * Allows exact-match searches on encrypted fields without decryption.
   * Uses SHA-256 for consistent hashing with 128-bit output for collision resistance.
   *
   * Security: 128-bit hash provides 2^64 operations before 50% collision probability,
   * sufficient for billions of records.
   *
   * @param plaintext - Value to hash
   * @returns Hex-encoded hash (32 chars = 128 bits)
   */
  async searchHash(plaintext: string): Promise<string> {
    if (typeof plaintext !== 'string') {
      throw new Error('CRYPTO_ERROR: Plaintext must be a string');
    }

    if (!plaintext) {
      return '';
    }

    // Normalize for consistent hashing
    const normalized = plaintext.toLowerCase().trim();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);

    // Use SHA-256 for deterministic hashing
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);

    // Return first 128 bits (32 hex chars) for collision resistance
    let hexHash = '';
    for (let i = 0; i < 16; i++) {
      hexHash += hashArray[i].toString(16).padStart(2, '0');
    }
    return hexHash;
  }

  /**
   * Encrypt with search hash
   * Returns both encrypted value and search hash for database storage
   *
   * @param plaintext - Value to encrypt
   * @returns Object with encrypted value and search hash
   */
  async encryptWithHash(plaintext: string): Promise<{
    encrypted: string;
    hash: string;
  }> {
    const [encrypted, hash] = await Promise.all([
      this.encrypt(plaintext),
      this.searchHash(plaintext)
    ]);

    return { encrypted, hash };
  }
}

/**
 * Utility: Generate a new master key for initial setup
 *
 * Usage:
 *   const key = await generateEncryptionKey();
 *   console.log(key);
 *   // Store this in Cloudflare Secrets Store as ENCRYPTION_KEY
 */
export async function generateEncryptionKey(): Promise<string> {
  return FieldEncryption.generateMasterKey();
}
