import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { TokenStore } from '../store/interface.js';
import type { McpServerInstance } from '../mcp/server.js';
import { createMcpOAuth } from '../auth/mcpOAuth.js';
import { createGoogleOAuth } from '../auth/googleOAuth.js';

export interface HttpServerDependencies {
  config: Config;
  tokenStore: TokenStore;
  mcpServer: McpServerInstance;
}

export async function createHttpServer(deps: HttpServerDependencies): Promise<FastifyInstance> {
  const { config, tokenStore, mcpServer } = deps;

  // Create OAuth handlers
  const mcpOAuth = createMcpOAuth({ config });
  const googleOAuth = createGoogleOAuth({ config, tokenStore });

  const server = Fastify({
    logger: {
      level: 'info',
    },
  });

  // Custom JSON body parser
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // CORS handling
  if (config.allowedOrigins.length > 0) {
    server.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && config.allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      }

      if (request.method === 'OPTIONS') {
        reply.status(204).send();
      }
    });
  }

  // Health check endpoint
  server.get('/healthz', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await tokenStore.cleanupExpiredStates();
      return { status: 'ok', timestamp: new Date().toISOString() };
    } catch {
      reply.status(503);
      return {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        issues: ['Token store unavailable'],
      };
    }
  });

  // MCP Streamable HTTP endpoint
  server.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request.raw;
    const res = reply.raw;
    await mcpServer.handleRequest(req, res, request.body);
    reply.hijack();
  });

  server.get('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request.raw;
    const res = reply.raw;
    await mcpServer.handleRequest(req, res);
    reply.hijack();
  });

  // MCP OAuth endpoints
  server.get('/oauth/authorize', mcpOAuth.authorizeEndpointHandler);
  server.post('/oauth/token', mcpOAuth.tokenEndpointHandler);

  // Google OAuth endpoints
  server.get('/oauth/start', googleOAuth.startHandler);
  server.get('/oauth/callback', googleOAuth.callbackHandler);

  // Well-known endpoints for MCP OAuth discovery
  server.get('/.well-known/oauth-protected-resource', async () => {
    return {
      resource: config.baseUrl,
      authorization_servers: [config.baseUrl],
    };
  });

  server.get('/.well-known/oauth-authorization-server', async () => {
    return {
      issuer: config.baseUrl,
      authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
      token_endpoint: `${config.baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    };
  });

  return server;
}
