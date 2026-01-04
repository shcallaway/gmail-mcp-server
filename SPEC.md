# Technical spec: Gmail Inbox MCP Server (TypeScript)

## 1) Overview

Build an **MCP server** (Model Context Protocol) that exposes **read-only Gmail inbox tools** (search, list, read message/thread, fetch attachment metadata) to MCP hosts/clients. The server supports **remote connections via Streamable HTTP** (recommended transport in the TS SDK) and provides an **easy, secure user authorization flow** for Gmail access.

We target the **latest stable MCP spec (2025-11-25)** and implement **OAuth-based authorization** consistent with MCP’s OAuth model (server as OAuth resource server; client as OAuth client).

---

## 2) Goals and non-goals

### Goals
- Expose Gmail **read-only** tools over MCP.
- Provide a **low-friction authorization UX** using MCP **URL elicitation** (open a browser to complete Google OAuth consent).
- Support **multi-user** operation (each end-user authorizes their own Gmail).
- Use Google’s recommended **Node.js Google API client libraries** for Gmail and OAuth.
- Implement **Streamable HTTP** transport and MCP capability negotiation per spec.

### Non-goals (v1)
- Sending email, modifying labels, deleting messages.
- Full-text indexing/storage of mailbox contents (server proxies Gmail API only).
- Supporting non-Gmail providers.

---

## 3) Standards and primary dependencies

### MCP
- MCP spec: **2025-11-25** (latest stable release).
- MCP TypeScript SDK: use **v1.x** packages:
  - `@modelcontextprotocol/sdk`
  - `zod`
  > Note: SDK v2 is pre-alpha on `main`; prefer v1.x for production.
- Transport: **Streamable HTTP**.
- Authorization guidance: server as **OAuth resource server**; discovery via:
  - **Protected Resource Metadata**
  - **Authorization Server Metadata**

### Google / Gmail
- Gmail API via official Node client:
  - `googleapis`
- OAuth: standard **authorization code** exchange + **refresh token** support (web server flow).

---

## 4) High-level architecture

### Components
1. **MCP Server**
   - Exposes MCP tools (e.g., `gmail.searchMessages`, `gmail.getMessage`)
   - Validates inputs with `zod`
   - Enforces auth: Gmail tools require a valid Gmail credential for the current end-user

2. **Authorization Service** (bundled with MCP server)
   - `GET /oauth/start` — begin Google OAuth
   - `GET /oauth/callback` — handle redirect + exchange code
   - Stores encrypted tokens (see Security)

3. **Token Store**
   - Pluggable interface (SQLite/Postgres/KV)
   - Default: SQLite
   - Stores `access_token`, `refresh_token`, expiry, Gmail identity (`sub`/email), scopes, timestamps

### Deployment topology
Single service exposing:
- MCP endpoint: `POST /mcp`
- OAuth endpoints: `/oauth/*`
- Optional health check: `/healthz`

---

## 5) MCP transport and server configuration

### Transport
- Default: **Streamable HTTP**
- Validate and emit `MCP-Protocol-Version`
- Require `2025-11-25`; accept `2025-06-18` for backward compatibility with older clients

### Server identity
- `name`: `gmail-mcp`
- `version`: semantic version (e.g., `1.0.0`)
- `capabilities`: tools only (no resources/prompts initially)

---

## 6) Authorization model (two layers)

### 6.1 MCP-level authorization (server as OAuth resource server)

MCP treats a protected MCP server as an **OAuth 2.1 resource server**.

#### Required behaviors
- If unauthenticated: return **401** with `WWW-Authenticate` pointing to the resource metadata URL
- Serve protected resource metadata:
  - `GET /.well-known/oauth-protected-resource`
- Serve authorization server metadata:
  - `GET /.well-known/oauth-authorization-server` (RFC 8414-style)

> MCP-level OAuth tokens protect access to the MCP server itself.

#### Token format (JWT)
MCP access tokens are **signed JWTs** with the following claims:
- `sub`: unique user identifier (opaque string, e.g., UUID)
- `iss`: server base URL (e.g., `https://gmail-mcp.example.com`)
- `aud`: `gmail-mcp` (must match server name)
- `exp`: expiration timestamp
- `iat`: issued-at timestamp
- `scope`: space-separated list of granted scopes (e.g., `mcp:tools`)

#### Token lifetimes
- **Access token**: 1 hour (3600 seconds)
- **Refresh token**: 30 days (2592000 seconds)
- Refresh tokens are rotated on use (old token invalidated)

#### Token issuance
- Endpoint: `POST /oauth/token`
- Supports `authorization_code` and `refresh_token` grant types
- Returns: `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }`

