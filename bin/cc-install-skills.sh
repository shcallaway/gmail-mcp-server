#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$HOME/.claude/skills"

echo "Installing Claude Code skills..."

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Copy all skills from repo
SKILLS_DIR="$REPO_DIR/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
    count=0
    for skill in "$SKILLS_DIR"/*.md; do
        if [ -f "$skill" ]; then
            name=$(basename "$skill")
            cp "$skill" "$TARGET_DIR/$name"
            echo "  Installed: $name"
            ((count++))
        fi
    done

    if [ $count -eq 0 ]; then
        echo "  No skills found"
        exit 1
    fi
else
    echo "  No skills directory found at $SKILLS_DIR"
    exit 1
fi

echo ""
echo "Done! Installed $count skill(s) to $TARGET_DIR"
