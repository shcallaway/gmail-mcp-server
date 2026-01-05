#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$HOME/.claude/agents"

echo "Installing Claude Code subagents..."

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Copy all agents from repo
AGENTS_DIR="$REPO_DIR/.claude/agents"
if [ -d "$AGENTS_DIR" ]; then
    count=0
    for agent in "$AGENTS_DIR"/*.md; do
        if [ -f "$agent" ]; then
            name=$(basename "$agent")
            cp "$agent" "$TARGET_DIR/$name"
            echo "  Installed: $name"
            ((count++))
        fi
    done

    if [ $count -eq 0 ]; then
        echo "  No agents found"
        exit 1
    fi
else
    echo "  No agents directory found at $AGENTS_DIR"
    exit 1
fi

echo ""
echo "Done! Installed $count agent(s) to $TARGET_DIR"
