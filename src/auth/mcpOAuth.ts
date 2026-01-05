/**
 * MCP-level OAuth implementation.
 *
 * This module handles:
 * - JWT token generation and validation for MCP authentication
 * - Token endpoint for authorization_code and refresh_token grants
 * - Auth middleware for protecting MCP endpoints
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  generateUserId,
  generateTokenPair,
  validateToken,
  extractBearerToken,
} from './jwt.js';
import type { Config } from '../config.js';

export interface McpAuthContext {
  userId: string;
  scope: string;
}

export interface McpOAuthDependencies {
  config: Config;
}

/**
 * Create MCP OAuth handlers and middleware.
 */
export function createMcpOAuth(deps: McpOAuthDependencies) {
  const { config } = deps;

  /**
   * Middleware to validate MCP authentication.
   * Attaches auth context to request if valid.
   */
  async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<McpAuthContext | null> {
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      reply.status(401).header(
        'WWW-Authenticate',
        `Bearer realm="gmail-mcp", resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`
      );
      reply.send({
        error: 'unauthorized',
        error_description: 'Missing or invalid authorization header',
      });
      return null;
    }

    const result = validateToken(token, config.jwtSecret, config.baseUrl, 'access');

    if (!result.valid) {
      reply.status(401).header(
        'WWW-Authenticate',
        `Bearer realm="gmail-mcp", error="invalid_token", error_description="${result.error}"`
      );
      reply.send({
        error: 'invalid_token',
        error_description: result.error,
      });
      return null;
    }

    return {
      userId: result.payload.sub,
      scope: result.payload.scope,
    };
  }

  /**
   * Handler for POST /oauth/token endpoint.
   * Supports authorization_code and refresh_token grants.
   */
  async function tokenEndpointHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const body = request.body as {
      grant_type?: string;
      code?: string;
      refresh_token?: string;
      scope?: string;
    };

    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      // For now, we'll use a simplified flow where the code IS the user ID
      // In production, you'd validate against stored authorization codes
      const code = body.code;
      if (!code) {
        reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing authorization code',
        });
        return;
      }

      // Generate new user or use code as identifier
      const userId = code.length === 32 ? code : generateUserId();
      const scope = body.scope ?? 'mcp:tools';

      const tokens = generateTokenPair(userId, config.baseUrl, scope, config.jwtSecret);

      reply.send({
        access_token: tokens.accessToken,
        token_type: tokens.tokenType,
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing refresh token',
        });
        return;
      }

      const result = validateToken(refreshToken, config.jwtSecret, config.baseUrl, 'refresh');

      if (!result.valid) {
        reply.status(400).send({
          error: 'invalid_grant',
          error_description: result.error,
        });
        return;
      }

      // Generate new token pair (rotating refresh token)
      const tokens = generateTokenPair(
        result.payload.sub,
        config.baseUrl,
        result.payload.scope,
        config.jwtSecret
      );

      reply.send({
        access_token: tokens.accessToken,
        token_type: tokens.tokenType,
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
      return;
    }

    reply.status(400).send({
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grantType}' is not supported`,
    });
  }

  /**
   * Simple authorization endpoint - generates a code for the token endpoint.
   * In production, this would show a login UI.
   */
  async function authorizeEndpointHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query as {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      state?: string;
      scope?: string;
    };

    if (query.response_type !== 'code') {
      reply.status(400).send({
        error: 'unsupported_response_type',
        error_description: 'Only "code" response type is supported',
      });
      return;
    }

    // Generate an authorization code (which is just a user ID for simplicity)
    const code = generateUserId();

    // Redirect back to client with code
    if (query.redirect_uri) {
      const redirectUrl = new URL(query.redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (query.state) {
        redirectUrl.searchParams.set('state', query.state);
      }
      reply.redirect(redirectUrl.toString());
      return;
    }

    // No redirect URI - return code directly
    reply.send({
      code,
      state: query.state,
    });
  }

  return {
    authMiddleware,
    tokenEndpointHandler,
    authorizeEndpointHandler,
  };
}

export type McpOAuth = ReturnType<typeof createMcpOAuth>;
