/**
 * Error types for the Gmail MCP server.
 * Maps to MCP JSON-RPC error codes as specified in SPEC.md Section 11.
 */

export const ErrorCodes = {
  NOT_AUTHORIZED: -32001,
  INVALID_ARGUMENT: -32602,
  GMAIL_API_ERROR: -32000,
  RATE_LIMITED: -32000,
  INTERNAL_ERROR: -32603,
  SERVICE_UNAVAILABLE: -32000,
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class NotAuthorizedError extends McpError {
  constructor(message = 'User not authenticated or Gmail not linked', data?: Record<string, unknown>) {
    super(ErrorCodes.NOT_AUTHORIZED, message, data);
    this.name = 'NotAuthorizedError';
  }
}

export class InvalidArgumentError extends McpError {
  constructor(message: string, data?: Record<string, unknown>) {
    super(ErrorCodes.INVALID_ARGUMENT, message, data);
    this.name = 'InvalidArgumentError';
  }
}

export class GmailApiError extends McpError {
  constructor(message: string, public readonly httpStatus?: number, data?: Record<string, unknown>) {
    super(ErrorCodes.GMAIL_API_ERROR, message, { ...data, httpStatus });
    this.name = 'GmailApiError';
  }
}

export class RateLimitedError extends McpError {
  constructor(message = 'Rate limit exceeded', public readonly retryAfter?: number) {
    super(ErrorCodes.RATE_LIMITED, message, retryAfter ? { retryAfter } : undefined);
    this.name = 'RateLimitedError';
  }
}

export class InternalError extends McpError {
  constructor(message = 'Internal server error', data?: Record<string, unknown>) {
    super(ErrorCodes.INTERNAL_ERROR, message, data);
    this.name = 'InternalError';
  }
}

export class ServiceUnavailableError extends McpError {
  constructor(message = 'Service temporarily unavailable', public readonly retryAfter?: number) {
    super(ErrorCodes.SERVICE_UNAVAILABLE, message, retryAfter ? { retryAfter } : undefined);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Convert any error to an McpError for consistent error handling.
 */
export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message);
  }

  return new InternalError('An unexpected error occurred');
}
