# Gmail MCP Server

An MCP (Model Context Protocol) server that exposes Gmail inbox tools via Streamable HTTP transport. Connect your Gmail accounts to Claude Code and other MCP-compatible clients to search, read, organize, and compose emails.

## Features

- **Multi-account support** - Connect multiple Gmail accounts and switch between them
- **Full Gmail access** - Search messages, read threads, manage labels, archive, star, and compose drafts
- **Secure token storage** - Refresh tokens encrypted with AES-256-GCM in SQLite
- **Two-layer OAuth** - MCP-level JWT authentication plus Google OAuth for Gmail
- **Docker ready** - Run with Docker Compose for easy deployment

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/yourusername/gmail-mcp.git
cd gmail-mcp
npm install
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Gmail API
4. Create OAuth 2.0 credentials (Web application)
5. Set authorized redirect URI to `http://localhost:3000/oauth/callback`
6. Copy the Client ID and Client Secret

### 3. Set up environment

```bash
# Generate secure secrets
npm run setup:secrets

# Edit .env with your Google OAuth credentials
# Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
```

### 4. Build and run

```bash
npm run build
npm run start
```

The server runs on `http://localhost:3000`.

### 5. Connect to Claude Code

```bash
npm run claude:setup
```

This installs the MCP server connection and Gmail skills.

## Claude Code Integration

### Setup

After the server is running, install the Claude Code integration:

```bash
npm run claude:setup
```

This installs:
- MCP server connection to `~/.claude.json`
- Gmail skills to `~/.claude/skills/`

### Available Skills

| Command | Description |
|---------|-------------|
| `/gmail-inbox` | Quick inbox status |
| `/gmail-unread` | List unread messages |
| `/gmail-triage` | Prioritize unread emails |
| `/gmail-explore` | Comprehensive inbox overview |
| `/gmail-search` | Search with Gmail query syntax |
| `/gmail-thread` | View a conversation thread |
| `/gmail-compose` | Draft new emails |
| `/gmail-summarize` | Summarize email threads |
| `/gmail-cleanup` | Archive and organize inbox |
| `/gmail-labels` | View all labels |
| `/gmail-starred` | View starred messages |
| `/gmail-drafts` | View pending drafts |
| `/gmail-connect` | Connect Gmail account |
| `/gmail-accounts` | View connected accounts |

### Management

```bash
npm run claude:status     # Check what's installed
npm run claude:uninstall  # Remove integration
```

## Configuration

Create a `.env` file based on `.env.example`:

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `BASE_URL` | Public URL for OAuth callbacks | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes |
| `OAUTH_REDIRECT_URI` | OAuth callback URL | Yes |
| `TOKEN_ENCRYPTION_KEY` | 32-byte base64 key for token encryption | Yes |
| `JWT_SECRET` | Secret for MCP JWT tokens | Yes |
| `DB_URL` | SQLite database path (default: `./data/gmail-mcp.db`) | No |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | No |

## Available Tools

### Authorization & Status
| Tool | Description |
|------|-------------|
| `gmail.status` | Check connection status and list connected accounts |
| `gmail.authorize` | Initiate OAuth flow to connect a Gmail account |

### Account Management
| Tool | Description |
|------|-------------|
| `gmail.listAccounts` | List all connected Gmail accounts |
| `gmail.setDefaultAccount` | Set the default account for operations |
| `gmail.removeAccount` | Disconnect a Gmail account |

### Reading Email
| Tool | Description |
|------|-------------|
| `gmail.searchMessages` | Search using Gmail query syntax |
| `gmail.batchSearchMessages` | Run multiple searches in parallel |
| `gmail.getMessage` | Get a single message by ID |
| `gmail.listThreads` | List conversation threads |
| `gmail.getThread` | Get all messages in a thread |
| `gmail.getAttachmentMetadata` | Get attachment info |

### Labels
| Tool | Description |
|------|-------------|
| `gmail.listLabels` | List all labels with counts |
| `gmail.getLabelInfo` | Get details about a specific label |
| `gmail.createLabel` | Create a custom label |
| `gmail.addLabels` | Add labels to messages/threads |
| `gmail.removeLabels` | Remove labels from messages/threads |

### Modifications
| Tool | Description |
|------|-------------|
| `gmail.archiveMessages` | Archive messages/threads |
| `gmail.unarchiveMessages` | Move back to inbox |
| `gmail.markAsRead` | Mark as read |
| `gmail.markAsUnread` | Mark as unread |
| `gmail.starMessages` | Add star |
| `gmail.unstarMessages` | Remove star |

### Drafts
| Tool | Description |
|------|-------------|
| `gmail.createDraft` | Create a new draft |
| `gmail.listDrafts` | List all drafts |
| `gmail.getDraft` | Get draft content |
| `gmail.updateDraft` | Update an existing draft |
| `gmail.deleteDraft` | Delete a draft |

## OAuth Scopes

Request only the scopes you need:

| Scope | Capabilities |
|-------|--------------|
| `gmail.readonly` | Search, read messages and threads |
| `gmail.labels` | Manage labels, archive, star, mark read/unread |
| `gmail.modify` | All of the above |
| `gmail.compose` | Create and manage drafts |

## Multi-Account Support

Connect multiple Gmail accounts per user:

```
// First account becomes the default
gmail.authorize → connects work@company.com (default)
gmail.authorize → connects personal@gmail.com

// Use specific account
gmail.searchMessages(query: "...", email: "personal@gmail.com")

// Or change the default
gmail.setDefaultAccount(email: "personal@gmail.com")
```

## Docker Deployment

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

The SQLite database persists in `./data/`.

## Development

```bash
# Dev mode with hot reload
npm run dev

# Run tests
npm run test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Architecture

```
MCP Client → Fastify HTTP (/mcp) → MCP Server → Gmail Client → Google APIs
                    ↓
            Token Store (SQLite) ← encrypted credentials
```

- **`src/index.ts`** - Entry point
- **`src/http/server.ts`** - Fastify server with `/mcp`, `/oauth/*`, `/healthz` endpoints
- **`src/mcp/server.ts`** - MCP server with 26 registered tools
- **`src/gmail/client.ts`** - Gmail API wrapper with token refresh
- **`src/auth/`** - MCP JWT auth and Google OAuth flows
- **`src/store/sqlite.ts`** - SQLite token store with AES-256-GCM encryption

## License

MIT
