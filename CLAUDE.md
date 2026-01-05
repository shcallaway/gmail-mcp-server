# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run start          # Run compiled server
npm run dev            # Dev mode with hot reload (tsx watch)
npm run test           # Run unit tests (vitest)
npm run test:coverage  # Tests with coverage report
npm run lint           # ESLint
npm run typecheck      # Type checking only
```

Run a single test file: `npx vitest run tests/unit/crypto.test.ts`

## Architecture Overview

This is an MCP (Model Context Protocol) server that exposes Gmail inbox tools via Streamable HTTP transport. It implements two-layer OAuth: MCP-level JWT authentication and Google OAuth for Gmail access. Supports **multi-inbox**: users can connect multiple Gmail accounts and switch between them.

### Core Data Flow

```
MCP Client → Fastify HTTP (/mcp) → MCP Server → Gmail Client → Google APIs
                ↓
        Token Store (SQLite) ← encrypted credentials
```

### Key Modules

- **`src/index.ts`** - Entry point; initializes config, token store, MCP server, HTTP server
- **`src/config.ts`** - Zod-validated environment configuration with lazy initialization
- **`src/http/server.ts`** - Fastify server exposing `/mcp`, `/oauth/*`, `/healthz`, `/.well-known/*`
- **`src/mcp/server.ts`** - MCP server with 26 tools registered; validates inputs with Zod schemas
- **`src/gmail/client.ts`** - Gmail API wrapper with token refresh logic (5-min threshold, exponential backoff)
- **`src/auth/mcpOAuth.ts`** - MCP-level OAuth: JWT issuance, validation, discovery endpoints
- **`src/auth/googleOAuth.ts`** - Google OAuth flow with PKCE support and state management
- **`src/store/sqlite.ts`** - SQLite token store with composite key `(mcp_user_id, email)` for multi-account; refresh tokens encrypted with AES-256-GCM

### Authentication Layers

1. **MCP-level**: JWT access tokens (HS256, 1hr lifetime) with `sub` claim as user identity
2. **Gmail-level**: Google OAuth tokens stored per MCP user; supports readonly, labels, modify, compose scopes

### Multi-Account Support

- Users can connect multiple Gmail accounts per MCP user ID
- First account becomes the default automatically
- All tools accept optional `email` parameter to target specific account (defaults to default account)
- `gmail.listAccounts` lists connected accounts; `gmail.setDefaultAccount` changes default; `gmail.removeAccount` disconnects an account
- Database uses composite primary key `(mcp_user_id, email)`

### Tool Categories (26 tools)

- Status/Auth: `gmail.status`, `gmail.authorize`
- Account Management: `gmail.listAccounts`, `gmail.setDefaultAccount`, `gmail.removeAccount`
- Read: `gmail.searchMessages`, `gmail.getMessage`, `gmail.listThreads`, `gmail.getThread`, `gmail.getAttachmentMetadata`
- Labels: `gmail.getLabelInfo`, `gmail.listLabels`, `gmail.addLabels`, `gmail.removeLabels`, `gmail.createLabel`
- Modifications: `gmail.archiveMessages`, `gmail.unarchiveMessages`, `gmail.markAsRead`, `gmail.markAsUnread`, `gmail.starMessages`, `gmail.unstarMessages`
- Drafts: `gmail.createDraft`, `gmail.listDrafts`, `gmail.getDraft`, `gmail.updateDraft`, `gmail.deleteDraft`

### Error Handling Pattern

Custom error classes in `src/utils/errors.ts` map to MCP JSON-RPC codes:
- `NotAuthorizedError` / `InsufficientScopeError` → -32001
- `InvalidArgumentError` / `AccountNotFoundError` → -32602
- `GmailApiError` / `RateLimitedError` → -32000

### Required Environment Variables

See `.env.example`. Key variables: `PORT`, `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `JWT_SECRET`

### Token Refresh Behavior

Gmail client proactively refreshes access tokens 5 minutes before expiry. On `invalid_grant` (revocation), tokens are cleared and user must re-authorize. Transient errors retry with exponential backoff (max 3 attempts).

### Thread vs Message Semantics

Gmail's inbox is **thread-based**. Important implications:

1. **Inbox visibility**: A thread appears in inbox if ANY message has the `INBOX` label
2. **Archive behavior**: To remove a thread from inbox, ALL messages must be archived
3. **API operations**:
   - `messageIds` - operates on individual messages
   - `threadIds` - operates on all messages in the thread

**Recommendation for archive operations**: Use `threadIds` or rely on the default `archiveEntireThread=true` behavior.

### Archive/Unarchive Parameters

| Tool | Parameter | Default | Behavior |
|------|-----------|---------|----------|
| `archiveMessages` | `archiveEntireThread` | `true` | Converts messageIds to threadIds automatically |
| `unarchiveMessages` | `archiveEntireThread` | `true` | Converts messageIds to threadIds automatically |

Set `archiveEntireThread=false` to archive only specific messages (thread may remain in inbox).

### Search Results

`searchMessages` returns `threadMessageCount` for each result, indicating how many messages are in that thread. This helps identify multi-message conversations for thread-aware operations.

### Superhuman and Gmail Integration

Superhuman is an email client that uses Gmail as its backend. Understanding this relationship is important when working with Gmail data:

**How Superhuman Uses Gmail Labels:**

Superhuman creates `[Superhuman]/*` labels in Gmail to manage inbox organization:

| Label | Purpose |
|-------|---------|
| `[Superhuman]/AI/Respond` | Emails requiring a response (shown in main inbox) |
| `[Superhuman]/AI/Meeting` | Meeting-related emails (shown in main inbox) |
| `[Superhuman]/AI/Waiting` | Emails you're waiting on (shown in main inbox) |
| `[Superhuman]/AI/Marketing` | Marketing emails (routed to "Other" feed) |
| `[Superhuman]/AI/Newsletter` | Newsletters (routed to "Other" feed) |
| `[Superhuman]/AI/News` | News updates (routed to "Other" feed) |
| `[Superhuman]/AI/notification` | Notifications (routed to "Other" feed) |
| `[Superhuman]/AI/Pitch` | Sales pitches (routed to "Other" feed) |
| `[Superhuman]/AI/cold_outreach` | Cold outreach (routed to "Other" feed) |
| `[Superhuman]/AI/Social` | Social updates (routed to "Other" feed) |
| `[Superhuman]/Is Snoozed` | Snoozed emails |
| `[Superhuman]/Muted` | Muted threads |
| `[Superhuman]/AI/AutoArchived` | Auto-archived by Superhuman AI |

**Split Inbox Behavior:**

Superhuman's "Split Inbox" feature uses these AI labels to filter the inbox view:
- **Main Inbox**: Only shows `Respond`, `Meeting`, `Waiting` labeled emails
- **Other Feed**: Contains `Marketing`, `Newsletter`, `News`, `notification`, etc.
- **Hidden**: `Muted` and `AutoArchived` emails are suppressed

**Why Gmail Inbox Count Differs from Superhuman:**

Gmail's INBOX label count includes ALL emails with that label, but Superhuman only displays a subset in the main view. For example:
- Gmail INBOX: 914 messages
- Superhuman main view: ~300 messages (Respond + Meeting + Waiting)
- Superhuman "Other" feed: ~600 messages (Marketing, Newsletter, etc.)

**Implications for This MCP Server:**

When using `gmail.searchMessages` with `in:inbox`, results include ALL inbox emails regardless of Superhuman's AI categorization. To match Superhuman's main inbox view, filter by Superhuman labels:
- `in:inbox label:[Superhuman]/AI/Respond` - emails needing response
- `in:inbox -label:[Superhuman]/AI/Marketing -label:[Superhuman]/AI/Newsletter` - exclude "Other" feed items

**Draft Threading Limitation:**

Drafts created via the Gmail API (using `gmail.createDraft` with `replyToMessageId`) are properly threaded in Gmail but **do not appear inline in Superhuman threads**. This is a Superhuman UI limitation:

- **Gmail behavior**: API-created drafts with correct `In-Reply-To`, `References` headers, and `threadId` appear inline in the thread view
- **Superhuman behavior**: These drafts only appear in the Drafts folder (Cmd+9), not inline in the thread. Superhuman only shows drafts inline when created through its own Reply flow.

**Workarounds for Superhuman users:**
1. Send the draft from Gmail web - it will thread correctly when sent
2. Open the draft from Superhuman's Drafts folder and send from there
3. Copy the draft text and use Superhuman's native Reply to compose inline
