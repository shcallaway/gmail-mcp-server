# Implementation Plan: Gmail MCP Server

This document outlines the phased implementation plan for the Gmail MCP Server as specified in [SPEC.md](./SPEC.md).

---

## Phase Overview

| Phase | Name | Description | Dependencies |
|-------|------|-------------|--------------|
| 1 | Project Setup | Initialize project, dependencies, configuration | None |
| 2 | Token Store | Database layer for credential storage | Phase 1 |
| 3 | HTTP Server & Health | Fastify server with health endpoints | Phase 1 |
| 4 | MCP Server Core | MCP SDK integration with Streamable HTTP | Phase 3 |
| 5 | MCP OAuth | Server-level JWT auth and discovery endpoints | Phase 2, 4 |
| 6 | Google OAuth | Gmail authorization flow | Phase 2, 3 |
| 7 | Gmail Client | Gmail API wrapper with token refresh | Phase 2, 6 |
| 8 | Gmail Tools | All 7 MCP tools | Phase 4, 5, 7 |
| 9 | Hardening | Rate limiting, circuit breakers, error handling | Phase 8 |
| 10 | Testing | Unit, integration, and security tests | Phase 9 |

---

## Phase 1: Project Setup

### Goals
- Initialize TypeScript project with proper configuration
- Install all dependencies
- Set up development tooling

### Tasks

#### 1.1 Initialize project
```
npm init -y
```

#### 1.2 Install dependencies
```
npm install @modelcontextprotocol/sdk zod googleapis fastify better-sqlite3 jsonwebtoken
npm install -D typescript @types/node @types/better-sqlite3 @types/jsonwebtoken vitest eslint prettier
```

#### 1.3 Create TypeScript configuration
- `tsconfig.json` with strict mode, ES2022 target, Node module resolution

#### 1.4 Create project structure
```
src/
├── index.ts              # Entry point
├── config.ts             # Environment configuration
├── mcp/
│   ├── server.ts         # MCP server setup
│   └── tools/            # Tool implementations
├── auth/
│   ├── mcpOAuth.ts       # MCP-level OAuth
│   └── googleOAuth.ts    # Google OAuth handlers
├── gmail/
│   └── client.ts         # Gmail API wrapper
├── store/
│   ├── interface.ts      # TokenStore interface
│   └── sqlite.ts         # SQLite implementation
├── http/
│   └── server.ts         # Fastify server
└── utils/
    ├── crypto.ts         # Encryption utilities
    └── errors.ts         # Error types
```

#### 1.5 Create configuration module
- Load and validate environment variables
- Required: `PORT`, `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`
- Optional: `DB_URL`, `ALLOWED_ORIGINS`, `JWT_SECRET`

#### 1.6 Create `.env.example`
```
PORT=3000
BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OAUTH_REDIRECT_URI=http://localhost:3000/oauth/callback
TOKEN_ENCRYPTION_KEY=
DB_URL=./data/gmail-mcp.db
JWT_SECRET=
ALLOWED_ORIGINS=
```

### Deliverables
- [ ] `package.json` with all dependencies
- [ ] `tsconfig.json`
- [ ] `src/config.ts` with validated env loading
- [ ] `.env.example`
- [ ] `.gitignore`
- [ ] Directory structure created

---

## Phase 2: Token Store

### Goals
- Implement encrypted token storage
- Create pluggable interface for future database support

### Tasks

#### 2.1 Define TokenStore interface
```typescript
// src/store/interface.ts
interface GmailCredentials {
  mcpUserId: string;
  googleUserId: string;
  email: string;
  accessToken: string;
  refreshToken: string;  // encrypted
  expiryDate: number;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TokenStore {
  getCredentials(mcpUserId: string): Promise<GmailCredentials | null>;
  saveCredentials(credentials: GmailCredentials): Promise<void>;
  deleteCredentials(mcpUserId: string): Promise<void>;
  updateAccessToken(mcpUserId: string, accessToken: string, expiryDate: number): Promise<void>;
}
```

#### 2.2 Implement encryption utilities
- `src/utils/crypto.ts`
- AES-256-GCM encryption for refresh tokens
- Key derivation from `TOKEN_ENCRYPTION_KEY`
- Encrypt/decrypt functions with IV handling

#### 2.3 Implement SQLite token store
- `src/store/sqlite.ts`
- Create table schema with migrations
- Implement all TokenStore methods
- Encrypt refresh tokens before storage
- Decrypt on retrieval

