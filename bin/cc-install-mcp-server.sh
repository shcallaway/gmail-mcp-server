#!/bin/bash
set -e

CLAUDE_CONFIG="$HOME/.claude.json"

echo "Installing Gmail MCP server to Claude Code..."

# Create config if it doesn't exist
if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo '{}' > "$CLAUDE_CONFIG"
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed."
    echo "Install it with: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

# Add the MCP server config
jq '.mcpServers["gmail-mcp"] = {"url": "http://localhost:3000/mcp"}' "$CLAUDE_CONFIG" > "$CLAUDE_CONFIG.tmp" \
    && mv "$CLAUDE_CONFIG.tmp" "$CLAUDE_CONFIG"

echo ""
echo "Done! Added gmail-mcp server to $CLAUDE_CONFIG"
echo ""
echo "MCP Server config:"
jq '.mcpServers["gmail-mcp"]' "$CLAUDE_CONFIG"
echo ""
echo "Make sure the server is running: npm run bin:start"
