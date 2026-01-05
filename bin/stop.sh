#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Stopping Gmail MCP server..."
docker compose down

echo "Server stopped."
