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
import type { TokenStore, GmailCredentials } from '../store/interface.js';
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
   */
  async function getValidCredentials(mcpUserId: string): Promise<GmailCredentials> {
    const credentials = await tokenStore.getCredentials(mcpUserId);

    if (!credentials) {
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

      // Check for revocation
      if (errorMessage.includes('invalid_grant')) {
        await tokenStore.deleteCredentials(credentials.mcpUserId);
        throw new NotAuthorizedError('Gmail access revoked. Please re-authorize.');
      }

      throw new GmailApiError(`Token refresh failed: ${errorMessage}`);
    }
  }

  /**
   * Create an authenticated Gmail client for a user.
   */
  async function getGmailClient(mcpUserId: string): Promise<gmail_v1.Gmail> {
    const credentials = await getValidCredentials(mcpUserId);

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
    pageToken?: string
  ): Promise<SearchResult> {
    const gmail = await getGmailClient(mcpUserId);

    try {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
        pageToken,
      });

      const messageList = response.data.messages ?? [];

      // Fetch metadata for each message
      const messages: SearchResultMessage[] = [];
      for (const m of messageList) {
        if (!m.id || !m.threadId) continue;

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
    format: 'metadata' | 'full' = 'metadata'
  ): Promise<MessageMetadata | MessageFull> {
    const gmail = await getGmailClient(mcpUserId);

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
    pageToken?: string
  ): Promise<ThreadResult> {
    const gmail = await getGmailClient(mcpUserId);

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
    format: 'metadata' | 'full' = 'metadata'
  ): Promise<Array<MessageMetadata | MessageFull>> {
    const gmail = await getGmailClient(mcpUserId);

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
    attachmentId: string
  ): Promise<AttachmentMetadata | null> {
    const gmail = await getGmailClient(mcpUserId);

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
   * Check if user has the required scope.
   */
  async function checkScope(mcpUserId: string, requiredScope: string): Promise<void> {
    const credentials = await getValidCredentials(mcpUserId);
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
    removeLabels: string[]
  ): Promise<ModifyResult> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

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
    removeLabels: string[]
  ): Promise<ModifyResult> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

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
   * Batch modify messages and/or threads.
   */
  async function batchModify(
    mcpUserId: string,
    messageIds: string[] | undefined,
    threadIds: string[] | undefined,
    addLabels: string[],
    removeLabels: string[]
  ): Promise<BatchModifyResult> {
    // Check scope once before processing
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE);

    const results: ModifyResult[] = [];

    // Process messages
    if (messageIds) {
      for (const id of messageIds) {
        const gmail = await getGmailClient(mcpUserId);
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
        const gmail = await getGmailClient(mcpUserId);
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

  async function archiveMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['INBOX']);
  }

  async function unarchiveMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['INBOX'], []);
  }

  async function markAsRead(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['UNREAD']);
  }

  async function markAsUnread(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['UNREAD'], []);
  }

  async function starMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, ['STARRED'], []);
  }

  async function unstarMessages(
    mcpUserId: string,
    messageIds?: string[],
    threadIds?: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], ['STARRED']);
  }

  // ============== LABEL METHODS ==============

  /**
   * Get information about a label including message counts.
   */
  async function getLabelInfo(mcpUserId: string, labelId: string): Promise<LabelInfo> {
    const gmail = await getGmailClient(mcpUserId);

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
  async function listLabels(mcpUserId: string): Promise<LabelInfo[]> {
    const gmail = await getGmailClient(mcpUserId);

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
            const info = await getLabelInfo(mcpUserId, label.id);
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
    labelIds: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, labelIds, []);
  }

  /**
   * Remove labels from messages/threads.
   */
  async function removeLabels(
    mcpUserId: string,
    messageIds: string[] | undefined,
    threadIds: string[] | undefined,
    labelIds: string[]
  ): Promise<BatchModifyResult> {
    return batchModify(mcpUserId, messageIds, threadIds, [], labelIds);
  }

  /**
   * Create a new label.
   */
  async function createLabel(
    mcpUserId: string,
    name: string
  ): Promise<{ id: string; name: string }> {
    await checkScope(mcpUserId, GMAIL_LABELS_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

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
    }
  ): Promise<{ draftId: string; messageId: string }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

    // Build email headers
    const toAddrs = Array.isArray(to) ? to.join(', ') : to;
    const ccAddrs = options?.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : '';
    const bccAddrs = options?.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : '';

    const contentType = options?.isHtml ? 'text/html' : 'text/plain';

    // Build raw email
    let email = `To: ${toAddrs}\r\n`;
    if (ccAddrs) email += `Cc: ${ccAddrs}\r\n`;
    if (bccAddrs) email += `Bcc: ${bccAddrs}\r\n`;
    email += `Subject: ${subject}\r\n`;
    email += `Content-Type: ${contentType}; charset=utf-8\r\n\r\n`;
    email += body;

    // Base64url encode
    const encodedEmail = Buffer.from(email).toString('base64url');

    try {
      const response = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedEmail,
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
    pageToken?: string
  ): Promise<DraftListResult> {
    const gmail = await getGmailClient(mcpUserId);

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
  async function getDraft(mcpUserId: string, draftId: string): Promise<DraftContent> {
    const gmail = await getGmailClient(mcpUserId);

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
    }
  ): Promise<{ draftId: string; messageId: string }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

    const toAddrs = Array.isArray(to) ? to.join(', ') : to;
    const ccAddrs = options?.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : '';
    const bccAddrs = options?.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : '';
    const contentType = options?.isHtml ? 'text/html' : 'text/plain';

    let email = `To: ${toAddrs}\r\n`;
    if (ccAddrs) email += `Cc: ${ccAddrs}\r\n`;
    if (bccAddrs) email += `Bcc: ${bccAddrs}\r\n`;
    email += `Subject: ${subject}\r\n`;
    email += `Content-Type: ${contentType}; charset=utf-8\r\n\r\n`;
    email += body;

    const encodedEmail = Buffer.from(email).toString('base64url');

    try {
      const response = await gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: {
          message: {
            raw: encodedEmail,
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
  async function deleteDraft(mcpUserId: string, draftId: string): Promise<{ success: boolean }> {
    await checkScope(mcpUserId, GMAIL_COMPOSE_SCOPE);
    const gmail = await getGmailClient(mcpUserId);

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

  return {
    getValidCredentials,
    searchMessages,
    getMessage,
    listThreads,
    getThread,
    getAttachmentMetadata,
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
