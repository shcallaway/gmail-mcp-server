/**
 * Google OAuth implementation for Gmail authorization.
 *
 * This module handles:
 * - Google OAuth2 client setup
 * - /oauth/start endpoint (generate state, redirect to Google)
 * - /oauth/callback endpoint (exchange code, store credentials)
 * - Scope validation and mapping
 */

import { google } from 'googleapis';
import { CodeChallengeMethod } from 'google-auth-library';
import { randomBytes, createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { TokenStore } from '../store/interface.js';
import { encrypt } from '../utils/crypto.js';

// Scope mapping from friendly names to Google OAuth scopes
export const GMAIL_SCOPES = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.labels': 'https://www.googleapis.com/auth/gmail.labels',
} as const;

export type GmailScope = keyof typeof GMAIL_SCOPES;

const VALID_SCOPES = new Set<string>(Object.keys(GMAIL_SCOPES));

export interface GoogleOAuthDependencies {
  config: Config;
  tokenStore: TokenStore;
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate 32 bytes of random data for code verifier
  const codeVerifier = randomBytes(32).toString('base64url');

  // Generate code challenge using SHA256
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

/**
 * Create Google OAuth handlers.
 */
export function createGoogleOAuth(deps: GoogleOAuthDependencies) {
  const { config, tokenStore } = deps;

  // Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.oauthRedirectUri
  );

  /**
   * Validate and map scopes from friendly names to Google OAuth scopes.
   */
  function mapScopes(scopes: string[]): string[] {
    const googleScopes: string[] = [];

    for (const scope of scopes) {
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(`Invalid scope: ${scope}. Valid scopes are: ${Array.from(VALID_SCOPES).join(', ')}`);
      }
      googleScopes.push(GMAIL_SCOPES[scope as GmailScope]);
    }

    return googleScopes;
  }

  /**
   * Handler for GET /oauth/start - initiates Google OAuth flow.
   */
  async function startHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query as {
      scopes?: string;
      mcp_user_id?: string;
    };

    // Parse requested scopes (comma-separated)
    const requestedScopes = query.scopes
      ? query.scopes.split(',').map(s => s.trim())
      : ['gmail.readonly'];

    // Validate scopes
    let googleScopes: string[];
    try {
      googleScopes = mapScopes(requestedScopes);
    } catch (error) {
      reply.status(400).send({
        error: 'invalid_scope',
        error_description: (error as Error).message,
      });
      return;
    }

    // Get MCP user ID from query or generate placeholder
    const mcpUserId = query.mcp_user_id ?? 'anonymous';

    // Generate state token (256-bit random)
    const state = randomBytes(32).toString('base64url');

    // Generate PKCE
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Store state for validation in callback
    await tokenStore.saveOAuthState({
      state,
      mcpUserId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      scopes: requestedScopes,
      codeVerifier,
    });

    // Generate Google authorization URL
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: googleScopes,
      state,
      prompt: 'consent', // Force consent to ensure refresh token
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    // Redirect to Google
    reply.redirect(authUrl);
  }

  /**
   * Handler for GET /oauth/callback - handles Google OAuth callback.
   */
  async function callbackHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    // Check for OAuth error
    if (query.error) {
      reply.status(400).send({
        error: query.error,
        error_description: query.error_description ?? 'OAuth authorization failed',
      });
      return;
    }

    // Validate required parameters
    if (!query.code || !query.state) {
      reply.status(400).send({
        error: 'invalid_request',
        error_description: 'Missing code or state parameter',
      });
      return;
    }

    // Validate and consume state (one-time use)
    const storedState = await tokenStore.consumeOAuthState(query.state);
    if (!storedState) {
      reply.status(400).send({
        error: 'invalid_state',
        error_description: 'Invalid or expired state parameter',
      });
      return;
    }

    try {
      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken({
        code: query.code,
        codeVerifier: storedState.codeVerifier,
      });

      if (!tokens.access_token || !tokens.refresh_token) {
        reply.status(500).send({
          error: 'token_error',
          error_description: 'Failed to obtain tokens from Google',
        });
        return;
      }

      // Set credentials to fetch user profile
      oauth2Client.setCredentials(tokens);

      // Get user profile from Gmail API
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: 'me' });

      if (!profile.data.emailAddress) {
        reply.status(500).send({
          error: 'profile_error',
          error_description: 'Failed to get email address from Gmail',
        });
        return;
      }

      // Encrypt refresh token before storage
      const encryptedRefreshToken = encrypt(tokens.refresh_token, config.tokenEncryptionKey);

      // Store credentials
      await tokenStore.saveCredentials({
        mcpUserId: storedState.mcpUserId,
        googleUserId: profile.data.emailAddress, // Using email as ID since historyId is not unique
        email: profile.data.emailAddress,
        accessToken: tokens.access_token,
        refreshToken: encryptedRefreshToken,
        expiryDate: tokens.expiry_date ?? Date.now() + 3600000,
        scope: storedState.scopes.map(s => GMAIL_SCOPES[s as GmailScope]).join(' '),
      });

      // Send success page
      reply.type('text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Gmail Connected</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 40px;
              background: white;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 { color: #1a73e8; margin-bottom: 10px; }
            p { color: #5f6368; }
            .email { font-weight: bold; color: #202124; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Gmail Connected</h1>
            <p>Successfully connected as <span class="email">${profile.data.emailAddress}</span></p>
            <p>You can now close this window and return to your application.</p>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      console.error('OAuth callback error:', error);
      reply.status(500).send({
        error: 'exchange_error',
        error_description: 'Failed to exchange authorization code for tokens',
      });
    }
  }

  return {
    oauth2Client,
    startHandler,
    callbackHandler,
    mapScopes,
  };
}

export type GoogleOAuth = ReturnType<typeof createGoogleOAuth>;
