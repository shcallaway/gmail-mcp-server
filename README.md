# Gmail MCP Server

An MCP (Model Context Protocol) server that exposes Gmail tools via Streamable HTTP transport. Enables AI assistants to read, search, organize, and draft emails.

## Features

- **26 Gmail tools** for reading, searching, labeling, archiving, and drafting emails
- **Multi-inbox support** - connect multiple Gmail accounts per user
- **Two-layer OAuth** - MCP-level JWT authentication + Google OAuth for Gmail
- **Secure storage** - refresh tokens encrypted with AES-256-GCM
- **Automatic token refresh** - proactive refresh 5 minutes before expiry
- **Thread-aware operations** - archive entire conversations by default

## Quickstart

```bash
git clone https://github.com/shcallaway/gmail-mcp-server.git
cd gmail-mcp-server

# Generate secrets and create .env
npm run bin:generate-secrets
# Add your Google OAuth credentials to .env

# Start with Docker
npm run docker:up
```

Server runs at `http://localhost:3000`. See [Google Cloud Setup](#google-cloud-setup) for OAuth credentials.

## Requirements

- Node.js >= 20.0.0
- Google Cloud project with Gmail API enabled
- OAuth 2.0 credentials (Web application type)

## Google Cloud Setup

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)

2. Enable the Gmail API: APIs & Services > Library > search "Gmail API" > Enable

3. Configure OAuth consent screen:
   - APIs & Services > OAuth consent screen
   - Choose "External" user type
   - Add scopes: `gmail.readonly`, `gmail.labels`, `gmail.modify`, `gmail.compose`
   - Add test users

4. Create OAuth credentials:
   - APIs & Services > Credentials > Create Credentials > OAuth client ID
   - Application type: Web application
   - Authorized redirect URI: `http://localhost:3000/oauth/callback`

5. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   OAUTH_REDIRECT_URI=http://localhost:3000/oauth/callback
   ```

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `BASE_URL` | Public URL of the server |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `OAUTH_REDIRECT_URI` | OAuth callback URL |
| `TOKEN_ENCRYPTION_KEY` | 32+ character key for encrypting stored tokens |
| `JWT_SECRET` | Secret for signing MCP-level JWTs |

### Optional Variables

| Variable | Description |
|----------|-------------|
| `DB_URL` | SQLite database path (default: `./data/gmail-mcp.db`) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |

### Generating Secrets

```bash
npm run bin:generate-secrets
```

## Running the Server

### Development

```bash
npm install
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Docker

```bash
npm run docker:up       # Start container
npm run docker:down     # Stop container
npm run docker:logs     # Tail logs
npm run docker:restart  # Restart container
npm run docker:build    # Rebuild image
```