#### Token validation
On each MCP request, the server must:
1. Extract `Bearer` token from `Authorization` header
2. Verify JWT signature (HS256 or RS256)
3. Check `exp` > current time
4. Check `aud` matches server name
5. Check `iss` matches expected issuer
6. Extract `sub` as the canonical MCP user identity

### 6.2 Gmail user authorization (Google OAuth)

We provide a very easy UX via **MCP URL elicitation**:
- If a user runs a Gmail tool without Google tokens, the server returns a URL to open in a browser.

#### OAuth flow
1. User calls a Gmail tool without authorization
2. Server responds with **URL elicitation** to `/oauth/start?...`
3. User completes Google consent in browser
4. Google redirects to `/oauth/callback`
5. Server exchanges code for tokens, stores them, marks user authorized
6. User retries tool → success

#### OAuth details
- Scopes (minimum):
  - `https://www.googleapis.com/auth/gmail.readonly`
- Request refresh token:
  - `access_type=offline`
  - `prompt=consent` when needed (initial grant)
- Redirect URI:
  - `https://<host>/oauth/callback`

#### User association
After exchanging tokens, call Gmail profile endpoint (`users.getProfile`) to bind tokens to:
- `google_user_id` and `email`
- plus the MCP user identity (if available) for correct multi-user mapping

### 6.3 User identity strategy

#### Canonical user identifier
The **MCP JWT `sub` claim** is the canonical user identifier for all operations:
- Used as the primary key for Gmail credential lookup
- Must be present on all Gmail tool requests
- Opaque to the Gmail MCP server (assigned by MCP auth layer)

#### Token lookup
Gmail credentials are stored keyed by `mcp_user_id`:
```
mcp_user_id → { google_user_id, email, access_token, refresh_token, ... }
```

#### Multi-user operation
- Each MCP user maintains independent Gmail authorization
- One MCP user can link exactly one Gmail account
- Re-authorizing replaces the existing Gmail linkage
- No cross-user token sharing or access

#### Missing identity handling
If MCP authentication is disabled or `sub` is missing:
- Gmail tools return `NOT_AUTHORIZED` error
- Error message instructs user to authenticate with MCP server first
- `gmail.status` returns `{ authorized: false }` with guidance

---

## 7) MCP tool surface

All tool inputs validated with `zod`. Outputs should be **structured** and include a human-readable fallback.

### 7.1 `gmail.authorize`
Initiates the OAuth consent flow.

**Input**
- `scopes?: ("gmail.readonly" | "gmail.labels")[]` (optional; defaults to `["gmail.readonly"]`)

**Allowed scopes** (whitelist):
| Scope | Google Scope | Description |
|-------|--------------|-------------|
| `gmail.readonly` | `https://www.googleapis.com/auth/gmail.readonly` | Read messages, threads, attachments (default) |
| `gmail.labels` | `https://www.googleapis.com/auth/gmail.labels` | Read and manage labels |

> Unknown scopes return `INVALID_ARGUMENT` error. This whitelist prevents privilege escalation.

**Behavior**
- Validates requested scopes against whitelist
- Returns MCP **URL elicitation** pointing to `/oauth/start`

**Output**
- Text explaining what will happen
- Elicitation payload: `{ type: "url", url: "https://<host>/oauth/start?..." }`

### 7.2 `gmail.status`
Returns whether the current user has Gmail connected.

**Input**: none

**Output**
- `{ authorized: boolean, email?: string, scopes?: string[], lastAuthorizedAt?: string }`

### 7.3 `gmail.searchMessages`
Search using Gmail query syntax.

**Input**
- `q: string`
- `maxResults?: number` (default 20, max 100)
- `pageToken?: string`

**Output**
- `messages: { id: string, threadId: string }[]`
- `nextPageToken?: string`

**Safety limits**
- **Session result cap**: Max 500 total results across all pages per query session
- **Query timeout**: 30 seconds; returns `RATE_LIMITED` if exceeded
- **Complex query warning**: Queries with >5 OR clauses log a warning (performance risk)

### 7.4 `gmail.getMessage`
Fetch a single message.

**Input**
- `id: string`
- `format?: "metadata" | "full"` (default `metadata`)

**Output**
- Headers (From/To/Subject/Date)
- Snippet
- Optional body (if `full`) with safe rendering guidance
- Attachment metadata list: `filename`, `mimeType`, `attachmentId`, `size`

### 7.5 `gmail.listThreads`
**Input**
- `q?: string`
- `maxResults?: number`
- `pageToken?: string`

