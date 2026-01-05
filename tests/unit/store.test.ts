import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteTokenStore } from '../../src/store/sqlite.js';
import { unlinkSync, existsSync } from 'node:fs';

describe('SqliteTokenStore', () => {
  const testDbPath = './test-tokens.db';
  let store: SqliteTokenStore;

  beforeEach(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    store = new SqliteTokenStore(testDbPath);
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Also clean up WAL files
    if (existsSync(testDbPath + '-wal')) {
      unlinkSync(testDbPath + '-wal');
    }
    if (existsSync(testDbPath + '-shm')) {
      unlinkSync(testDbPath + '-shm');
    }
  });

  describe('credentials', () => {
    const testCredentials = {
      mcpUserId: 'user-123',
      googleUserId: 'google-456',
      email: 'test@example.com',
      accessToken: 'access-token-xyz',
      refreshToken: 'encrypted-refresh-token',
      expiryDate: Date.now() + 3600000,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    };

    it('should save and retrieve credentials', async () => {
      await store.saveCredentials(testCredentials);
      const retrieved = await store.getCredentials(testCredentials.mcpUserId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.mcpUserId).toBe(testCredentials.mcpUserId);
      expect(retrieved?.email).toBe(testCredentials.email);
      expect(retrieved?.accessToken).toBe(testCredentials.accessToken);
      expect(retrieved?.refreshToken).toBe(testCredentials.refreshToken);
    });

    it('should return null for non-existent user', async () => {
      const result = await store.getCredentials('non-existent');
      expect(result).toBeNull();
    });

    it('should update existing credentials', async () => {
      await store.saveCredentials(testCredentials);

      const updatedCredentials = {
        ...testCredentials,
        accessToken: 'new-access-token',
        email: 'updated@example.com',
      };
      await store.saveCredentials(updatedCredentials);

      const retrieved = await store.getCredentials(testCredentials.mcpUserId);
      expect(retrieved?.accessToken).toBe('new-access-token');
      expect(retrieved?.email).toBe('updated@example.com');
    });

    it('should delete credentials', async () => {
      await store.saveCredentials(testCredentials);
      await store.deleteCredentials(testCredentials.mcpUserId);

      const result = await store.getCredentials(testCredentials.mcpUserId);
      expect(result).toBeNull();
    });

    it('should update access token only', async () => {
      await store.saveCredentials(testCredentials);

      const newAccessToken = 'refreshed-token';
      const newExpiry = Date.now() + 7200000;
      await store.updateAccessToken(testCredentials.mcpUserId, newAccessToken, newExpiry);

      const retrieved = await store.getCredentials(testCredentials.mcpUserId);
      expect(retrieved?.accessToken).toBe(newAccessToken);
      expect(retrieved?.expiryDate).toBe(newExpiry);
      expect(retrieved?.refreshToken).toBe(testCredentials.refreshToken);
    });

    it('should update access token and refresh token', async () => {
      await store.saveCredentials(testCredentials);

      const newAccessToken = 'new-access';
      const newRefreshToken = 'rotated-refresh';
      const newExpiry = Date.now() + 7200000;
      await store.updateAccessToken(testCredentials.mcpUserId, newAccessToken, newExpiry, newRefreshToken);

      const retrieved = await store.getCredentials(testCredentials.mcpUserId);
      expect(retrieved?.accessToken).toBe(newAccessToken);
      expect(retrieved?.refreshToken).toBe(newRefreshToken);
    });
  });

  describe('OAuth state', () => {
    const testState = {
      state: 'random-state-token-abc',
      mcpUserId: 'user-123',
      expiresAt: new Date(Date.now() + 600000), // 10 minutes
      scopes: ['gmail.readonly'],
      codeVerifier: 'pkce-code-verifier-xyz',
    };

    it('should save and consume state (one-time use)', async () => {
      await store.saveOAuthState(testState);

      const consumed = await store.consumeOAuthState(testState.state);
      expect(consumed).not.toBeNull();
      expect(consumed?.mcpUserId).toBe(testState.mcpUserId);
      expect(consumed?.scopes).toEqual(testState.scopes);
      expect(consumed?.codeVerifier).toBe(testState.codeVerifier);

      // Should be deleted after consumption
      const secondAttempt = await store.consumeOAuthState(testState.state);
      expect(secondAttempt).toBeNull();
    });

    it('should return null for expired state', async () => {
      const expiredState = {
        ...testState,
        expiresAt: new Date(Date.now() - 1000), // Already expired
      };
      await store.saveOAuthState(expiredState);

      const result = await store.consumeOAuthState(expiredState.state);
      expect(result).toBeNull();
    });

    it('should return null for non-existent state', async () => {
      const result = await store.consumeOAuthState('non-existent-state');
      expect(result).toBeNull();
    });

    it('should clean up expired states', async () => {
      const expiredState = {
        ...testState,
        state: 'expired-state',
        expiresAt: new Date(Date.now() - 1000),
      };
      await store.saveOAuthState(expiredState);
      await store.cleanupExpiredStates();

      // State should be deleted
      const result = await store.consumeOAuthState(expiredState.state);
      expect(result).toBeNull();
    });
  });
});
