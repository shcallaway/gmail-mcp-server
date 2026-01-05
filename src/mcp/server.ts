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
 * - gmail.archiveMessages: Archive messages/threads
 * - gmail.unarchiveMessages: Unarchive messages/threads
 * - gmail.markAsRead: Mark messages/threads as read
 * - gmail.markAsUnread: Mark messages/threads as unread
 * - gmail.starMessages: Star messages/threads
 * - gmail.unstarMessages: Unstar messages/threads
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import type { TokenStore } from '../store/interface.js';
import { createGmailClientFactory } from '../gmail/client.js';
import { NotAuthorizedError, GmailApiError, InsufficientScopeError } from '../utils/errors.js';

export interface McpServerDependencies {
  config: Config;
  tokenStore: TokenStore;
}

// Helper to extract MCP user ID from auth info
function getMcpUserId(extra: { authInfo?: unknown }): string {
  const authInfo = extra.authInfo as { sub?: string } | undefined;
  return authInfo?.sub ?? 'anonymous';
}

// Reusable email schema for selecting which Gmail account to use
const emailSchema = z.string().email().optional().describe('Email address of the Gmail account to use. If not specified, uses the default account.');

// Helper to format error responses
function formatError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let code = -32603; // Internal error default
  let message = 'An unexpected error occurred';
  let data: Record<string, unknown> | undefined;

  if (error instanceof InsufficientScopeError) {
    code = -32001; // NOT_AUTHORIZED
    message = error.message;
    data = { requiredScope: error.requiredScope };
  } else if (error instanceof NotAuthorizedError) {
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
        text: JSON.stringify({ error: message, code, ...(data && { data }) }),
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
        const accounts = await tokenStore.listAccounts(mcpUserId);

        if (accounts.length > 0) {
          const defaultAccount = accounts.find(a => a.isDefault) ?? accounts[0]!;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  authorized: true,
                  accountCount: accounts.length,
                  defaultAccount: defaultAccount.email,
                  accounts: accounts.map(a => ({
                    email: a.email,
                    isDefault: a.isDefault,
                    scopes: a.scopes,
                    connectedAt: a.connectedAt.toISOString(),
                  })),
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
                accountCount: 0,
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
        scopes: z.array(z.enum(['gmail.readonly', 'gmail.labels', 'gmail.modify', 'gmail.compose'])).optional(),
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
      description:
        'Search messages using Gmail query syntax (e.g., "from:john subject:meeting"). ' +
        'Results include threadId and threadMessageCount to support thread-aware operations. ' +
        'TIP: Use threadIds with archiveMessages to ensure entire conversations leave your inbox.',
      inputSchema: {
        query: z.string().describe('Gmail search query'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.searchMessages(
          mcpUserId,
          args.query,
          args.maxResults ?? 20,
          args.pageToken,
          args.email
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
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const message = await gmailClient.getMessage(
          mcpUserId,
          args.messageId,
          args.format ?? 'metadata',
          args.email
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
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.listThreads(
          mcpUserId,
          args.query,
          args.maxResults ?? 20,
          args.pageToken,
          args.email
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
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const messages = await gmailClient.getThread(
          mcpUserId,
          args.threadId,
          args.format ?? 'metadata',
          args.email
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
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const attachment = await gmailClient.getAttachmentMetadata(
          mcpUserId,
          args.messageId,
          args.attachmentId,
          args.email
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

  // Shared input schema for modification tools
  const modifyInputSchema = {
    messageIds: z.array(z.string()).optional().describe('Array of message IDs to modify'),
    threadIds: z.array(z.string()).optional().describe('Array of thread IDs to modify (applies to all messages in thread)'),
    email: emailSchema,
  };

  // Extended schema for archive operations with thread-aware default behavior
  const archiveInputSchema = {
    ...modifyInputSchema,
    archiveEntireThread: z.boolean().optional().describe(
      'When true (default), automatically expands messageIds to their parent threads to ensure entire conversations are archived/unarchived. Set to false to archive individual messages only.'
    ),
  };

  // Helper to validate at least one ID is provided
  function validateModifyInput(args: { messageIds?: string[]; threadIds?: string[] }): string | null {
    if (!args.messageIds?.length && !args.threadIds?.length) {
      return 'At least one messageId or threadId must be provided';
    }
    return null;
  }

  // Register gmail.archiveMessages tool
  server.registerTool(
    'gmail.archiveMessages',
    {
      description:
        'Archive messages or threads (removes from inbox). Requires gmail.labels scope. ' +
        'By default (archiveEntireThread=true), archiving a messageId will archive its entire thread to ensure the conversation leaves your inbox.',
      inputSchema: archiveInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        let { messageIds, threadIds } = args;
        const archiveEntireThread = args.archiveEntireThread ?? true;

        // Convert messageIds to threadIds when archiveEntireThread is true (default)
        if (archiveEntireThread && messageIds?.length) {
          const expandedThreadIds = await gmailClient.getThreadIdsForMessages(mcpUserId, messageIds, args.email);
          threadIds = [...new Set([...(threadIds ?? []), ...expandedThreadIds])];
          messageIds = undefined;
        }

        const result = await gmailClient.archiveMessages(mcpUserId, messageIds, threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.unarchiveMessages tool
  server.registerTool(
    'gmail.unarchiveMessages',
    {
      description:
        'Move messages or threads back to inbox. Requires gmail.labels scope. ' +
        'By default (archiveEntireThread=true), unarchiving a messageId will unarchive its entire thread.',
      inputSchema: archiveInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        let { messageIds, threadIds } = args;
        const archiveEntireThread = args.archiveEntireThread ?? true;

        // Convert messageIds to threadIds when archiveEntireThread is true (default)
        if (archiveEntireThread && messageIds?.length) {
          const expandedThreadIds = await gmailClient.getThreadIdsForMessages(mcpUserId, messageIds, args.email);
          threadIds = [...new Set([...(threadIds ?? []), ...expandedThreadIds])];
          messageIds = undefined;
        }

        const result = await gmailClient.unarchiveMessages(mcpUserId, messageIds, threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.markAsRead tool
  server.registerTool(
    'gmail.markAsRead',
    {
      description: 'Mark messages or threads as read. Requires gmail.labels scope.',
      inputSchema: modifyInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.markAsRead(mcpUserId, args.messageIds, args.threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.markAsUnread tool
  server.registerTool(
    'gmail.markAsUnread',
    {
      description: 'Mark messages or threads as unread. Requires gmail.labels scope.',
      inputSchema: modifyInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.markAsUnread(mcpUserId, args.messageIds, args.threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.starMessages tool
  server.registerTool(
    'gmail.starMessages',
    {
      description: 'Add star to messages or threads. Requires gmail.labels scope.',
      inputSchema: modifyInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.starMessages(mcpUserId, args.messageIds, args.threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.unstarMessages tool
  server.registerTool(
    'gmail.unstarMessages',
    {
      description: 'Remove star from messages or threads. Requires gmail.labels scope.',
      inputSchema: modifyInputSchema,
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const validationError = validateModifyInput(args);
      if (validationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validationError, code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.unstarMessages(mcpUserId, args.messageIds, args.threadIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getLabelInfo tool
  server.registerTool(
    'gmail.getLabelInfo',
    {
      description: 'Get information about a label including message counts. Common labels: INBOX, UNREAD, STARRED, SENT, DRAFT, TRASH, SPAM.',
      inputSchema: {
        labelId: z.string().describe('The label ID (e.g., "INBOX", "UNREAD", "STARRED", or custom label ID)'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.getLabelInfo(mcpUserId, args.labelId, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.listLabels tool
  server.registerTool(
    'gmail.listLabels',
    {
      description: 'List all labels with their message counts',
      inputSchema: {
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.listLabels(mcpUserId, args?.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ labels: result }) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.addLabels tool
  server.registerTool(
    'gmail.addLabels',
    {
      description: 'Add labels to messages or threads. Requires gmail.labels scope.',
      inputSchema: {
        messageIds: z.array(z.string()).optional().describe('Array of message IDs to modify'),
        threadIds: z.array(z.string()).optional().describe('Array of thread IDs to modify'),
        labelIds: z.array(z.string()).describe('Array of label IDs to add'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      if (!args.messageIds?.length && !args.threadIds?.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one messageId or threadId must be provided', code: -32602 }) }],
          isError: true,
        };
      }

      if (!args.labelIds?.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one labelId must be provided', code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.addLabels(mcpUserId, args.messageIds, args.threadIds, args.labelIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.removeLabels tool
  server.registerTool(
    'gmail.removeLabels',
    {
      description: 'Remove labels from messages or threads. Requires gmail.labels scope.',
      inputSchema: {
        messageIds: z.array(z.string()).optional().describe('Array of message IDs to modify'),
        threadIds: z.array(z.string()).optional().describe('Array of thread IDs to modify'),
        labelIds: z.array(z.string()).describe('Array of label IDs to remove'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      if (!args.messageIds?.length && !args.threadIds?.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one messageId or threadId must be provided', code: -32602 }) }],
          isError: true,
        };
      }

      if (!args.labelIds?.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one labelId must be provided', code: -32602 }) }],
          isError: true,
        };
      }

      try {
        const result = await gmailClient.removeLabels(mcpUserId, args.messageIds, args.threadIds, args.labelIds, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.createLabel tool
  server.registerTool(
    'gmail.createLabel',
    {
      description: 'Create a new custom label. Requires gmail.labels scope.',
      inputSchema: {
        name: z.string().describe('Name for the new label'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.createLabel(mcpUserId, args.name, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.createDraft tool
  server.registerTool(
    'gmail.createDraft',
    {
      description: 'Create a new draft email. Requires gmail.compose scope.',
      inputSchema: {
        to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
        bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
        isHtml: z.boolean().optional().describe('Whether body is HTML (default: false, plain text)'),
        replyToMessageId: z.string().optional().describe('Message ID to reply to. When provided, the draft will be threaded as a reply with proper In-Reply-To and References headers.'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.createDraft(mcpUserId, args.to, args.subject, args.body, {
          cc: args.cc,
          bcc: args.bcc,
          isHtml: args.isHtml,
          replyToMessageId: args.replyToMessageId,
        }, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.listDrafts tool
  server.registerTool(
    'gmail.listDrafts',
    {
      description: 'List all draft emails',
      inputSchema: {
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.listDrafts(mcpUserId, args.maxResults ?? 20, args.pageToken, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getDraft tool
  server.registerTool(
    'gmail.getDraft',
    {
      description: 'Get a draft with full content',
      inputSchema: {
        draftId: z.string().describe('The draft ID'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.getDraft(mcpUserId, args.draftId, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.updateDraft tool
  server.registerTool(
    'gmail.updateDraft',
    {
      description: 'Update an existing draft. Requires gmail.compose scope.',
      inputSchema: {
        draftId: z.string().describe('The draft ID to update'),
        to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
        bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
        isHtml: z.boolean().optional().describe('Whether body is HTML (default: false, plain text)'),
        replyToMessageId: z.string().optional().describe('Message ID to reply to. When provided, the draft will be threaded as a reply with proper In-Reply-To and References headers.'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.updateDraft(mcpUserId, args.draftId, args.to, args.subject, args.body, {
          cc: args.cc,
          bcc: args.bcc,
          isHtml: args.isHtml,
          replyToMessageId: args.replyToMessageId,
        }, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.deleteDraft tool
  server.registerTool(
    'gmail.deleteDraft',
    {
      description: 'Delete a draft. Requires gmail.compose scope.',
      inputSchema: {
        draftId: z.string().describe('The draft ID to delete'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.deleteDraft(mcpUserId, args.draftId, args.email);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============== ACCOUNT MANAGEMENT TOOLS ==============

  // Register gmail.listAccounts tool
  server.registerTool(
    'gmail.listAccounts',
    {
      description: 'List all connected Gmail accounts for the current user',
    },
    async (extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const accounts = await gmailClient.listAccounts(mcpUserId);
        const defaultAccount = accounts.find(a => a.isDefault)?.email ?? accounts[0]?.email ?? null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              accounts: accounts.map(a => ({
                email: a.email,
                isDefault: a.isDefault,
                scopes: a.scopes,
                connectedAt: a.connectedAt.toISOString(),
              })),
              count: accounts.length,
              defaultAccount,
            }),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.setDefaultAccount tool
  server.registerTool(
    'gmail.setDefaultAccount',
    {
      description: 'Set the default Gmail account for operations when no email is specified',
      inputSchema: {
        email: z.string().email().describe('Email address of the account to set as default'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        await gmailClient.setDefaultAccount(mcpUserId, args.email);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, defaultAccount: args.email }),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.removeAccount tool
  server.registerTool(
    'gmail.removeAccount',
    {
      description: 'Disconnect a specific Gmail account',
      inputSchema: {
        email: z.string().email().describe('Email address of the account to remove'),
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        // Check if this is the last account
        const accounts = await gmailClient.listAccounts(mcpUserId);
        if (accounts.length <= 1) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Cannot remove the last connected account. Use gmail.authorize to connect a different account first.',
                code: -32602,
              }),
            }],
            isError: true,
          };
        }

        await gmailClient.removeAccount(mcpUserId, args.email);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, removedAccount: args.email }),
          }],
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
