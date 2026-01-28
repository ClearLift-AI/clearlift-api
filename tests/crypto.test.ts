/**
 * Comprehensive tests for field-level encryption
 *
 * Tests cover:
 * - Key generation
 * - Encryption/decryption roundtrip
 * - Search hash generation
 * - Error handling
 * - Security properties
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FieldEncryption, generateEncryptionKey } from '../src/utils/crypto';

describe('FieldEncryption - Key Generation', () => {
  it('should generate a valid 256-bit master key', async () => {
    const key = await generateEncryptionKey();

    // Base64 encoding of 32 bytes = 44 characters (with padding)
    expect(key).toHaveLength(44);
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/); // Valid base64
  });

  it('should generate different keys each time', async () => {
    const key1 = await generateEncryptionKey();
    const key2 = await generateEncryptionKey();

    expect(key1).not.toBe(key2);
  });
});

describe('FieldEncryption - Initialization', () => {
  let testKey: string;

  beforeAll(async () => {
    testKey = await generateEncryptionKey();
  });

  it('should create encryption instance from valid key', async () => {
    const crypto = await FieldEncryption.create(testKey);
    expect(crypto).toBeInstanceOf(FieldEncryption);
  });

  it('should reject empty key', async () => {
    await expect(FieldEncryption.create('')).rejects.toThrow();
  });

  it('should reject invalid base64 key', async () => {
    await expect(FieldEncryption.create('not-valid-base64!!!')).rejects.toThrow();
  });

  it('should reject key of wrong length', async () => {
    // 16 bytes instead of 32
    const shortKey = btoa('0123456789012345');
    await expect(FieldEncryption.create(shortKey)).rejects.toThrow('32 bytes');
  });
});

describe('FieldEncryption - Encrypt/Decrypt', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should encrypt and decrypt a simple string', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt empty string', async () => {
    await expect(crypto.encrypt('')).rejects.toThrow('Cannot encrypt empty value');
  });

  it('should encrypt and decrypt special characters', async () => {
    const plaintext = '👋 Hello! 你好 مرحبا';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt long text', async () => {
    const plaintext = 'A'.repeat(10000);
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt JSON data', async () => {
    const data = {
      oauth: {
        access_token: 'ya29.a0AfH6SMBvQ...',
        refresh_token: '1//0gX7BwD...',
        expires_at: '2025-10-10T12:00:00Z'
      },
      settings: {
        sync_enabled: true,
        lookback_days: 30
      }
    };

    const plaintext = JSON.stringify(data);
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);
    const parsed = JSON.parse(decrypted);

    expect(parsed).toEqual(data);
  });

  it('should produce different ciphertexts for same plaintext (random IV)', async () => {
    const plaintext = 'test@example.com';

    const encrypted1 = await crypto.encrypt(plaintext);
    const encrypted2 = await crypto.encrypt(plaintext);

    // Different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to same value
    expect(await crypto.decrypt(encrypted1)).toBe(plaintext);
    expect(await crypto.decrypt(encrypted2)).toBe(plaintext);
  });

  it('should produce valid base64 output', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);

    // Valid base64
    expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // Can decode
    const decoded = atob(encrypted);
    expect(decoded.length).toBeGreaterThan(12); // IV (12) + ciphertext + tag
  });

  it('should fail to decrypt invalid ciphertext', async () => {
    const invalidCiphertext = btoa('invalid-data');
    await expect(crypto.decrypt(invalidCiphertext)).rejects.toThrow();
  });

  it('should fail to decrypt tampered ciphertext (integrity check)', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);

    // Tamper with ciphertext
    const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xFF; // Flip bits in auth tag
    const tampered = btoa(String.fromCharCode(...bytes));

    // Should fail authentication
    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it('should fail to decrypt with wrong key', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);

    // Create different crypto instance with different key
    const key2 = await generateEncryptionKey();
    const crypto2 = await FieldEncryption.create(key2);

    // Should fail to decrypt
    await expect(crypto2.decrypt(encrypted)).rejects.toThrow();
  });
});

describe('FieldEncryption - Search Hash', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should generate deterministic hash for same input', async () => {
    const plaintext = 'test@example.com';

    const hash1 = await crypto.searchHash(plaintext);
    const hash2 = await crypto.searchHash(plaintext);

    expect(hash1).toBe(hash2);
  });

  it('should generate 32-character hex hash', async () => {
    const plaintext = 'test@example.com';
    const hash = await crypto.searchHash(plaintext);

    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should be case-insensitive', async () => {
    const hash1 = await crypto.searchHash('test@example.com');
    const hash2 = await crypto.searchHash('TEST@EXAMPLE.COM');
    const hash3 = await crypto.searchHash('Test@Example.Com');

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
  });

  it('should trim whitespace', async () => {
    const hash1 = await crypto.searchHash('test@example.com');
    const hash2 = await crypto.searchHash('  test@example.com  ');

    expect(hash1).toBe(hash2);
  });

  it('should generate different hashes for different inputs', async () => {
    const hash1 = await crypto.searchHash('test@example.com');
    const hash2 = await crypto.searchHash('other@example.com');

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', async () => {
    const hash = await crypto.searchHash('');
    expect(hash).toBe('');
  });

  it('should handle special characters', async () => {
    const hash1 = await crypto.searchHash('user+tag@example.com');
    const hash2 = await crypto.searchHash('user.name@example.com');

    expect(hash1).not.toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{32}$/);
    expect(hash2).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('FieldEncryption - encryptWithHash', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should return both encrypted value and hash', async () => {
    const plaintext = 'test@example.com';
    const result = await crypto.encryptWithHash(plaintext);

    expect(result).toHaveProperty('encrypted');
    expect(result).toHaveProperty('hash');
    expect(result.encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should produce decryptable encrypted value', async () => {
    const plaintext = 'test@example.com';
    const { encrypted } = await crypto.encryptWithHash(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should produce searchable hash', async () => {
    const plaintext = 'test@example.com';
    const { hash } = await crypto.encryptWithHash(plaintext);
    const expectedHash = await crypto.searchHash(plaintext);

    expect(hash).toBe(expectedHash);
  });
});

describe('FieldEncryption - Performance', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should encrypt 100 emails in under 100ms', async () => {
    const emails = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`);

    const start = Date.now();
    await Promise.all(emails.map(email => crypto.encrypt(email)));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it('should decrypt 100 values in under 100ms', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await Promise.all(
      Array.from({ length: 100 }, () => crypto.encrypt(plaintext))
    );

    const start = Date.now();
    await Promise.all(encrypted.map(cipher => crypto.decrypt(cipher)));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it('should generate 1000 hashes in under 50ms', async () => {
    const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`);

    const start = Date.now();
    await Promise.all(emails.map(email => crypto.searchHash(email)));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});

describe('FieldEncryption - Security Properties', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should not leak plaintext in encrypted output', async () => {
    const plaintext = 'secretpassword123';
    const encrypted = await crypto.encrypt(plaintext);

    // Encrypted should not contain plaintext substring
    expect(encrypted.toLowerCase()).not.toContain(plaintext.toLowerCase());
  });

  it('should use different IVs for each encryption', async () => {
    const plaintext = 'test';
    const encrypted1 = await crypto.encrypt(plaintext);
    const encrypted2 = await crypto.encrypt(plaintext);

    // Extract IVs (first 12 bytes)
    const bytes1 = Uint8Array.from(atob(encrypted1), c => c.charCodeAt(0));
    const bytes2 = Uint8Array.from(atob(encrypted2), c => c.charCodeAt(0));

    const iv1 = bytes1.slice(0, 12);
    const iv2 = bytes2.slice(0, 12);

    // IVs should be different
    expect(Array.from(iv1)).not.toEqual(Array.from(iv2));
  });

  it('should detect modification of IV', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);

    // Modify IV (first 12 bytes)
    const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    bytes[0] ^= 0xFF; // Flip bits
    const tampered = btoa(String.fromCharCode(...bytes));

    // Should fail to decrypt
    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it('should detect modification of ciphertext', async () => {
    const plaintext = 'test@example.com';
    const encrypted = await crypto.encrypt(plaintext);

    // Modify ciphertext (middle bytes)
    const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const midpoint = Math.floor(bytes.length / 2);
    bytes[midpoint] ^= 0xFF;
    const tampered = btoa(String.fromCharCode(...bytes));

    // Should fail authentication
    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it('should have sufficient entropy in encrypted output', async () => {
    const plaintext = 'a'.repeat(100); // Low entropy input

    const encrypted = await crypto.encrypt(plaintext);
    const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

    // Count unique bytes (should be high for encrypted data)
    const uniqueBytes = new Set(bytes).size;

    // Expect at least 50% unique bytes (randomness from IV + encryption)
    expect(uniqueBytes).toBeGreaterThan(bytes.length * 0.5);
  });
});

describe('FieldEncryption - Edge Cases', () => {
  let crypto: FieldEncryption;

  beforeAll(async () => {
    const key = await generateEncryptionKey();
    crypto = await FieldEncryption.create(key);
  });

  it('should handle single character', async () => {
    const plaintext = 'a';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should handle null bytes', async () => {
    const plaintext = 'test\x00null\x00bytes';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should handle maximum UTF-8 characters', async () => {
    const plaintext = '\u{10FFFF}'; // Max Unicode codepoint
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should handle newlines and tabs', async () => {
    const plaintext = 'line1\nline2\tindented';
    const encrypted = await crypto.encrypt(plaintext);
    const decrypted = await crypto.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should reject decryption of too-short ciphertext', async () => {
    const shortCiphertext = btoa('short');
    await expect(crypto.decrypt(shortCiphertext)).rejects.toThrow('Invalid ciphertext format');
  });
});
