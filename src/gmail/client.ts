/**
 * Gmail API client wrapper with token refresh support.
 *
 * This module handles:
 * - Creating authenticated Gmail client from stored credentials
 * - Automatic token refresh
 * - Gmail API method wrappers
 * - Response transformation to spec-defined formats
 */

import { google, gmail_v1 } from 'googleapis';
import type { TokenStore, GmailCredentials, AccountInfo } from '../store/interface.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { NotAuthorizedError, GmailApiError, InsufficientScopeError } from '../utils/errors.js';

export interface GmailClientDependencies {
  tokenStore: TokenStore;
  encryptionKey: string;
  googleClientId: string;
  googleClientSecret: string;
}

export interface MessageHeader {
  name: string;
  value: string;
}

export interface MessageMetadata {
  id: string;
  threadId: string;
  snippet: string;
  headers: {
    from?: string;
    to?: string;
    subject?: string;
    date?: string;
  };
  attachments: AttachmentMetadata[];
}

export interface MessageFull extends MessageMetadata {
  body: {
    text?: string;
    html?: string;
  };
}

export interface AttachmentMetadata {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface SearchResultMessage {
  id: string;
  threadId: string;
  threadMessageCount?: number;
  snippet?: string;
  subject?: string;
  from?: string;
  date?: string;
}

export interface SearchResult {
  messages: SearchResultMessage[];
  nextPageToken?: string;
}

export interface ThreadResult {
  threads: Array<{ id: string; snippet?: string }>;
  nextPageToken?: string;
}

export interface ModifyResult {
  id: string;
  success: boolean;
  error?: string;
}

export interface BatchModifyResult {
  results: ModifyResult[];
  successCount: number;
  failureCount: number;
}

export interface LabelInfo {
  id: string;
  name: string;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
}

export interface DraftInfo {
  id: string;
  messageId: string;
  snippet: string;
  subject?: string;
  to?: string;
}

export interface DraftContent extends DraftInfo {
  body?: {
    text?: string;
    html?: string;
  };
}

export interface DraftListResult {
  drafts: DraftInfo[];
  nextPageToken?: string;
}

// Gmail scopes
const GMAIL_LABELS_SCOPE = 'https://www.googleapis.com/auth/gmail.labels';
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

// Token refresh threshold (5 minutes before expiry)
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Create a Gmail client factory.
 */
export function createGmailClientFactory(deps: GmailClientDependencies) {
  const { tokenStore, encryptionKey, googleClientId, googleClientSecret } = deps;

  /**
   * Get or refresh credentials for a user.
   * If email is specified, gets that specific account.
   * If email is omitted, gets the default account.
   */
  async function getValidCredentials(mcpUserId: string, email?: string): Promise<GmailCredentials> {
    const credentials = await tokenStore.getCredentials(mcpUserId, email);

    if (!credentials) {
      if (email) {
        throw new NotAuthorizedError(`Gmail account ${email} not connected. Use gmail.listAccounts to see connected accounts.`);
      }
      throw new NotAuthorizedError('Gmail not connected. Use gmail.authorize to link your Gmail account.');
    }

    // Check if token needs refresh
    const now = Date.now();
    if (credentials.expiryDate - now < REFRESH_THRESHOLD_MS) {
      return await refreshCredentials(credentials);
    }

    return credentials;
  }

  /**
   * Refresh access token using stored refresh token.
   */
  async function refreshCredentials(credentials: GmailCredentials): Promise<GmailCredentials> {
    const oauth2Client = new google.auth.OAuth2(
      googleClientId,
      googleClientSecret
    );

    // Decrypt refresh token
    const refreshToken = decrypt(credentials.refreshToken, encryptionKey);

    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    try {
      const { credentials: newTokens } = await oauth2Client.refreshAccessToken();

      if (!newTokens.access_token) {
        throw new Error('No access token returned');
      }

      // Update stored credentials
      const newRefreshToken = newTokens.refresh_token
        ? encrypt(newTokens.refresh_token, encryptionKey)
        : undefined;

      await tokenStore.updateAccessToken(
        credentials.mcpUserId,
        credentials.email,
        newTokens.access_token,
        newTokens.expiry_date ?? Date.now() + 3600000,
        newRefreshToken
      );

      return {
        ...credentials,
        accessToken: newTokens.access_token,
        expiryDate: newTokens.expiry_date ?? Date.now() + 3600000,
        refreshToken: newRefreshToken ?? credentials.refreshToken,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for revocation - delete only this specific account
      if (errorMessage.includes('invalid_grant')) {
        await tokenStore.deleteCredentials(credentials.mcpUserId, credentials.email);
        throw new NotAuthorizedError(`Gmail access for ${credentials.email} revoked. Please re-authorize.`);
      }

      throw new GmailApiError(`Token refresh failed: ${errorMessage}`);
    }
  }

  /**
   * Create an authenticated Gmail client for a user.
   */
  async function getGmailClient(mcpUserId: string, email?: string): Promise<gmail_v1.Gmail> {
    const credentials = await getValidCredentials(mcpUserId, email);

    const oauth2Client = new google.auth.OAuth2(
      googleClientId,
      googleClientSecret
    );

    oauth2Client.setCredentials({
      access_token: credentials.accessToken,
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  /**
   * Search messages using Gmail query syntax.
   * Returns messages with metadata (snippet, subject, from, date).
   */
  async function searchMessages(
    mcpUserId: string,
    query: string,
    maxResults: number = 20,
    pageToken?: string,
    email?: string
  ): Promise<SearchResult> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
        pageToken,
      });

      const messageList = response.data.messages ?? [];

      // Collect unique thread IDs for batch fetching thread info
      const threadIds = new Set<string>();

      // Fetch metadata for each message
      const messages: SearchResultMessage[] = [];
      for (const m of messageList) {
        if (!m.id || !m.threadId) continue;
        threadIds.add(m.threadId);

        try {
          const msgResponse = await gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });

          const headers = msgResponse.data.payload?.headers ?? [];
          const fromHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'from');
          const subjectHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'subject');
          const dateHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'date');

