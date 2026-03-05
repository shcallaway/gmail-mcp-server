/**
 * MCP Server setup using @modelcontextprotocol/sdk
 *
 * Gmail MCP tools:
 * - gmail.status / gmail.authorize — auth and connection
 * - gmail.searchMessages — single or batch message search
 * - gmail.getMessage / gmail.getThread / gmail.listThreads — read
 * - gmail.getAttachmentMetadata / gmail.listLabels / gmail.getLabelInfo — metadata
 * - gmail.organizeMessages — archive, star, trash, label, read/unread (batched)
 * - gmail.sendMessage — send email
 * - gmail.manageDraft — create, get, update, delete, send, list drafts
 * - gmail.createLabel — create custom labels
 * - gmail.listAccounts / gmail.setDefaultAccount / gmail.removeAccount — account mgmt
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

// Structured search fields shared by searchMessages, listThreads, and batch items.
// The server compiles these into a Gmail query string so the caller doesn't need
// to know Gmail search syntax.
const structuredSearchFields = {
  from: z.string().optional().describe('Sender name or email address (e.g. "github", "notifications@github.com")'),
  to: z.string().optional().describe('Recipient email address'),
  subject: z.string().optional().describe('Words in the subject line'),
  after: z.string().optional().describe('Messages after this date (YYYY-MM-DD)'),
  before: z.string().optional().describe('Messages before this date (YYYY-MM-DD)'),
  label: z.string().optional().describe('Gmail label name to filter by'),
  hasAttachment: z.boolean().optional().describe('Only messages with attachments'),
  scope: z.enum(['default', 'inbox', 'trash', 'spam', 'anywhere']).optional()
    .describe('Where to search. "default" (the default) = everything except trash and spam. "inbox" = only inbox. "trash"/"spam" = only that location. "anywhere" = everything including trash and spam.'),
};

type StructuredSearchParams = {
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  label?: string;
  hasAttachment?: boolean;
  scope?: string;
  query?: string;
};

function buildSearchQuery(params: StructuredSearchParams): string {
  const parts: string[] = [];
  if (params.from) parts.push(`from:${params.from}`);
  if (params.to) parts.push(`to:${params.to}`);
  if (params.subject) parts.push(`subject:(${params.subject})`);
  if (params.after) parts.push(`after:${params.after}`);
  if (params.before) parts.push(`before:${params.before}`);
  if (params.label) parts.push(`label:${params.label}`);
  if (params.hasAttachment) parts.push('has:attachment');

  switch (params.scope) {
    case 'inbox': parts.push('in:inbox'); break;
    case 'trash': parts.push('in:trash'); break;
    case 'spam': parts.push('in:spam'); break;
    case 'anywhere': parts.push('in:anywhere'); break;
    // 'default' and undefined: no qualifier — Gmail excludes trash/spam automatically
  }

  if (params.query) parts.push(params.query);
  return parts.join(' ');
}

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

  // Register gmail.searchMessages tool (also handles batch searches via queries array)
  server.registerTool(
    'gmail.searchMessages',
    {
      description:
        'Search messages. Prefer structured fields (from, to, subject, after, before, scope) over raw query.\n' +
        'Two modes:\n' +
        '- Single search: pass structured fields and/or "query" with optional maxResults/pageToken\n' +
        '- Batch search: pass "queries" array to run multiple searches in parallel\n' +
        'For single search, structured fields and "query" are merged. For batch, each item can use structured fields and/or "query".',
      inputSchema: {
        ...structuredSearchFields,
        query: z.string().optional().describe('Raw Gmail query to merge with structured fields (for single search)'),
        queries: z.array(z.object({
          ...structuredSearchFields,
          query: z.string().optional().describe('Raw Gmail query to merge with structured fields'),
          maxResults: z.number().int().min(1).max(100).optional().describe('Max results for this query (default 20)'),
        })).min(1).max(10).optional().describe('Array of search queries for batch search (max 10)'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results for single search (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination (single search only)'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const hasQueries = Array.isArray(args.queries) && args.queries.length > 0;

      try {
        if (hasQueries) {
          const builtQueries = args.queries!.map((q: StructuredSearchParams & { maxResults?: number }) => ({
            query: buildSearchQuery(q),
            maxResults: q.maxResults,
          }));
          const results = await gmailClient.batchSearchMessages(mcpUserId, builtQueries, args.email);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                results,
                queryCount: results.length,
                totalMessages: results.reduce((sum: number, r: { result: { messages: unknown[] } }) => sum + r.result.messages.length, 0),
              }),
            }],
          };
        }

        const builtQuery = buildSearchQuery(args as StructuredSearchParams);
        if (!builtQuery.trim()) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide at least one search parameter (from, subject, query, etc.)', code: -32602 }) }],
            isError: true,
          };
        }

        const result = await gmailClient.searchMessages(
          mcpUserId,
          builtQuery,
          args.maxResults ?? 20,
          args.pageToken,
          args.email
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Register gmail.getMessage tool
  server.registerTool(
    'gmail.getMessage',
    {
      description:
        'Get a single message by ID. Formats: "metadata" (headers/snippet only, fastest), ' +
        '"summary" (headers + first 2KB of text body, no HTML), "full" (complete message with truncation options). ' +
        'Use "summary" for quick content preview without downloading huge HTML emails.',
      inputSchema: {
        messageId: z.string().describe('The message ID'),
        format: z.enum(['metadata', 'summary', 'full']).optional().describe('Response format: metadata (fastest), summary (2KB text preview), or full (default: metadata)'),
        maxBodyLength: z.number().int().min(100).max(500000).optional().describe('Max characters for body content. Default: 2000 for summary, 50000 for full. Use smaller values for faster responses.'),
        includeHtml: z.boolean().optional().describe('Include HTML body (default: false for summary, true for full). Set false to reduce response size.'),
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
          args.email,
          {
            maxBodyLength: args.maxBodyLength,
            includeHtml: args.includeHtml,
          }
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
      description: 'List conversation threads, optionally filtered. Prefer structured fields (from, subject, scope, etc.) over raw query.',
      inputSchema: {
        ...structuredSearchFields,
        query: z.string().optional().describe('Raw Gmail query to merge with structured fields'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum results (1-100, default 20)'),
        pageToken: z.string().optional().describe('Token for pagination'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const builtQuery = buildSearchQuery(args as StructuredSearchParams) || undefined;
        const result = await gmailClient.listThreads(
          mcpUserId,
          builtQuery,
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

  // ============== TRIAGE SNAPSHOT TOOL ==============

  server.registerTool(
    'gmail.triageSnapshot',
    {
      description:
        'Get a triage-ready inbox snapshot in one call. Returns thread metadata ' +
        '(subject, from, date, snippet, messageCount) for up to maxResults inbox threads. ' +
        'Designed for email triage workflows — provides enough context to classify and ' +
        'plan actions without fetching full thread bodies. ' +
        'Use pageToken to paginate through large inboxes.',
      inputSchema: {
        ...structuredSearchFields,
        query: z.string().optional().describe('Raw Gmail query to merge with structured fields'),
        maxResults: z.number().int().min(1).max(50).optional().describe('Max threads to return (default 25, max 50)'),
        pageToken: z.string().optional().describe('Pagination token from a previous triageSnapshot call'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const builtQuery = buildSearchQuery({
          ...(args as StructuredSearchParams),
          scope: (args as StructuredSearchParams).scope ?? 'inbox',
        }) || 'in:inbox';

        const result = await gmailClient.listThreads(
          mcpUserId,
          builtQuery,
          args.maxResults ?? 25,
          args.pageToken,
          args.email
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              threadCount: result.threads.length,
              hasMore: Boolean(result.nextPageToken),
              nextPageToken: result.nextPageToken ?? undefined,
              threads: result.threads,
            }),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============== ORGANIZE TOOL ==============

  const ORGANIZE_ACTIONS = [
    'archive', 'unarchive',
    'mark_read', 'mark_unread',
    'star', 'unstar',
    'trash', 'untrash',
    'add_labels', 'remove_labels',
  ] as const;

  type OrganizeAction = (typeof ORGANIZE_ACTIONS)[number];

  server.registerTool(
    'gmail.organizeMessages',
    {
      description:
        'Apply one or more organize actions to messages/threads in a single call. ' +
        'Supported actions: archive, unarchive, mark_read, mark_unread, star, unstar, trash, untrash, add_labels, remove_labels. ' +
        'Each action item specifies its own messageIds/threadIds. ' +
        'For archive/unarchive, set archiveEntireThread (default true) to auto-expand messageIds to their parent threads.',
      inputSchema: {
        actions: z.array(z.object({
          action: z.enum(ORGANIZE_ACTIONS).describe('The organize operation to perform'),
          messageIds: z.array(z.string()).optional().describe('Message IDs to act on'),
          threadIds: z.array(z.string()).optional().describe('Thread IDs to act on'),
          labelIds: z.array(z.string()).optional().describe('Label IDs (required for add_labels/remove_labels)'),
          archiveEntireThread: z.boolean().optional().describe('For archive/unarchive: expand messageIds to full threads (default true)'),
        })).min(1).describe('Array of organize actions to apply'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const results: Array<{ action: OrganizeAction; ok: boolean; result?: unknown; error?: string }> = [];

      for (const item of args.actions) {
        if (!item.messageIds?.length && !item.threadIds?.length) {
          results.push({ action: item.action, ok: false, error: 'At least one messageId or threadId must be provided' });
          continue;
        }

        try {
          let { messageIds, threadIds } = item;
          const expandThread = item.archiveEntireThread ?? true;

          if ((item.action === 'archive' || item.action === 'unarchive') && expandThread && messageIds?.length) {
            const expanded = await gmailClient.getThreadIdsForMessages(mcpUserId, messageIds, args.email);
            threadIds = [...new Set([...(threadIds ?? []), ...expanded])];
            messageIds = undefined;
          }

          let result: unknown;
          switch (item.action) {
            case 'archive':
              result = await gmailClient.archiveMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'unarchive':
              result = await gmailClient.unarchiveMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'mark_read':
              result = await gmailClient.markAsRead(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'mark_unread':
              result = await gmailClient.markAsUnread(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'star':
              result = await gmailClient.starMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'unstar':
              result = await gmailClient.unstarMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'trash':
              result = await gmailClient.trashMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'untrash':
              result = await gmailClient.untrashMessages(mcpUserId, messageIds, threadIds, args.email);
              break;
            case 'add_labels':
              if (!item.labelIds?.length) {
                results.push({ action: item.action, ok: false, error: 'labelIds required for add_labels' });
                continue;
              }
              result = await gmailClient.addLabels(mcpUserId, messageIds, threadIds, item.labelIds, args.email);
              break;
            case 'remove_labels':
              if (!item.labelIds?.length) {
                results.push({ action: item.action, ok: false, error: 'labelIds required for remove_labels' });
                continue;
              }
              result = await gmailClient.removeLabels(mcpUserId, messageIds, threadIds, item.labelIds, args.email);
              break;
          }
          const batchResult = result as { failureCount?: number } | undefined;
          const hasFailures = typeof batchResult?.failureCount === 'number' && batchResult.failureCount > 0;
          results.push({ action: item.action, ok: !hasFailures, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          results.push({ action: item.action, ok: false, error: message });
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ results, actionCount: results.length }) }],
      };
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

  // Register gmail.sendMessage tool
  server.registerTool(
    'gmail.sendMessage',
    {
      description: 'Send an email message. For replies, provide replyToMessageId to preserve threading. Requires gmail.compose scope.',
      inputSchema: {
        to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
        bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
        isHtml: z.boolean().optional().describe('Whether body is HTML (default: false, plain text)'),
        replyToMessageId: z.string().optional().describe('Message ID to reply to. Preserves threading with proper In-Reply-To and References headers.'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);

      try {
        const result = await gmailClient.sendMessage(mcpUserId, args.to, args.subject, args.body, {
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

  // ============== DRAFT LIFECYCLE TOOL ==============

  const DRAFT_ACTIONS = ['create', 'get', 'update', 'delete', 'send', 'list'] as const;

  const recipientSchema = z.union([z.string(), z.array(z.string())]);

  server.registerTool(
    'gmail.manageDraft',
    {
      description:
        'Manage draft emails. Actions:\n' +
        '- "create": create a new draft (requires to, subject, body)\n' +
        '- "get": get a draft with full content (requires draftId)\n' +
        '- "update": update an existing draft (requires draftId, to, subject, body)\n' +
        '- "delete": delete a draft (requires draftId)\n' +
        '- "send": send an existing draft (requires draftId)\n' +
        '- "list": list all drafts (optional maxResults, pageToken)',
      inputSchema: {
        action: z.enum(DRAFT_ACTIONS).describe('Draft operation to perform'),
        draftId: z.string().optional().describe('Draft ID (required for get/update/delete/send)'),
        to: recipientSchema.optional().describe('Recipient email address(es) (for create/update)'),
        subject: z.string().optional().describe('Email subject (for create/update)'),
        body: z.string().optional().describe('Email body content (for create/update)'),
        cc: recipientSchema.optional().describe('CC recipient(s)'),
        bcc: recipientSchema.optional().describe('BCC recipient(s)'),
        isHtml: z.boolean().optional().describe('Whether body is HTML (default: false)'),
        replyToMessageId: z.string().optional().describe('Message ID to reply to (preserves threading)'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Max results for list (default 20)'),
        pageToken: z.string().optional().describe('Pagination token for list'),
        email: emailSchema,
      },
    },
    async (args, extra) => {
      const mcpUserId = getMcpUserId(extra);
      const composeOpts = { cc: args.cc, bcc: args.bcc, isHtml: args.isHtml, replyToMessageId: args.replyToMessageId };

      try {
        let result: unknown;

        switch (args.action) {
          case 'create':
            if (!args.to || !args.subject || !args.body) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'to, subject, and body are required for action=create', code: -32602 }) }], isError: true as const };
            }
            result = await gmailClient.createDraft(mcpUserId, args.to, args.subject, args.body, composeOpts, args.email);
            break;
          case 'get':
            if (!args.draftId) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'draftId is required for action=get', code: -32602 }) }], isError: true as const };
            }
            result = await gmailClient.getDraft(mcpUserId, args.draftId, args.email);
            break;
          case 'update':
            if (!args.draftId || !args.to || !args.subject || !args.body) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'draftId, to, subject, and body are required for action=update', code: -32602 }) }], isError: true as const };
            }
            result = await gmailClient.updateDraft(mcpUserId, args.draftId, args.to, args.subject, args.body, composeOpts, args.email);
            break;
          case 'delete':
            if (!args.draftId) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'draftId is required for action=delete', code: -32602 }) }], isError: true as const };
            }
            result = await gmailClient.deleteDraft(mcpUserId, args.draftId, args.email);
            break;
          case 'send':
            if (!args.draftId) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'draftId is required for action=send', code: -32602 }) }], isError: true as const };
            }
            result = await gmailClient.sendDraft(mcpUserId, args.draftId, args.email);
            break;
          case 'list':
            result = await gmailClient.listDrafts(mcpUserId, args.maxResults ?? 20, args.pageToken, args.email);
            break;
        }

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
