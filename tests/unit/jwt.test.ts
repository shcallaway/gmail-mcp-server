import { describe, it, expect } from 'vitest';
import {
  generateUserId,
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  validateToken,
  extractBearerToken,
} from '../../src/auth/jwt.js';

describe('JWT utilities', () => {
  const testSecret = 'test-secret-key-that-is-at-least-32-chars';
  const testIssuer = 'http://localhost:3000';
  const testScope = 'mcp:tools';

  describe('generateUserId', () => {
    it('should generate a 32-character hex string', () => {
      const userId = generateUserId();
      expect(userId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUserId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('generateAccessToken', () => {
    it('should generate a valid JWT', () => {
      const userId = generateUserId();
      const token = generateAccessToken(userId, testIssuer, testScope, testSecret);

      expect(token).toBeTruthy();
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should be valid when verified', () => {
      const userId = generateUserId();
      const token = generateAccessToken(userId, testIssuer, testScope, testSecret);

      const result = validateToken(token, testSecret, testIssuer, 'access');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.sub).toBe(userId);
        expect(result.payload.type).toBe('access');
        expect(result.payload.scope).toBe(testScope);
      }
    });
  });

  describe('generateRefreshToken', () => {
    it('should generate a refresh token', () => {
      const userId = generateUserId();
      const token = generateRefreshToken(userId, testIssuer, testScope, testSecret);

      const result = validateToken(token, testSecret, testIssuer, 'refresh');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.type).toBe('refresh');
      }
    });
  });

  describe('generateTokenPair', () => {
    it('should generate both access and refresh tokens', () => {
      const userId = generateUserId();
      const pair = generateTokenPair(userId, testIssuer, testScope, testSecret);

      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();
      expect(pair.tokenType).toBe('Bearer');
      expect(pair.expiresIn).toBe(3600);
      expect(pair.scope).toBe(testScope);
    });

    it('should produce different tokens', () => {
      const userId = generateUserId();
      const pair = generateTokenPair(userId, testIssuer, testScope, testSecret);

      expect(pair.accessToken).not.toBe(pair.refreshToken);
    });
  });

  describe('validateToken', () => {
    it('should reject token with wrong secret', () => {
      const userId = generateUserId();
      const token = generateAccessToken(userId, testIssuer, testScope, testSecret);

      const result = validateToken(token, 'wrong-secret-that-is-32-chars!!', testIssuer, 'access');
      expect(result.valid).toBe(false);
    });

    it('should reject token with wrong issuer', () => {
      const userId = generateUserId();
      const token = generateAccessToken(userId, testIssuer, testScope, testSecret);

      const result = validateToken(token, testSecret, 'http://wrong-issuer.com', 'access');
      expect(result.valid).toBe(false);
    });

    it('should reject access token when refresh expected', () => {
      const userId = generateUserId();
      const token = generateAccessToken(userId, testIssuer, testScope, testSecret);

      const result = validateToken(token, testSecret, testIssuer, 'refresh');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Expected refresh token');
      }
    });

    it('should reject malformed token', () => {
      const result = validateToken('not.a.valid.token', testSecret, testIssuer, 'access');
      expect(result.valid).toBe(false);
    });

    it('should reject empty token', () => {
      const result = validateToken('', testSecret, testIssuer, 'access');
      expect(result.valid).toBe(false);
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid header', () => {
      const token = extractBearerToken('Bearer abc123');
      expect(token).toBe('abc123');
    });

    it('should handle case-insensitive Bearer', () => {
      const token = extractBearerToken('bearer abc123');
      expect(token).toBe('abc123');
    });

    it('should return null for missing header', () => {
      expect(extractBearerToken(undefined)).toBeNull();
    });

    it('should return null for non-Bearer auth', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull();
    });

    it('should return null for malformed header', () => {
      expect(extractBearerToken('Bearer')).toBeNull();
      expect(extractBearerToken('Bearertoken')).toBeNull();
    });
  });
});
