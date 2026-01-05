# Gmail MCP Server

An MCP (Model Context Protocol) server that exposes Gmail tools via Streamable HTTP transport. Enables AI assistants to read, search, organize, and draft emails in your Gmail inbox.

## Quickstart

```bash
# Clone and setup
git clone https://github.com/shcallaway/gmail-mcp-server.git
cd gmail-mcp-server

# Generate secrets and create .env
./scripts/generate-secrets.sh
# Edit .env to add your Google OAuth credentials

# Run with Docker
./scripts/start.sh
```

Server runs at `http://localhost:3000`. Connect your Gmail at `/oauth/start`.

## Features

- **26 Gmail tools** for comprehensive inbox management
- **Multi-inbox support**: Connect multiple Gmail accounts per user
- **Two-layer OAuth**: MCP-level JWT authentication + Google OAuth for Gmail access
- **Secure token storage**: SQLite with AES-256-GCM encryption for refresh tokens
- **Streamable HTTP transport**: Stateless mode for easy deployment
- **Automatic token refresh**: Proactive refresh 5 minutes before expiry

## Requirements

- Node.js >= 20.0.0
- Google Cloud project with Gmail API enabled
- OAuth 2.0 credentials (Web application type)

## Installation

```bash
git clone <repository-url>
cd gmail-mcp
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `BASE_URL` | Public URL of the server |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `OAUTH_REDIRECT_URI` | OAuth callback URL (e.g., `http://localhost:3000/oauth/callback`) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key for encrypting stored tokens |
| `JWT_SECRET` | Secret for signing MCP-level JWTs |

### Optional Variables

| Variable | Description |
|----------|-------------|
| `DB_URL` | SQLite database path (default: `./data/gmail-mcp.db`) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |

### Generating Secrets

```bash
# Generate and optionally save to .env
./scripts/generate-secrets.sh

# Or use npm
npm run generate-secrets
```

## Running the Server

```bash
# Production
npm run build
npm start

# Development (with hot reload)
npm run dev
```

### Docker

The easiest way to deploy anywhere:

```bash
# Shell scripts (recommended)
./scripts/start.sh    # Start with health check and status
./scripts/stop.sh     # Stop the server

# npm scripts
npm run docker:up     # Start in background
npm run docker:down   # Stop
npm run docker:logs   # Tail logs
npm run docker:restart
npm run docker:build  # Rebuild image
```

Or run Docker commands directly:

```bash
docker compose up -d
docker compose down
```

The SQLite database persists in `./data/` via volume mount.

The server exposes:
- `POST /mcp` - MCP protocol endpoint
- `GET /healthz` - Health check
- `GET /oauth/start` - Initiate Gmail OAuth flow
- `GET /oauth/callback` - OAuth callback handler
- `GET /.well-known/oauth-protected-resource` - OAuth discovery

## Available Tools

All tools accept an optional `email` parameter to target a specific connected account. If omitted, the default account is used.

### Authentication & Accounts
| Tool | Description |
|------|-------------|
| `gmail.status` | Check connection status and list connected accounts |
| `gmail.authorize` | Initiate OAuth flow to connect Gmail |
| `gmail.listAccounts` | List all connected Gmail accounts |
| `gmail.setDefaultAccount` | Set which account is used by default |
| `gmail.removeAccount` | Disconnect a Gmail account |

### Reading Messages
| Tool | Description |
|------|-------------|
| `gmail.searchMessages` | Search using Gmail query syntax |
| `gmail.getMessage` | Get a single message by ID |
| `gmail.listThreads` | List conversation threads |
| `gmail.getThread` | Get all messages in a thread |
| `gmail.getAttachmentMetadata` | Get attachment info (filename, size, MIME type) |

### Labels
| Tool | Description | Scope Required |
|------|-------------|----------------|
| `gmail.listLabels` | List all labels with counts | - |
| `gmail.getLabelInfo` | Get label details | - |
| `gmail.addLabels` | Add labels to messages/threads | `gmail.labels` |
| `gmail.removeLabels` | Remove labels from messages/threads | `gmail.labels` |
| `gmail.createLabel` | Create a custom label | `gmail.labels` |

