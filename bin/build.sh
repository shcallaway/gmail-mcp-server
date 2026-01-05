#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Building Gmail MCP Docker image..."
docker compose build

echo "Build complete."
