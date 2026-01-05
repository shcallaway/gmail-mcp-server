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
import { NotAuthorizedError, GmailApiError } from '../utils/errors.js';

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

export interface SearchResult {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

export interface ThreadResult {
  threads: Array<{ id: string; snippet?: string }>;
  nextPageToken?: string;
}

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

      return {
        messages: (response.data.messages ?? []).map(m => ({
          id: m.id!,
          threadId: m.threadId!,
        })),
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

  return {
    getValidCredentials,
    searchMessages,
    getMessage,
    listThreads,
    getThread,
    getAttachmentMetadata,
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