#### 2.4 Add OAuth state storage
- Temporary state storage for CSRF protection
- 256-bit random state generation
- 10-minute TTL with automatic cleanup
- Bind state to MCP user ID

### Deliverables
- [ ] `src/store/interface.ts`
- [ ] `src/utils/crypto.ts` with tests
- [ ] `src/store/sqlite.ts`
- [ ] Database schema (auto-created on startup)

---

## Phase 3: HTTP Server & Health

### Goals
- Set up Fastify HTTP server
- Implement health check endpoint
- Configure CORS

### Tasks

#### 3.1 Create Fastify server
- `src/http/server.ts`
- Configure JSON parsing
- Set up error handling
- Configure request logging

#### 3.2 Implement health endpoint
- `GET /healthz`
- Check database connectivity
- Return `{ status: "ok" }` or `{ status: "degraded", issues: [...] }`

#### 3.3 Configure CORS
- Parse `ALLOWED_ORIGINS` from config
- Apply CORS middleware with credential support
- Different policies per endpoint pattern (see SPEC Section 9)

#### 3.4 Create entry point
- `src/index.ts`
- Initialize config
- Initialize token store
- Start HTTP server
- Graceful shutdown handling

### Deliverables
- [ ] `src/http/server.ts`
- [ ] `src/index.ts`
- [ ] Health check endpoint working
- [ ] Server starts and listens on configured port

---

## Phase 4: MCP Server Core

### Goals
- Integrate MCP SDK
- Set up Streamable HTTP transport
- Register placeholder tools

### Tasks

#### 4.1 Create MCP server module
- `src/mcp/server.ts`
- Initialize `McpServer` from SDK
- Configure server identity: `name: "gmail-mcp"`, `version: "1.0.0"`
- Set capabilities: `tools: {}`

#### 4.2 Connect Streamable HTTP transport
- Mount on `POST /mcp`
- Validate `MCP-Protocol-Version` header
- Accept `2025-11-25` and `2025-06-18`

#### 4.3 Create tool registration helper
- Type-safe tool registration with zod schemas
- Error handling wrapper for tools

#### 4.4 Register placeholder tools
- `gmail.status` (returns `{ authorized: false }`)
- Verify MCP protocol handshake works

### Deliverables
- [ ] `src/mcp/server.ts`
- [ ] MCP endpoint mounted at `POST /mcp`
- [ ] Protocol version negotiation working
- [ ] Can connect with MCP client (test with SDK client)

---

## Phase 5: MCP OAuth

### Goals
- Implement server-level OAuth for MCP authentication
- Serve discovery metadata endpoints
- JWT token issuance and validation

### Tasks

#### 5.1 Implement discovery endpoints
- `GET /.well-known/oauth-protected-resource`
  ```json
  {
    "resource": "https://gmail-mcp.example.com",
    "authorization_servers": ["https://gmail-mcp.example.com"]
  }
  ```
- `GET /.well-known/oauth-authorization-server`
  ```json
  {
    "issuer": "https://gmail-mcp.example.com",
    "authorization_endpoint": "...",
    "token_endpoint": "...",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"]
  }
  ```

#### 5.2 Implement JWT utilities
- `src/auth/jwt.ts`
- Generate access tokens (1 hour expiry)
- Generate refresh tokens (30 days expiry)
- Validate tokens (signature, expiry, audience, issuer)
- Extract `sub` claim for user identity

#### 5.3 Implement token endpoint
- `POST /oauth/token`
- Support `authorization_code` grant
- Support `refresh_token` grant
- Rotate refresh tokens on use

#### 5.4 Implement auth middleware
- Extract Bearer token from Authorization header
- Validate JWT
- Attach `mcpUserId` to request context
- Return 401 with `WWW-Authenticate` if invalid/missing

#### 5.5 Protect MCP endpoint
- Apply auth middleware to `POST /mcp`
- Pass user identity to tool handlers

### Deliverables
- [ ] `src/auth/mcpOAuth.ts`
- [ ] `src/auth/jwt.ts`
- [ ] Discovery endpoints working
- [ ] Token endpoint working
- [ ] MCP endpoint protected with JWT auth

---

## Phase 6: Google OAuth

### Goals
- Implement Gmail authorization flow
- Handle OAuth callbacks
- Store Gmail credentials

### Tasks

