#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "Warning: .env file not found. Copy .env.example to .env and configure it."
    echo "  cp .env.example .env"
    exit 1
fi

echo "Starting Gmail MCP server..."
docker compose up -d

echo ""
echo "Server started! Waiting for health check..."
sleep 2

# Check health
if curl -sf http://localhost:3000/healthz > /dev/null 2>&1; then
    echo "Health check passed."
else
    echo "Health check pending. Check logs with: npm run docker:logs"
fi

echo ""
echo "Endpoints:"
echo "  Health:  http://localhost:3000/healthz"
echo "  MCP:     http://localhost:3000/mcp"
echo ""
echo "Commands:"
echo "  Logs:    npm run docker:logs"
echo "  Stop:    npm run docker:down (or ./scripts/stop.sh)"
