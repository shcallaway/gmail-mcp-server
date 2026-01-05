/**
 * JWT utilities for MCP-level authentication.
 *
 * Implements token generation and validation as specified in SPEC.md Section 6.1.
 */

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

export interface JwtPayload {
  /** User ID (unique identifier) */
  sub: string;
  /** Issuer (server base URL) */
  iss: string;
  /** Audience (must be "gmail-mcp") */
  aud: string;
  /** Expiration timestamp */
  exp: number;
  /** Issued at timestamp */
  iat: number;
  /** Space-separated scopes */
  scope: string;
  /** Token type (access or refresh) */
  type: 'access' | 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  scope: string;
}

// Token lifetimes from SPEC.md
const ACCESS_TOKEN_LIFETIME = 3600; // 1 hour in seconds
const REFRESH_TOKEN_LIFETIME = 2592000; // 30 days in seconds

/**
 * Generate a new user ID for MCP authentication.
 */
export function generateUserId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate an access token for the given user.
 */
export function generateAccessToken(
  userId: string,
  issuer: string,
  scope: string,
  secret: string
): string {
  const now = Math.floor(Date.now() / 1000);

  const payload: JwtPayload = {
    sub: userId,
    iss: issuer,
    aud: 'gmail-mcp',
    exp: now + ACCESS_TOKEN_LIFETIME,
    iat: now,
    scope,
    type: 'access',
  };

  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

/**
 * Generate a refresh token for the given user.
 */
export function generateRefreshToken(
  userId: string,
  issuer: string,
  scope: string,
  secret: string
): string {
  const now = Math.floor(Date.now() / 1000);

  const payload: JwtPayload = {
    sub: userId,
    iss: issuer,
    aud: 'gmail-mcp',
    exp: now + REFRESH_TOKEN_LIFETIME,
    iat: now,
    scope,
    type: 'refresh',
  };

  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

/**
 * Generate a complete token pair (access + refresh tokens).
 */
export function generateTokenPair(
  userId: string,
  issuer: string,
  scope: string,
  secret: string
): TokenPair {
  return {
    accessToken: generateAccessToken(userId, issuer, scope, secret),
    refreshToken: generateRefreshToken(userId, issuer, scope, secret),
    expiresIn: ACCESS_TOKEN_LIFETIME,
    tokenType: 'Bearer',
    scope,
  };
}

export type TokenValidationResult = {
  valid: true;
  payload: JwtPayload;
} | {
  valid: false;
  error: string;
};

/**
 * Validate a JWT token.
 */
export function validateToken(
  token: string,
  secret: string,
  expectedIssuer: string,
  expectedType: 'access' | 'refresh' = 'access'
): TokenValidationResult {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'gmail-mcp',
      issuer: expectedIssuer,
    }) as JwtPayload;

    // Verify token type
    if (payload.type !== expectedType) {
      return {
        valid: false,
        error: `Expected ${expectedType} token, got ${payload.type}`,
      };
    }

    return { valid: true, payload };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { valid: false, error: `Invalid token: ${error.message}` };
    }
    return { valid: false, error: 'Token validation failed' };
  }
}

/**
 * Extract the Bearer token from an Authorization header.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1] ?? null;
}
