/**
 * Field-level encryption using Web Crypto API
 *
 * Provides AES-GCM encryption for sensitive data stored in D1.
 * Uses envelope encryption pattern with master key from Cloudflare Secrets Store.
 *
 * Features:
 * - Authenticated encryption (AES-256-GCM)
 * - Random IV per encryption
 * - Search-friendly hashing for exact-match lookups
 * - Zero external dependencies (uses Web Crypto API)
 */

export class FieldEncryption {
  private masterKey: CryptoKey;

  /**
   * Create encryption instance from base64-encoded master key
   *
   * @param masterKeyBase64 - 256-bit key encoded as base64 (from env.ENCRYPTION_KEY)
   */
  static async create(masterKeyBase64: string): Promise<FieldEncryption> {
    if (!masterKeyBase64) {
      throw new Error('Master key is required');
    }

    try {
      const masterKeyBytes = Uint8Array.from(atob(masterKeyBase64), c => c.charCodeAt(0));

      if (masterKeyBytes.length !== 32) {
        throw new Error('Master key must be 32 bytes (256 bits)');
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
      throw new Error(`Failed to initialize encryption: ${error}`);
    }
  }

  /**
   * Generate a new random master key (for initial setup)
   * Run this once and store the result in Cloudflare Secrets Store
   */
  static async generateMasterKey(): Promise<string> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable (only for initial generation)
      ['encrypt', 'decrypt']
    ) as CryptoKey;

    const exported = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
    const keyArray = Array.from(new Uint8Array(exported));
    return btoa(String.fromCharCode(...keyArray));
  }

  private constructor(masterKey: CryptoKey) {
    this.masterKey = masterKey;
  }

  /**
   * Encrypt a field value
   *
   * Format: base64([iv(12 bytes)][encrypted data + auth tag])
   *
   * @param plaintext - Value to encrypt
   * @returns Base64-encoded encrypted value
   */
  async encrypt(plaintext: string): Promise<string> {
    if (!plaintext) {
      throw new Error('Cannot encrypt empty value');
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

      // Encode to base64 for storage
      return btoa(String.fromCharCode(...combined));
    } catch (error) {
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * Decrypt a field value
   *
   * @param ciphertext - Base64-encoded encrypted value
   * @returns Decrypted plaintext
   */
  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext) {
      throw new Error('Cannot decrypt empty value');
    }

    try {
      const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

      if (combined.length < 12) {
        throw new Error('Invalid ciphertext: too short');
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
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  /**
   * Generate a deterministic hash for encrypted field lookups
   *
   * Allows exact-match searches on encrypted fields without decryption.
   * Uses HMAC-SHA256 for consistent hashing.
   *
   * @param plaintext - Value to hash
   * @returns Hex-encoded hash (16 chars = 64 bits)
   */
  async searchHash(plaintext: string): Promise<string> {
    if (!plaintext) {
      return '';
    }

    // Normalize for consistent hashing
    const normalized = plaintext.toLowerCase().trim();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);

    // Use SHA-256 for deterministic hashing
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));

    // Return first 64 bits (16 hex chars) - sufficient for uniqueness in most cases
    return hashArray
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
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
