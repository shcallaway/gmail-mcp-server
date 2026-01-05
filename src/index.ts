/**
 * Gmail MCP Server - Entry Point
 *
 * A Model Context Protocol server that exposes read-only Gmail inbox tools.
 */

import { getConfig } from './config.js';
import { SqliteTokenStore } from './store/sqlite.js';
import { createMcpServer } from './mcp/server.js';
import { createHttpServer } from './http/server.js';

async function main() {
  console.log('Starting Gmail MCP Server...');

  // Load configuration
  let config;
  try {
    config = getConfig();
    console.log(`Configuration loaded. Base URL: ${config.baseUrl}`);
  } catch (error) {
    console.error('Failed to load configuration:', error);
    process.exit(1);
  }

  // Initialize token store
  const tokenStore = new SqliteTokenStore(config.dbUrl);
  try {
    await tokenStore.initialize();
    console.log(`Token store initialized at: ${config.dbUrl}`);
  } catch (error) {
    console.error('Failed to initialize token store:', error);
    process.exit(1);
  }

  // Create MCP server
  let mcpServer;
  try {
    mcpServer = await createMcpServer({ config, tokenStore });
    console.log('MCP server created with 7 tools:');
    console.log('  - gmail.authorize, gmail.status');
    console.log('  - gmail.searchMessages, gmail.getMessage');
    console.log('  - gmail.listThreads, gmail.getThread');
    console.log('  - gmail.getAttachmentMetadata');
  } catch (error) {
    console.error('Failed to create MCP server:', error);
    await tokenStore.close();
    process.exit(1);
  }

  // Create and start HTTP server
  const httpServer = await createHttpServer({ config, tokenStore, mcpServer });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      await httpServer.close();
      await mcpServer.transport.close();
      await tokenStore.close();
      console.log('Server stopped.');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start server
  try {
    await httpServer.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`\nGmail MCP Server running at ${config.baseUrl}`);
    console.log(`  Health check: ${config.baseUrl}/healthz`);
    console.log(`  MCP endpoint: ${config.baseUrl}/mcp`);
    console.log(`  OAuth discovery: ${config.baseUrl}/.well-known/oauth-protected-resource`);
  } catch (error) {
    console.error('Failed to start server:', error);
    await tokenStore.close();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
