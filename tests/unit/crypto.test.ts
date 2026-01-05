import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateSecureState, generateEncryptionKey } from '../../src/utils/crypto.js';

describe('crypto utilities', () => {
  const testKey = generateEncryptionKey();

  describe('encrypt/decrypt', () => {
    it('should round-trip plaintext correctly', () => {
      const plaintext = 'test-refresh-token-12345';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const plaintext = 'same-text';
      const encrypted1 = encrypt(plaintext, testKey);
      const encrypted2 = encrypt(plaintext, testKey);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should fail with wrong key', () => {
      const plaintext = 'secret-data';
      const encrypted = encrypt(plaintext, testKey);
      const wrongKey = generateEncryptionKey();

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('should handle empty string', () => {
      const plaintext = '';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = 'Hello 世界 🌍 مرحبا';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('generateSecureState', () => {
    it('should generate base64url string of correct length', () => {
      const state = generateSecureState();
      // 32 bytes = 43 base64url characters (without padding)
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('should generate unique values', () => {
      const states = new Set<string>();
      for (let i = 0; i < 100; i++) {
        states.add(generateSecureState());
      }
      expect(states.size).toBe(100);
    });
  });

  describe('generateEncryptionKey', () => {
    it('should generate 64 hex characters (32 bytes)', () => {
      const key = generateEncryptionKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateEncryptionKey());
      }
      expect(keys.size).toBe(100);
    });
  });
});