**Output**
- `threads: { id: string, snippet?: string }[]`

### 7.6 `gmail.getThread`
**Input**
- `id: string`
- `format?: "metadata" | "full"`

**Output**
- Thread messages array (like `getMessage`)

### 7.7 `gmail.getAttachmentMetadata`
(Do not download attachment bytes in v1.)

**Input**
- `messageId: string`
- `attachmentId: string`

**Output**
- Metadata only

**v2 consideration**: Attachment download may be added in a future version with:
- Size limit: 10MB default (configurable)
- Streaming: Return chunked data or pre-signed URL for large files
- MIME filtering: Optionally restrict to safe content types

---

## 8) Data handling and security

### Token storage
- Encrypt refresh tokens at rest using envelope encryption:
  - Master key from KMS (recommended) or env var for dev
  - Per-record data key
- Store:
  - `refresh_token` (encrypted)
  - `access_token` (optional; can refresh on demand)
  - `expiry_date`
  - `scope`
  - `token_type`
  - `email`, `google_user_id`
- Rotate/update records on refresh

### Token refresh strategy
- **Proactive refresh**: Refresh access token when it expires within 5 minutes
- **Refresh token rotation**: Google may rotate refresh tokens; always store the latest token returned
- **Error handling**:
  - `invalid_grant`: User revoked access or token expired → clear stored tokens, return `NOT_AUTHORIZED` with re-auth URL
  - `invalid_client`: Configuration error → log critical, return server error
  - Network/transient errors: Retry with exponential backoff (max 3 attempts, base 1s)
- **Concurrency**: Use optimistic locking to prevent race conditions during refresh

### Least privilege
- Default to `gmail.readonly`
- Only request broader scopes if user explicitly opts in via `gmail.authorize(scopes=...)`

### Audit logging
- Log tool invocations with:
  - tool name, timestamp
  - Gmail principal email (hash if needed)
  - query length / message IDs
- Avoid logging email bodies or sensitive content

### Rate limiting
- Per MCP user/session limit to protect Gmail quota

### Data minimization
- Prefer `metadata` format unless `full` is explicitly requested

---

## 9) HTTP endpoints

### MCP Streamable HTTP
- `POST /mcp`
  - MCP JSON-RPC messages and streaming responses per transport

### MCP OAuth discovery (server-level)
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

### Gmail OAuth (user-level)
- `GET /oauth/start`
  - Create state + PKCE (recommended)
  - Redirect to Google authorization endpoint
- `GET /oauth/callback`
  - Validate state
  - Exchange code for tokens
  - Store tokens
  - Display "Success" page

#### State parameter security
- **Format**: 256-bit cryptographically random value, base64url encoded (43 characters)
- **TTL**: 10 minutes; expired states are rejected
- **Storage**: DB table or memory cache with automatic expiration
- **Binding**: State is bound to MCP user ID to prevent CSRF attacks
- **One-time use**: State is deleted after successful callback

> Use HTTPS in production.

### CORS configuration
Configure CORS headers for browser-based MCP clients:

| Endpoint | CORS Policy |
|----------|-------------|
| `POST /mcp` | Allow configured origins, support credentials |
| `/oauth/*` | Allow configured origins for redirect handling |
| `/.well-known/*` | Allow all origins (public metadata) |

- Default: same-origin only (no CORS headers)
- Configure via `ALLOWED_ORIGINS` env var (comma-separated list)
- Credentials: `Access-Control-Allow-Credentials: true` when origins configured

---

## 10) TypeScript implementation sketch

### Packages
- MCP: `@modelcontextprotocol/sdk`, `zod`
- Google: `googleapis`
- Web: `fastify` (recommended) or `express`
- Storage: `better-sqlite3` (dev), `pg` (prod)
  > Note: `better-sqlite3` requires native compilation; consider `sql.js` for simpler deployment
- Crypto: Node `crypto` (+ optional KMS client)

### Key modules
- `src/mcp/server.ts`
  - Create `McpServer`
  - Register tools
  - Connect Streamable HTTP transport
- `src/auth/googleOAuth.ts`
  - OAuth start/callback handlers
  - Token refresh helper
- `src/auth/mcpOAuth.ts`
  - Protected resource metadata endpoints
  - MCP access token issuance/verification (JWT recommended)
- `src/gmail/client.ts`
  - Create Gmail client from user tokens
  - Wrap calls with retries / quota-friendly behavior
- `src/store/tokenStore.ts`
  - Interface + implementations

---

## 11) Error handling

### Common tool errors
- `NOT_AUTHORIZED`
  - Return URL elicitation for OAuth flow