          messages.push({
            id: m.id,
            threadId: m.threadId,
            snippet: msgResponse.data.snippet ?? undefined,
            subject: subjectHeader?.value ?? undefined,
            from: fromHeader?.value ?? undefined,
            date: dateHeader?.value ?? undefined,
          });
        } catch {
          // If metadata fetch fails, include basic info
          messages.push({
            id: m.id,
            threadId: m.threadId,
          });
        }
      }

      // Fetch thread info to get message counts
      const threadInfoMap = new Map<string, number>();
      for (const threadId of threadIds) {
        try {
          const threadResponse = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'minimal',
          });
          threadInfoMap.set(threadId, threadResponse.data.messages?.length ?? 1);
        } catch {
          threadInfoMap.set(threadId, 1);
        }
      }

      // Attach thread message counts to results
      for (const msg of messages) {
        msg.threadMessageCount = threadInfoMap.get(msg.threadId) ?? 1;
      }

      return {
        messages,
        nextPageToken: response.data.nextPageToken ?? undefined,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Get a single message.
   */
  async function getMessage(
    mcpUserId: string,
    messageId: string,
    format: 'metadata' | 'full' = 'metadata',
    email?: string
  ): Promise<MessageMetadata | MessageFull> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: format === 'full' ? 'full' : 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const message = response.data;
      const headers = extractHeaders(message.payload?.headers ?? []);
      const attachments = extractAttachments(message.payload);

      const metadata: MessageMetadata = {
        id: message.id!,
        threadId: message.threadId!,
        snippet: message.snippet ?? '',
        headers,
        attachments,
      };

      if (format === 'full') {
        const body = extractBody(message.payload);
        return { ...metadata, body } as MessageFull;
      }

      return metadata;
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * List threads.
   */
  async function listThreads(
    mcpUserId: string,
    query?: string,
    maxResults: number = 20,
    pageToken?: string,
    email?: string
  ): Promise<ThreadResult> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.threads.list({
        userId: 'me',
        q: query,
        maxResults,
        pageToken,
      });

      return {
        threads: (response.data.threads ?? []).map(t => ({
          id: t.id!,
          snippet: t.snippet ?? undefined,
        })),
        nextPageToken: response.data.nextPageToken ?? undefined,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Get a thread with all messages.
   */
  async function getThread(
    mcpUserId: string,
    threadId: string,
    format: 'metadata' | 'full' = 'metadata',
    email?: string
  ): Promise<Array<MessageMetadata | MessageFull>> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: format === 'full' ? 'full' : 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      return (response.data.messages ?? []).map(message => {
        const headers = extractHeaders(message.payload?.headers ?? []);
        const attachments = extractAttachments(message.payload);

        const metadata: MessageMetadata = {
          id: message.id!,
          threadId: message.threadId!,
          snippet: message.snippet ?? '',
          headers,
          attachments,
        };

        if (format === 'full') {
          const body = extractBody(message.payload);
          return { ...metadata, body } as MessageFull;
        }

        return metadata;
      });
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Get attachment metadata.
   */
  async function getAttachmentMetadata(
    mcpUserId: string,
    messageId: string,
    attachmentId: string,
    email?: string
  ): Promise<AttachmentMetadata | null> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });

      // Get message to find attachment details
      const message = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
      });

      const attachments = extractAttachments(message.data.payload);
      const attachment = attachments.find(a => a.attachmentId === attachmentId);

      if (!attachment) {
        return null;
      }

      return {
        ...attachment,
        size: response.data.size ?? attachment.size,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Get threadIds for a list of messageIds.
   * Used by archive operations to convert message-level to thread-level operations.
   */
  async function getThreadIdsForMessages(
    mcpUserId: string,
    messageIds: string[],
    email?: string
  ): Promise<string[]> {
    const gmail = await getGmailClient(mcpUserId, email);
    const threadIds: Set<string> = new Set();

    for (const messageId of messageIds) {
      try {
        const response = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'minimal',
          fields: 'threadId',
        });
        if (response.data.threadId) {
          threadIds.add(response.data.threadId);
        }
      } catch (error) {
        // If message not found, skip it (it may have been deleted)
        const gmailError = error as { code?: number };
        if (gmailError.code !== 404) {
          throw wrapGmailError(error);
        }
      }
    }

    return Array.from(threadIds);
  }

  /**
   * Check if user has the required scope.
   */
  async function checkScope(mcpUserId: string, requiredScope: string, email?: string): Promise<void> {
    const credentials = await getValidCredentials(mcpUserId, email);
    const grantedScopes = credentials.scope.split(' ');

    if (!grantedScopes.includes(requiredScope)) {
      throw new InsufficientScopeError('gmail.labels');
    }
  }

  /**
   * Modify labels on a single message.
   */
  async function modifyMessage(
    mcpUserId: string,
    messageId: string,
    addLabels: string[],
    removeLabels: string[],
    email?: string
  ): Promise<ModifyResult> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: addLabels,
          removeLabelIds: removeLabels,
        },
      });
      return { id: messageId, success: true };
    } catch (error: unknown) {
      const wrapped = wrapGmailError(error);
      return { id: messageId, success: false, error: wrapped.message };
    }
  }

  /**
   * Modify labels on a thread (affects all messages in thread).
   */
  async function modifyThread(
    mcpUserId: string,
    threadId: string,
    addLabels: string[],
    removeLabels: string[],
    email?: string
  ): Promise<ModifyResult> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: {
          addLabelIds: addLabels,
          removeLabelIds: removeLabels,
        },
      });
      return { id: threadId, success: true };
    } catch (error: unknown) {
      const wrapped = wrapGmailError(error);
      return { id: threadId, success: false, error: wrapped.message };
    }
  }

  /**
   * Batch modify labels on messages and/or threads.
   *
   * Thread vs Message semantics:
   * - messageIds: Modifies only the specified messages
   * - threadIds: Modifies ALL messages in the specified threads
   *
   * For inbox operations (archive/unarchive), prefer threadIds because Gmail's
   * inbox view is thread-based. A thread appears in inbox if ANY message has the INBOX label.
   */
  async function batchModify(
    mcpUserId: string,
    messageIds: string[] | undefined,
    threadIds: string[] | undefined,
    addLabels: string[],
    removeLabels: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    // Check scope once before processing
    // Note: gmail.modify scope is required to add/remove labels on messages
    await checkScope(mcpUserId, GMAIL_MODIFY_SCOPE, email);

    const results: ModifyResult[] = [];

    // Process messages
    if (messageIds) {
      for (const id of messageIds) {
        const gmail = await getGmailClient(mcpUserId, email);
        try {
          await gmail.users.messages.modify({
            userId: 'me',
            id,
            requestBody: {
              addLabelIds: addLabels,
              removeLabelIds: removeLabels,
            },
          });
          results.push({ id, success: true });
        } catch (error: unknown) {
          const wrapped = wrapGmailError(error);
          results.push({ id, success: false, error: wrapped.message });
        }
      }
    }

    // Process threads
    if (threadIds) {
      for (const id of threadIds) {
        const gmail = await getGmailClient(mcpUserId, email);
        try {
          await gmail.users.threads.modify({
            userId: 'me',
            id,
            requestBody: {
              addLabelIds: addLabels,
              removeLabelIds: removeLabels,
            },
          });
          results.push({ id, success: true });
        } catch (error: unknown) {
          const wrapped = wrapGmailError(error);
          results.push({ id, success: false, error: wrapped.message });
        }
      }
    }

    return {
      results,
      successCount: results.filter(r => r.success).length,
      failureCount: results.filter(r => !r.success).length,
    };
  }

  // Convenience methods for common operations

  /**
   * Archive messages and/or threads (remove INBOX label).
   *
   * IMPORTANT: Gmail's inbox is thread-based. A thread remains in the inbox if ANY
   * message in that thread has the INBOX label. For reliable archiving, prefer using
   * threadIds or use the MCP tool with archiveEntireThread=true (default).
   */
  async function archiveMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['INBOX'], email);
  }

  /**
   * Unarchive messages and/or threads (add INBOX label).
   *
   * For consistency, prefer using threadIds or use the MCP tool with
   * archiveEntireThread=true (default) to restore entire conversations.
   */
  async function unarchiveMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['INBOX'], [], email);
  }

  async function markAsRead(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['UNREAD'], email);
  }

  async function markAsUnread(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['UNREAD'], [], email);
  }

  async function starMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['STARRED'], [], email);
  }

  async function unstarMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['STARRED'], email);
  }

  // ============== LABEL METHODS ==============

  /**
   * Get information about a label including message counts.
   */
  async function getLabelInfo(mcpUserId: string, labelId: string, email?: string): Promise<LabelInfo> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.labels.get({
        userId: 'me',
        id: labelId,
      });

      const label = response.data;
      return {
        id: label.id!,
        name: label.name!,
        messagesTotal: label.messagesTotal ?? 0,
        messagesUnread: label.messagesUnread ?? 0,
        threadsTotal: label.threadsTotal ?? 0,
        threadsUnread: label.threadsUnread ?? 0,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * List all labels.
   */
  async function listLabels(mcpUserId: string, email?: string): Promise<LabelInfo[]> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.labels.list({
        userId: 'me',
      });

      const labels = response.data.labels ?? [];

      // Fetch full info for each label to get counts
      const labelInfos: LabelInfo[] = [];
      for (const label of labels) {
        if (label.id) {
          try {
            const info = await getLabelInfo(mcpUserId, label.id, email);
            labelInfos.push(info);
          } catch {
            // Skip labels that fail (e.g., system labels without counts)
            labelInfos.push({
              id: label.id,
              name: label.name ?? label.id,
              messagesTotal: 0,
              messagesUnread: 0,
              threadsTotal: 0,
              threadsUnread: 0,
            });
          }
        }
      }

      return labelInfos;
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Add labels to messages/threads.
   */
  async function addLabels(
    mcpUserId: string,
    messageIds: string[] | undefined,
    threadIds: string[] | undefined,
    labelIds: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, labelIds, [], email);
  }

  /**
   * Remove labels from messages/threads.
   */
  async function removeLabels(
    mcpUserId: string,
    messageIds: string[] | undefined,
    threadIds: string[] | undefined,
    labelIds: string[],
    email?: string
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], labelIds, email);
  }

  /**
   * Create a new label.
   */
  async function createLabel(
    mcpUserId: string,
    name: string,
    email?: string
  ): Promise<{ id: string; name: string }> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });

      return {
        id: response.data.id!,
        name: response.data.name!,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  // ============== DRAFT METHODS ==============

  /**
   * Create a new draft email.
   * When replyToMessageId is provided, the draft will be threaded as a reply
   * with proper In-Reply-To and References headers.
   */
  async function createDraft(
    mcpUserId: string,
    to: string | string[],
    subject: string,
    body: string,
    options?: {
      cc?: string | string[];
      bcc?: string | string[];
      isHtml?: boolean;
      replyToMessageId?: string;
    },
    email?: string
  ): Promise<{ draftId: string; messageId: string }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    // Threading headers for replies
    let inReplyTo = '';
    let references = '';
    let threadId: string | undefined;

    if (options?.replyToMessageId) {
      // Fetch the original message to get threading headers
      const originalMsg = await gmail.users.messages.get({
        userId: 'me',
        id: options.replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });

      threadId = originalMsg.data.threadId ?? undefined;

      // Extract Message-ID from original
      const messageIdHeader = originalMsg.data.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === 'message-id'
      );
      if (messageIdHeader?.value) {
        inReplyTo = messageIdHeader.value;

        // Build References: existing references + original message-id
        const referencesHeader = originalMsg.data.payload?.headers?.find(
          (h) => h.name?.toLowerCase() === 'references'
        );
        if (referencesHeader?.value) {
          references = `${referencesHeader.value} ${inReplyTo}`;
        } else {
          references = inReplyTo;
        }
      }
    }

    // Build email headers
    const toAddrs = Array.isArray(to) ? to.join(', ') : to;
    const ccAddrs = options?.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : '';
    const bccAddrs = options?.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : '';

    const contentType = options?.isHtml ? 'text/html' : 'text/plain';

    // Build raw email
    let rawEmail = `To: ${toAddrs}\r\n`;
    if (ccAddrs) rawEmail += `Cc: ${ccAddrs}\r\n`;
    if (bccAddrs) rawEmail += `Bcc: ${bccAddrs}\r\n`;
    if (inReplyTo) rawEmail += `In-Reply-To: ${inReplyTo}\r\n`;
    if (references) rawEmail += `References: ${references}\r\n`;
    rawEmail += `Subject: ${subject}\r\n`;
    rawEmail += `Content-Type: ${contentType}; charset=utf-8\r\n\r\n`;
    rawEmail += body;

    // Base64url encode
    const encodedEmail = Buffer.from(rawEmail).toString('base64url');

    try {
      const response = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedEmail,
            threadId,
          },
        },
      });

      return {
        draftId: response.data.id!,
        messageId: response.data.message?.id ?? '',
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * List drafts.
   */
  async function listDrafts(
    mcpUserId: string,
    maxResults: number = 20,
    pageToken?: string,
    email?: string
  ): Promise<DraftListResult> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.drafts.list({
        userId: 'me',
        maxResults,
        pageToken,
      });

      const drafts: DraftInfo[] = [];
      for (const draft of response.data.drafts ?? []) {
        // Fetch draft details to get snippet/subject
        if (draft.id) {
          try {
            const draftDetail = await gmail.users.drafts.get({
              userId: 'me',
              id: draft.id,
              format: 'metadata',
            });

            const message = draftDetail.data.message;
            const headers = message?.payload?.headers ?? [];
            const subjectHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'subject');
            const toHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'to');

            drafts.push({
              id: draft.id,
              messageId: message?.id ?? '',
              snippet: message?.snippet ?? '',
              subject: subjectHeader?.value ?? undefined,
              to: toHeader?.value ?? undefined,
            });
          } catch {
            drafts.push({
              id: draft.id,
              messageId: draft.message?.id ?? '',
              snippet: '',
            });
          }
        }
      }

      return {
        drafts,
        nextPageToken: response.data.nextPageToken ?? undefined,
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Get a draft with full content.
   */
  async function getDraft(mcpUserId: string, draftId: string, email?: string): Promise<DraftContent> {
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      const response = await gmail.users.drafts.get({
        userId: 'me',
        id: draftId,
        format: 'full',
      });

      const message = response.data.message;
      const headers = message?.payload?.headers ?? [];
      const subjectHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'subject');
      const toHeader = headers.find((h: gmail_v1.Schema$MessagePartHeader) => h.name?.toLowerCase() === 'to');

      return {
        id: response.data.id!,
        messageId: message?.id ?? '',
        snippet: message?.snippet ?? '',
        subject: subjectHeader?.value ?? undefined,
        to: toHeader?.value ?? undefined,
        body: extractBody(message?.payload),
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Update a draft.
   * When replyToMessageId is provided, the draft will be threaded as a reply
   * with proper In-Reply-To and References headers.
   */
  async function updateDraft(
    mcpUserId: string,
    draftId: string,
    to: string | string[],
    subject: string,
    body: string,
    options?: {
      cc?: string | string[];
      bcc?: string | string[];
      isHtml?: boolean;
      replyToMessageId?: string;
    },
    email?: string
  ): Promise<{ draftId: string; messageId: string }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    // Threading headers for replies
    let inReplyTo = '';
    let references = '';
    let threadId: string | undefined;

    if (options?.replyToMessageId) {
      // Fetch the original message to get threading headers
      const originalMsg = await gmail.users.messages.get({
        userId: 'me',
        id: options.replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });

      threadId = originalMsg.data.threadId ?? undefined;

      // Extract Message-ID from original
      const messageIdHeader = originalMsg.data.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === 'message-id'
      );
      if (messageIdHeader?.value) {
        inReplyTo = messageIdHeader.value;

        // Build References: existing references + original message-id
        const referencesHeader = originalMsg.data.payload?.headers?.find(
          (h) => h.name?.toLowerCase() === 'references'
        );
        if (referencesHeader?.value) {
          references = `${referencesHeader.value} ${inReplyTo}`;
        } else {
          references = inReplyTo;
        }
      }
    }

    const toAddrs = Array.isArray(to) ? to.join(', ') : to;
    const ccAddrs = options?.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : '';
    const bccAddrs = options?.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : '';
    const contentType = options?.isHtml ? 'text/html' : 'text/plain';

    let rawEmail = `To: ${toAddrs}\r\n`;
    if (ccAddrs) rawEmail += `Cc: ${ccAddrs}\r\n`;
    if (bccAddrs) rawEmail += `Bcc: ${bccAddrs}\r\n`;
    if (inReplyTo) rawEmail += `In-Reply-To: ${inReplyTo}\r\n`;
    if (references) rawEmail += `References: ${references}\r\n`;
    rawEmail += `Subject: ${subject}\r\n`;
    rawEmail += `Content-Type: ${contentType}; charset=utf-8\r\n\r\n`;
    rawEmail += body;

    const encodedEmail = Buffer.from(rawEmail).toString('base64url');

    try {
      const response = await gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: {
          message: {
            raw: encodedEmail,
            threadId,
          },
        },
      });

      return {
        draftId: response.data.id!,
        messageId: response.data.message?.id ?? '',
      };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  /**
   * Delete a draft.
   */
  async function deleteDraft(mcpUserId: string, draftId: string, email?: string): Promise<{ success: boolean }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE, email);
    const gmail = await getGmailClient(mcpUserId, email);

    try {
      await gmail.users.drafts.delete({
        userId: 'me',
        id: draftId,
      });

      return { success: true };
    } catch (error: unknown) {
      throw wrapGmailError(error);
    }
  }

  // ============== ACCOUNT MANAGEMENT METHODS ==============

  /**
   * List all connected Gmail accounts for the user.
   */
  async function listAccounts(mcpUserId: string): Promise<AccountInfo[]> {
    return tokenStore.listAccounts(mcpUserId);
  }

  /**
   * Set which account is the default for the user.
   */
  async function setDefaultAccount(mcpUserId: string, accountEmail: string): Promise<void> {
    await tokenStore.setDefaultAccount(mcpUserId, accountEmail);
  }

  /**
   * Remove a specific Gmail account.
   */
  async function removeAccount(mcpUserId: string, accountEmail: string): Promise<void> {
    await tokenStore.deleteCredentials(mcpUserId, accountEmail);
  }

  return {
    getValidCredentials,
    searchMessages,
    getMessage,
    listThreads,
    getThread,
    getAttachmentMetadata,
    getThreadIdsForMessages,
    // Modification methods
    checkScope,
    modifyMessage,
    modifyThread,
    batchModify,
    archiveMessages,
    unarchiveMessages,
    markAsRead,
    markAsUnread,
    starMessages,
    unstarMessages,
    // Label methods
    getLabelInfo,
    listLabels,
    addLabels,
    removeLabels,
    createLabel,
    // Draft methods
    createDraft,
    listDrafts,
    getDraft,
    updateDraft,
    deleteDraft,
    // Account management methods
    listAccounts,
    setDefaultAccount,
    removeAccount,
  };
}

