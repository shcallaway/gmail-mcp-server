/**
 * MCP Server setup using @modelcontextprotocol/sdk
 *
 * This module implements all Gmail MCP tools:
 * - gmail.authorize: Initiates OAuth flow
 * - gmail.status: Returns authorization status
 * - gmail.searchMessages: Search messages using Gmail query syntax
 * - gmail.getMessage: Get a single message by ID
 * - gmail.listThreads: List conversation threads
 * - gmail.getThread: Get a thread with all messages
 * - gmail.getAttachmentMetadata: Get attachment info
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import type { TokenStore } from '../store/interface.js';
import { createGmailClientFactory } from '../gmail/client.js';
import { NotAuthorizedError, GmailApiError } from '../utils/errors.js';

export interface McpServerDependencies {
  config: Config;
  tokenStore: TokenStore;
}

// Helper to extract MCP user ID from auth info
function getMcpUserId(extra: { authInfo?: unknown }): string {
  const authInfo = extra.authInfo as { sub?: string } | undefined;
  return authInfo?.sub ?? 'anonymous';
}

// Helper to format error responses
function formatError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let code = -32603; // Internal error default
  let message = 'An unexpected error occurred';

  if (error instanceof NotAuthorizedError) {
    code = -32001; // NOT_AUTHORIZED
    message = error.message;
  } else if (error instanceof GmailApiError) {
    code = error.httpStatus === 429 ? -32000 : -32000; // RATE_LIMITED or GMAIL_API_ERROR
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: message, code }),
      },
    ],
    isError: true,
  };
}

export interface McpServerInstance {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  handleRequest: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
}

export async function createMcpServer(deps: McpServerDependencies): Promise<McpServerInstance> {
  const { config, tokenStore } = deps;

  // Create Gmail client factory
  const gmailClient = createGmailClientFactory({
    tokenStore,
    encryptionKey: config.tokenEncryptionKey,
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
  });

  // Create MCP server with identity
  const server = new McpServer(
    {
      name: 'gmail-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Create Streamable HTTP transport (stateless mode for now)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  // Register gmail.status tool
  server.registerTool(
    'gmail.status',
    {
      description: 'Returns whether the current user has Gmail connected',
    },
    async (extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const credentials = await tokenStore.getCredentials(mcpUserId);

        if (credentials) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  authorized: true,
                  email: credentials.email,
                  scopes: credentials.scope.split(' '),
                  lastAuthorizedAt: credentials.updatedAt.toISOString(),
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                authorized: false,
                message: 'Gmail not connected. Use gmail.authorize to link your Gmail account.',
              }),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.authorize tool
  server.registerTool(
    'gmail.authorize',
    {
      description: 'Initiates the OAuth consent flow to connect Gmail',
      inputSchema: {
        scopes: z.array(z.enum(['gmail.readonly', 'gmail.labels'])).optional(),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const scopes = args?.scopes ?? ['gmail.readonly'];

      // Build authorization URL with MCP user ID
      const authUrl = new URL('/oauth/start', config.baseUrl);
      authUrl.searchParams.set('scopes', scopes.join(','));
      authUrl.searchParams.set('mcp_user_id', mcpUserId);

      return {
        content: [
          {
            type: 'text' as const,
            text: `To connect your Gmail account, please open the following URL in your browser:\n\n${authUrl.toString()}\n\nAfter authorizing, return here and try your Gmail operation again.`,
          },
        ],
      };
    }
  );

  // Register gmail.searchMessages tool
  server.registerTool(
    'gmail.searchMessages',
    {
      description: 'Search messages using Gmail query syntax (e.g., "from:john subject:meeting")',
      inputSchema: {
        query: z.string().describe('Gmail search query'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.searchMessages(
          mcpUserId,
          args.query,
          args.maxResults ?? 20,
          args.pageToken
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getMessage tool
  server.registerTool(
    'gmail.getMessage',
    {
      description: 'Get a single message by ID',
      inputSchema: {
        messageId: z.string().describe('The message ID'),
        format: z.enum(['metadata', 'full']).optional().describe('Response format (default: metadata)'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const message = await gmailClient.getMessage(
          mcpUserId,
          args.messageId,
          args.format ?? 'metadata'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(message),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.listThreads tool
  server.registerTool(
    'gmail.listThreads',
    {
      description: 'List conversation threads, optionally filtered by query',
      inputSchema: {
        query: z.string().optional().describe('Optional Gmail search query'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.listThreads(
          mcpUserId,
          args.query,
          args.maxResults ?? 20,
          args.pageToken
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getThread tool
  server.registerTool(
    'gmail.getThread',
    {
      description: 'Get a thread with all its messages',
      inputSchema: {
        threadId: z.string().describe('The thread ID'),
        format: z.enum(['metadata', 'full']).optional().describe('Response format (default: metadata)'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const messages = await gmailClient.getThread(
          mcpUserId,
          args.threadId,
          args.format ?? 'metadata'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ messages }),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getAttachmentMetadata tool
  server.registerTool(
    'gmail.getAttachmentMetadata',
    {
      description: 'Get metadata about an attachment (filename, size, MIME type)',
      inputSchema: {
        messageId: z.string().describe('The message ID'),
        attachmentId: z.string().describe('The attachment ID'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const attachment = await gmailClient.getAttachmentMetadata(
          mcpUserId,
          args.messageId,
          args.attachmentId
        );

        if (!attachment) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Attachment not found', code: -32602 }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(attachment),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Connect server to transport
  await server.connect(transport);

  // Return handler for HTTP requests
  const handleRequest = async (req: IncomingMessage, res: ServerResponse, body?: unknown) => {
    await transport.handleRequest(req, res, body);
  };

  return {
    server,
    transport,
    handleRequest,
  };
}