- `INVALID_ARGUMENT`
  - Return zod validation error mapped to MCP tool error
- `GMAIL_API_ERROR`
  - Include HTTP status and safe error message
- `RATE_LIMITED`
  - Include retry-after hint when available

### Error code mapping

| Error Type | MCP JSON-RPC Code | HTTP Status | Description |
|------------|-------------------|-------------|-------------|
| `NOT_AUTHORIZED` | -32001 | 401 | User not authenticated or Gmail not linked |
| `INVALID_ARGUMENT` | -32602 | 400 | Invalid input (zod validation failed) |
| `GMAIL_API_ERROR` | -32000 | 502 | Gmail API returned an error |
| `RATE_LIMITED` | -32000 | 429 | Rate limit exceeded; include `retryAfter` |
| `INTERNAL_ERROR` | -32603 | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | -32000 | 503 | Token store or dependency unavailable |

---

## 12) Testing plan

### Unit tests
- zod schemas
- token encryption/decryption roundtrip
- Gmail query validation + pagination logic

### Integration tests
- OAuth callback flow (mock Google endpoints or test project)
- Gmail API calls (test account)
- MCP protocol compliance smoke test using an MCP client from TS SDK

### Security tests
- CSRF/state validation for OAuth
- callback replay protection
- ensure refresh tokens never appear in logs

---

## 13) Operational considerations

### Secrets
- Google client secret
- encryption keys
- JWT signing keys (for MCP-level auth)

### Observability
- structured logs
- metrics for Gmail calls and refresh success/failure

### Configuration (env vars)
- `PORT`
- `BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI`
- `TOKEN_ENCRYPTION_KEY` (dev) / `KMS_KEY_URI` (prod)
- `DB_URL`
- `ALLOWED_ORIGINS` (comma-separated list for CORS; optional)

---

## 14) UX: "easy authorization" behavior

### Default UX
- Any Gmail tool called without Google tokens → server returns **URL elicitation** to start OAuth
- `gmail.authorize` available for explicit upfront linking
- `gmail.status` enables hosts to display "Connected as <email>"

---

## 15) Failure modes and graceful degradation

### 15.1 Google API failures
- **Detection**: HTTP 5xx responses, request timeouts, `UNAVAILABLE` errors
- **Response**: Return `GMAIL_API_ERROR` with `retryAfter` hint when available
- **Mitigation**: Circuit breaker pattern (open after 5 failures in 60s, half-open after 30s)
- **Optional**: Cache recent search results for degraded read-only access

### 15.2 Token store unavailable
- **Detection**: Database connection failures, query timeouts
- **Response**: Return HTTP 503 Service Unavailable with `Retry-After` header
- **Mitigation**: Connection pooling with health checks; retry with exponential backoff
- **Logging**: Critical-level alert for operations team

### 15.3 Encryption key missing or invalid
- **Detection**: Startup validation check, decryption failures at runtime
- **Response**: Fail server startup with clear error message; do not serve requests
- **Mitigation**: Pre-flight key validation on boot; support key rotation
- **Recovery**: Document key recovery/rotation procedure in operations runbook

### 15.4 Google OAuth failures
- **Detection**: `invalid_grant` (revoked/expired), `invalid_client` (misconfiguration), network errors
- **Response**: Clear stored tokens, return `NOT_AUTHORIZED` with re-authorization URL
- **Mitigation**: Distinguish transient vs permanent failures; only clear tokens for permanent
- **Logging**: Track authentication failure rates per user for anomaly detection

### 15.5 Rate limiting (Gmail API quota)
- **Detection**: HTTP 429 responses, `rateLimitExceeded` error codes
- **Response**: Return `RATE_LIMITED` with `retryAfter` from Gmail response headers
- **Mitigation**: Per-user request budgets; request coalescing for batch operations
- **Monitoring**: Track quota usage; alert at 80% of daily limit

---

## 16) Revocation handling

### Detection
- **Token refresh failure**: `invalid_grant` error during access token refresh
- **API call failure**: 401 responses from Gmail API with `authError`

### Response
1. Clear all stored tokens (access + refresh) for the affected user
2. Return `NOT_AUTHORIZED` error with URL elicitation for re-authorization
3. Log revocation event (user ID hash, timestamp, trigger)

### User experience
- Next Gmail tool call prompts re-authorization automatically
- `gmail.status` returns `{ authorized: false }` with message explaining reconnection needed

### v2 consideration
- Google Push Notifications: Subscribe to token revocation webhooks for proactive invalidation
- Reduces latency between revocation and detection