Data persists in `./data/` via volume mount.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mcp` | MCP protocol endpoint |
| GET | `/healthz` | Health check |
| GET | `/oauth/start` | Initiate Gmail OAuth |
| GET | `/oauth/callback` | OAuth callback |

## Available Tools

All tools accept an optional `email` parameter to target a specific connected account.

### Authentication & Accounts

| Tool | Description |
|------|-------------|
| `gmail.status` | Check connection status and list accounts |
| `gmail.authorize` | Initiate OAuth flow to connect Gmail |
| `gmail.listAccounts` | List all connected accounts |
| `gmail.setDefaultAccount` | Set default account |
| `gmail.removeAccount` | Disconnect an account |

### Reading Messages

| Tool | Description |
|------|-------------|
| `gmail.searchMessages` | Search using Gmail query syntax |
| `gmail.getMessage` | Get a message by ID |
| `gmail.listThreads` | List conversation threads |
| `gmail.getThread` | Get all messages in a thread |
| `gmail.getAttachmentMetadata` | Get attachment info |

### Labels

| Tool | Description | Scope |
|------|-------------|-------|
| `gmail.listLabels` | List all labels | readonly |
| `gmail.getLabelInfo` | Get label details | readonly |
| `gmail.addLabels` | Add labels to messages/threads | labels |
| `gmail.removeLabels` | Remove labels | labels |
| `gmail.createLabel` | Create custom label | labels |

### Message Organization

| Tool | Description | Scope |
|------|-------------|-------|
| `gmail.archiveMessages` | Archive messages/threads | modify |
| `gmail.unarchiveMessages` | Move back to inbox | modify |
| `gmail.markAsRead` | Mark as read | labels |
| `gmail.markAsUnread` | Mark as unread | labels |
| `gmail.starMessages` | Add star | labels |
| `gmail.unstarMessages` | Remove star | labels |

**Note:** Archive operations are thread-aware by default. Set `archiveEntireThread: false` to archive individual messages only.

### Drafts

| Tool | Description | Scope |
|------|-------------|-------|
| `gmail.createDraft` | Create a draft | compose |
| `gmail.listDrafts` | List drafts | readonly |
| `gmail.getDraft` | Get draft content | readonly |
| `gmail.updateDraft` | Update a draft | compose |
| `gmail.deleteDraft` | Delete a draft | compose |

Draft tools support `replyToMessageId` for proper email threading.

## OAuth Scopes

Request scopes when calling `gmail.authorize`:

| Scope | Permissions |
|-------|-------------|
| `gmail.readonly` | Read messages, threads, labels |
| `gmail.labels` | Manage labels, star, mark read/unread |
| `gmail.modify` | Archive/unarchive messages |
| `gmail.compose` | Create, update, delete drafts |

```json
{ "scopes": ["gmail.readonly", "gmail.modify", "gmail.compose"] }
```

## Multi-Inbox Support

Connect multiple Gmail accounts per user. The first account becomes the default.

### Targeting Accounts

All tools accept an optional `email` parameter:

```json
{ "query": "is:unread", "email": "work@example.com" }
```

### Managing Accounts

```json
// List accounts
{ "tool": "gmail.listAccounts" }

// Change default
{ "tool": "gmail.setDefaultAccount", "email": "work@example.com" }

// Disconnect
{ "tool": "gmail.removeAccount", "email": "old@example.com" }
```

## Architecture

```
MCP Client -> Fastify HTTP (/mcp) -> MCP Server -> Gmail Client -> Google APIs
                    |
            Token Store (SQLite) <- encrypted credentials
```

### Key Components

| Module | Purpose |
|--------|---------|
| `src/index.ts` | Entry point |
| `src/config.ts` | Zod-validated configuration |
| `src/http/server.ts` | Fastify HTTP server |
| `src/mcp/server.ts` | MCP server with 26 tools |
| `src/gmail/client.ts` | Gmail API wrapper with token refresh |
| `src/auth/mcpOAuth.ts` | MCP-level JWT authentication |
| `src/auth/googleOAuth.ts` | Google OAuth with PKCE |
| `src/store/sqlite.ts` | SQLite token storage with encryption |

## Development

```bash
npm test              # Run tests
npm run test:coverage # Tests with coverage
npm run typecheck     # Type checking
npm run lint          # ESLint

# Single test file
npx vitest run tests/unit/crypto.test.ts
```

## Claude Code Integration

This server includes Claude Code skills in `.claude/skills/` for enhanced Gmail workflows. Run `npm run bin:cc-install-mcp-server` to add the server to your Claude Code configuration.

## Error Handling

| Code | Type | Description |
|------|------|-------------|
| `-32001` | NOT_AUTHORIZED | Not authenticated or insufficient scope |
| `-32602` | INVALID_ARGUMENT | Invalid parameters or account not found |
| `-32000` | GMAIL_API_ERROR | Gmail API error or rate limit |

When Google returns `invalid_grant` (token revoked), stored tokens are cleared and re-authorization is required.

## Security

- Refresh tokens encrypted with AES-256-GCM
- MCP-level JWTs (HS256) with 1-hour lifetime
- Google OAuth with PKCE support
- CSRF protection via state parameter

## License

MIT