#### 6.1 Create Google OAuth client
- `src/auth/googleOAuth.ts`
- Initialize `google.auth.OAuth2` client
- Configure redirect URI

#### 6.2 Implement `/oauth/start`
- Generate 256-bit random state
- Store state with MCP user ID binding (10 min TTL)
- Generate PKCE code verifier/challenge
- Build Google authorization URL with:
  - `scope`: requested Gmail scopes
  - `access_type`: `offline`
  - `prompt`: `consent`
  - `state`: generated state
  - `code_challenge`: PKCE challenge
- Redirect to Google

#### 6.3 Implement `/oauth/callback`
- Validate state parameter (exists, not expired, matches user)
- Delete state (one-time use)
- Exchange authorization code for tokens
- Fetch user profile (`users.getProfile`)
- Save credentials to token store
- Display success page (or redirect)

#### 6.4 Implement scope validation
- Whitelist: `gmail.readonly`, `gmail.labels`
- Map to Google scope URLs
- Reject unknown scopes

### Deliverables
- [ ] `src/auth/googleOAuth.ts`
- [ ] `/oauth/start` endpoint
- [ ] `/oauth/callback` endpoint
- [ ] State management with CSRF protection
- [ ] Credentials saved to token store

---

## Phase 7: Gmail Client

### Goals
- Create Gmail API wrapper
- Implement token refresh logic
- Handle API errors gracefully

### Tasks

#### 7.1 Create Gmail client factory
- `src/gmail/client.ts`
- Create authenticated Gmail client from stored credentials
- Inject OAuth2 client with tokens

#### 7.2 Implement token refresh
- Check if access token expires within 5 minutes
- Proactively refresh if needed
- Handle `invalid_grant` → clear tokens, throw `NOT_AUTHORIZED`
- Handle transient errors → retry with backoff
- Update stored access token after refresh

#### 7.3 Create Gmail API wrappers
- `searchMessages(q, maxResults, pageToken)`
- `getMessage(id, format)`
- `listThreads(q, maxResults, pageToken)`
- `getThread(id, format)`
- `getAttachmentMetadata(messageId, attachmentId)`

#### 7.4 Implement response transformers
- Convert Gmail API responses to spec-defined output formats
- Extract headers (From, To, Subject, Date)
- Extract attachment metadata
- Handle HTML/text body extraction for `full` format

### Deliverables
- [ ] `src/gmail/client.ts`
- [ ] Token refresh working
- [ ] All Gmail API methods implemented
- [ ] Response transformers

---

## Phase 8: Gmail Tools

### Goals
- Implement all 7 MCP tools
- Add proper input validation
- Handle authorization flow

### Tasks

#### 8.1 Implement `gmail.authorize`
- `src/mcp/tools/authorize.ts`
- Input: `scopes?: ("gmail.readonly" | "gmail.labels")[]`
- Validate scopes against whitelist
- Return URL elicitation to `/oauth/start`

#### 8.2 Implement `gmail.status`
- `src/mcp/tools/status.ts`
- Input: none
- Check if credentials exist for MCP user
- Return `{ authorized, email?, scopes?, lastAuthorizedAt? }`

#### 8.3 Implement `gmail.searchMessages`
- `src/mcp/tools/searchMessages.ts`
- Input: `q`, `maxResults?`, `pageToken?`
- Validate input with zod
- Check authorization → return URL elicitation if not authorized
- Call Gmail client
- Track result count for session cap (500)
- Return `{ messages, nextPageToken? }`

#### 8.4 Implement `gmail.getMessage`
- `src/mcp/tools/getMessage.ts`
- Input: `id`, `format?`
- Return headers, snippet, body (if full), attachments

#### 8.5 Implement `gmail.listThreads`
- `src/mcp/tools/listThreads.ts`
- Input: `q?`, `maxResults?`, `pageToken?`
- Return `{ threads }`

#### 8.6 Implement `gmail.getThread`
- `src/mcp/tools/getThread.ts`
- Input: `id`, `format?`
- Return thread messages array

#### 8.7 Implement `gmail.getAttachmentMetadata`
- `src/mcp/tools/getAttachmentMetadata.ts`
- Input: `messageId`, `attachmentId`
- Return metadata only (no bytes)

#### 8.8 Register all tools
- Update `src/mcp/server.ts` to register all tools
- Wire up dependency injection (token store, Gmail client factory)

