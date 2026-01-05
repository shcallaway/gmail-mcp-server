import Database from 'better-sqlite3';
import type { TokenStore, GmailCredentials, OAuthState } from './interface.js';

export class SqliteTokenStore implements TokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  async initialize(): Promise<void> {
    // Create credentials table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_credentials (
        mcp_user_id TEXT PRIMARY KEY,
        google_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expiry_date INTEGER NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create OAuth state table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        mcp_user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_verifier TEXT NOT NULL
      )
    `);

    // Create index for cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
      ON oauth_states(expires_at)
    `);
  }

  async getCredentials(mcpUserId: string): Promise<GmailCredentials | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM gmail_credentials WHERE mcp_user_id = ?
    `);

    const row = stmt.get(mcpUserId) as {
      mcp_user_id: string;
      google_user_id: string;
      email: string;
      access_token: string;
      refresh_token: string;
      expiry_date: number;
      scope: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      mcpUserId: row.mcp_user_id,
      googleUserId: row.google_user_id,
      email: row.email,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiryDate: row.expiry_date,
      scope: row.scope,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async saveCredentials(credentials: Omit<GmailCredentials, 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO gmail_credentials
        (mcp_user_id, google_user_id, email, access_token, refresh_token, expiry_date, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mcp_user_id) DO UPDATE SET
        google_user_id = excluded.google_user_id,
        email = excluded.email,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expiry_date = excluded.expiry_date,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      credentials.mcpUserId,
      credentials.googleUserId,
      credentials.email,
      credentials.accessToken,
      credentials.refreshToken,
      credentials.expiryDate,
      credentials.scope,
      now,
      now
    );
  }

  async deleteCredentials(mcpUserId: string): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM gmail_credentials WHERE mcp_user_id = ?
    `);
    stmt.run(mcpUserId);
  }

  async updateAccessToken(
    mcpUserId: string,
    accessToken: string,
    expiryDate: number,
    refreshToken?: string
  ): Promise<void> {
    const now = new Date().toISOString();

    if (refreshToken) {
      const stmt = this.db.prepare(`
        UPDATE gmail_credentials
        SET access_token = ?, expiry_date = ?, refresh_token = ?, updated_at = ?
        WHERE mcp_user_id = ?
      `);
      stmt.run(accessToken, expiryDate, refreshToken, now, mcpUserId);
    } else {
      const stmt = this.db.prepare(`
        UPDATE gmail_credentials
        SET access_token = ?, expiry_date = ?, updated_at = ?
        WHERE mcp_user_id = ?
      `);
      stmt.run(accessToken, expiryDate, now, mcpUserId);
    }
  }

  async saveOAuthState(state: OAuthState): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO oauth_states (state, mcp_user_id, expires_at, scopes, code_verifier)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      state.state,
      state.mcpUserId,
      state.expiresAt.toISOString(),
      JSON.stringify(state.scopes),
      state.codeVerifier
    );
  }

  async consumeOAuthState(state: string): Promise<OAuthState | null> {
    const now = new Date().toISOString();

    // Get and delete in a transaction
    const result = this.db.transaction(() => {
      const selectStmt = this.db.prepare(`
        SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?
      `);

      const row = selectStmt.get(state, now) as {
        state: string;
        mcp_user_id: string;
        expires_at: string;
        scopes: string;
        code_verifier: string;
      } | undefined;

      if (!row) {
        return null;
      }

      // Delete the state (one-time use)
      const deleteStmt = this.db.prepare(`
        DELETE FROM oauth_states WHERE state = ?
      `);
      deleteStmt.run(state);

      return {
        state: row.state,
        mcpUserId: row.mcp_user_id,
        expiresAt: new Date(row.expires_at),
        scopes: JSON.parse(row.scopes) as string[],
        codeVerifier: row.code_verifier,
      };
    })();

    return result;
  }

  async cleanupExpiredStates(): Promise<void> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      DELETE FROM oauth_states WHERE expires_at <= ?
    `);
    stmt.run(now);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