// Helper functions

function extractHeaders(headers: gmail_v1.Schema$MessagePartHeader[]): MessageMetadata['headers'] {
  const result: MessageMetadata['headers'] = {};

  for (const header of headers) {
    const name = header.name?.toLowerCase();
    const value = header.value;

    if (name === 'from') result.from = value ?? undefined;
    if (name === 'to') result.to = value ?? undefined;
    if (name === 'subject') result.subject = value ?? undefined;
    if (name === 'date') result.date = value ?? undefined;
  }

  return result;
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentMetadata[] {
  const attachments: AttachmentMetadata[] = [];

  if (!payload) return attachments;

  function processPartRecursive(part: gmail_v1.Schema$MessagePart) {
    if (part.body?.attachmentId && part.filename) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
      });
    }

    if (part.parts) {
      for (const subPart of part.parts) {
        processPartRecursive(subPart);
      }
    }
  }

  processPartRecursive(payload);
  return attachments;
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): { text?: string; html?: string } {
  const result: { text?: string; html?: string } = {};

  if (!payload) return result;

  function processPartRecursive(part: gmail_v1.Schema$MessagePart) {
    const mimeType = part.mimeType ?? '';
    const data = part.body?.data;

    if (data) {
      const decoded = Buffer.from(data, 'base64').toString('utf-8');

      if (mimeType === 'text/plain' && !result.text) {
        result.text = decoded;
      } else if (mimeType === 'text/html' && !result.html) {
        result.html = decoded;
      }
    }

    if (part.parts) {
      for (const subPart of part.parts) {
        processPartRecursive(subPart);
      }
    }
  }

  processPartRecursive(payload);
  return result;
}

function wrapGmailError(error: unknown): GmailApiError {
  if (error instanceof GmailApiError || error instanceof NotAuthorizedError) {
    throw error;
  }

  const gmailError = error as { code?: number; message?: string };
  const statusCode = gmailError.code ?? 500;
  const message = gmailError.message ?? 'Gmail API error';

  return new GmailApiError(message, statusCode);
}

export type GmailClient = ReturnType<typeof createGmailClientFactory>;