### Message Organization
| Tool | Description | Scope Required |
|------|-------------|----------------|
| `gmail.archiveMessages` | Archive messages/threads | `gmail.labels` |
| `gmail.unarchiveMessages` | Move back to inbox | `gmail.labels` |
| `gmail.markAsRead` | Mark as read | `gmail.labels` |
| `gmail.markAsUnread` | Mark as unread | `gmail.labels` |
| `gmail.starMessages` | Add star | `gmail.labels` |
| `gmail.unstarMessages` | Remove star | `gmail.labels` |

### Drafts
| Tool | Description | Scope Required |
|------|-------------|----------------|
| `gmail.createDraft` | Create a new draft | `gmail.compose` |
| `gmail.listDrafts` | List all drafts | - |
| `gmail.getDraft` | Get draft content | - |
| `gmail.updateDraft` | Update existing draft | `gmail.compose` |
| `gmail.deleteDraft` | Delete a draft | `gmail.compose` |

## OAuth Scopes

Request scopes when calling `gmail.authorize`:

| Scope | Permissions |
|-------|-------------|
| `gmail.readonly` | Read messages, threads, labels |
| `gmail.labels` | Modify labels, archive, star, mark read/unread |
| `gmail.compose` | Create, update, and delete drafts |

Example:
```json
{
  "scopes": ["gmail.readonly", "gmail.labels", "gmail.compose"]
}
```

## Multi-Inbox Support

Users can connect multiple Gmail accounts. The first connected account becomes the default.

### Connecting Additional Accounts

Call `gmail.authorize` again to connect another Gmail account. Each account can have different scopes.

### Targeting Specific Accounts

All tools accept an optional `email` parameter:

```json
{
  "query": "is:unread",
  "email": "work@example.com"
}
```

If `email` is omitted, the default account is used.

### Managing Accounts

```json
// List all connected accounts
{ "tool": "gmail.listAccounts" }

// Change default account
{ "tool": "gmail.setDefaultAccount", "email": "work@example.com" }

// Disconnect an account
{ "tool": "gmail.removeAccount", "email": "old@example.com" }
```

## Architecture

```
MCP Client → Fastify HTTP (/mcp) → MCP Server → Gmail Client → Google APIs
                    ↓
            Token Store (SQLite) ← encrypted credentials
```

### Key Components

- **`src/index.ts`** - Entry point
- **`src/config.ts`** - Zod-validated configuration
- **`src/http/server.ts`** - Fastify HTTP server
- **`src/mcp/server.ts`** - MCP server with all tools
- **`src/gmail/client.ts`** - Gmail API wrapper with token refresh
- **`src/auth/mcpOAuth.ts`** - MCP-level JWT authentication
- **`src/auth/googleOAuth.ts`** - Google OAuth flow with PKCE
- **`src/store/sqlite.ts`** - SQLite token storage with encryption (composite key for multi-account)

## Development

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type checking
npm run typecheck

# Linting
npm run lint

# Run single test file
npx vitest run tests/unit/crypto.test.ts
```

## Error Handling

The server uses JSON-RPC error codes:

| Code | Type | Description |
|------|------|-------------|
| `-32001` | `NOT_AUTHORIZED` | User not authenticated, token revoked, or insufficient scope |
| `-32602` | `INVALID_ARGUMENT` | Invalid input parameters or account not found |
| `-32000` | `GMAIL_API_ERROR` | Gmail API error or rate limit |

When `invalid_grant` is returned from Google (token revoked), stored tokens are cleared and the user must re-authorize.

## Security

- Refresh tokens encrypted with AES-256-GCM before storage
- MCP-level JWTs (HS256) with 1-hour lifetime
- Google OAuth with PKCE support
- CSRF protection via state parameter

## License

MIT