### Deliverables
- [ ] All 7 tools implemented in `src/mcp/tools/`
- [ ] Zod schemas for all inputs
- [ ] Authorization checks with URL elicitation
- [ ] Tools registered and working end-to-end

---

## Phase 9: Hardening

### Goals
- Add rate limiting
- Implement circuit breaker
- Improve error handling
- Add audit logging

### Tasks

#### 9.1 Implement rate limiting
- `src/utils/rateLimiter.ts`
- Per-user rate limits
- Configurable limits per tool
- Return `RATE_LIMITED` with `retryAfter`

#### 9.2 Implement circuit breaker
- `src/utils/circuitBreaker.ts`
- Track Gmail API failures
- Open after 5 failures in 60 seconds
- Half-open after 30 seconds
- Return `GMAIL_API_ERROR` when open

#### 9.3 Improve error handling
- `src/utils/errors.ts`
- Typed error classes for each error type
- Error-to-MCP-response mapper
- Ensure refresh tokens never logged

#### 9.4 Add audit logging
- `src/utils/logger.ts`
- Structured JSON logging
- Log tool invocations (tool name, user ID hash, timestamp)
- Log Gmail API calls (method, latency, status)
- Redact sensitive fields

#### 9.5 Add query safety limits
- Session result tracking for search (500 cap)
- Query timeout (30 seconds)
- Complex query detection (>5 OR clauses)

### Deliverables
- [ ] Rate limiting working
- [ ] Circuit breaker working
- [ ] Structured logging
- [ ] Query safety limits enforced

---

## Phase 10: Testing

### Goals
- Comprehensive test coverage
- CI-ready test suite

### Tasks

#### 10.1 Unit tests
- `tests/unit/`
- Crypto: encryption/decryption roundtrip
- JWT: token generation and validation
- Zod schemas: valid and invalid inputs
- Error mapping

#### 10.2 Integration tests
- `tests/integration/`
- OAuth callback flow (mock Google endpoints)
- Token refresh flow
- Full tool invocation flow
- MCP protocol compliance

#### 10.3 Security tests
- `tests/security/`
- CSRF state validation
- State replay protection
- Expired state rejection
- Invalid JWT rejection
- Scope validation

#### 10.4 E2E test setup
- Test with real Gmail test account (optional)
- MCP client integration test

#### 10.5 CI configuration
- GitHub Actions workflow
- Run tests on PR
- Type checking
- Linting

### Deliverables
- [ ] Unit test suite
- [ ] Integration test suite
- [ ] Security test suite
- [ ] CI workflow (`.github/workflows/ci.yml`)
- [ ] >80% code coverage

---

## Post-Implementation

### Documentation
- [ ] README.md with setup instructions
- [ ] API documentation for tools
- [ ] Deployment guide

### Deployment Preparation
- [ ] Dockerfile
- [ ] docker-compose.yml for local dev
- [ ] Environment variable documentation
- [ ] Production checklist (HTTPS, secrets management, etc.)

---

## Implementation Notes

### Key Files Summary

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, server startup |
| `src/config.ts` | Environment configuration |
| `src/http/server.ts` | Fastify HTTP server |
| `src/mcp/server.ts` | MCP server setup |
| `src/mcp/tools/*.ts` | Individual tool implementations |
| `src/auth/mcpOAuth.ts` | MCP-level OAuth |
| `src/auth/googleOAuth.ts` | Google OAuth handlers |
| `src/auth/jwt.ts` | JWT utilities |
| `src/gmail/client.ts` | Gmail API wrapper |
| `src/store/interface.ts` | TokenStore interface |
| `src/store/sqlite.ts` | SQLite implementation |
| `src/utils/crypto.ts` | Encryption utilities |
| `src/utils/errors.ts` | Error types and handling |
| `src/utils/rateLimiter.ts` | Rate limiting |
| `src/utils/circuitBreaker.ts` | Circuit breaker |
| `src/utils/logger.ts` | Structured logging |

### Testing Strategy

1. **Unit tests** run fast, mock external dependencies
2. **Integration tests** use SQLite in-memory, mock Google APIs
3. **E2E tests** optional, require test Gmail account
4. **Security tests** focus on auth bypass attempts

### Risk Areas

1. **MCP SDK compatibility** - Verify SDK version matches spec
2. **Google OAuth edge cases** - Token rotation, revocation
3. **Concurrent token refresh** - Race conditions
4. **Rate limit accuracy** - Gmail quota tracking
