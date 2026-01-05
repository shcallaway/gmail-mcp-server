#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$HOME/.claude/agents"

echo "Installing Claude Code agents..."

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Copy all agents from repo
AGENTS_DIR="$REPO_DIR/.claude/agents"
if [ -d "$AGENTS_DIR" ]; then
    for agent in "$AGENTS_DIR"/*.md; do
        if [ -f "$agent" ]; then
            name=$(basename "$agent")
            cp "$agent" "$TARGET_DIR/$name"
            echo "  Installed: $name"
        fi
    done
else
    echo "  No agents found in $AGENTS_DIR"
    exit 1
fi

echo ""
echo "Done! Agents installed to $TARGET_DIR"
echo ""
echo "Available agents:"
for agent in "$TARGET_DIR"/*.md; do
    if [ -f "$agent" ]; then
        name=$(basename "$agent" .md)
        echo "  - $name"
    fi
done
