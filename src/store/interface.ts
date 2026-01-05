/**
 * Gmail credentials stored for each MCP user.
 */
export interface GmailCredentials {
  /** MCP user ID (from JWT sub claim) */
  mcpUserId: string;
  /** Google user ID */
  googleUserId: string;
  /** Gmail email address */
  email: string;
  /** Current access token */
  accessToken: string;
  /** Encrypted refresh token */
  refreshToken: string;
  /** Access token expiry timestamp (ms since epoch) */
  expiryDate: number;
  /** Granted OAuth scopes (space-separated) */
  scope: string;
  /** When credentials were first created */
  createdAt: Date;
  /** When credentials were last updated */
  updatedAt: Date;
}

/**
 * OAuth state for CSRF protection during Google OAuth flow.
 */
export interface OAuthState {
  /** Random state token */
  state: string;
  /** MCP user ID this state is bound to */
  mcpUserId: string;
  /** When the state expires */
  expiresAt: Date;
  /** Requested scopes for this authorization */
  scopes: string[];
  /** PKCE code verifier */
  codeVerifier: string;
}

/**
 * Interface for token storage implementations.
 * Supports SQLite (default) and can be extended to Postgres, etc.
 */
export interface TokenStore {
  /**
   * Initialize the store (create tables, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Get Gmail credentials for an MCP user.
   */
  getCredentials(mcpUserId: string): Promise<GmailCredentials | null>;

  /**
   * Save or update Gmail credentials for an MCP user.
   */
  saveCredentials(credentials: Omit<GmailCredentials, 'createdAt' | 'updatedAt'>): Promise<void>;

  /**
   * Delete Gmail credentials for an MCP user.
   */
  deleteCredentials(mcpUserId: string): Promise<void>;

  /**
   * Update only the access token and expiry date.
   * Used after token refresh.
   */
  updateAccessToken(mcpUserId: string, accessToken: string, expiryDate: number, refreshToken?: string): Promise<void>;

  /**
   * Save OAuth state for CSRF protection.
   */
  saveOAuthState(state: OAuthState): Promise<void>;

  /**
   * Get and delete OAuth state (one-time use).
   * Returns null if state doesn't exist or is expired.
   */
  consumeOAuthState(state: string): Promise<OAuthState | null>;

  /**
   * Clean up expired OAuth states.
   */
  cleanupExpiredStates(): Promise<void>;

  /**
   * Close the store connection.
   */
  close(): Promise<void>;
}
