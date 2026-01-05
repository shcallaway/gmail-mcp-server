#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Generate secrets
TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")

echo "Generated secrets:"
echo ""
echo "TOKEN_ENCRYPTION_KEY=$TOKEN_ENCRYPTION_KEY"
echo "JWT_SECRET=$JWT_SECRET"
echo ""

# Check if .env exists and offer to append
if [ -f .env ]; then
    read -p "Append to existing .env file? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "" >> .env
        echo "# Generated secrets" >> .env
        echo "TOKEN_ENCRYPTION_KEY=$TOKEN_ENCRYPTION_KEY" >> .env
        echo "JWT_SECRET=$JWT_SECRET" >> .env
        echo "Added to .env"
    fi
elif [ -f .env.example ]; then
    read -p "Create .env from .env.example with these secrets? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cp .env.example .env
        # Replace placeholder values
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$TOKEN_ENCRYPTION_KEY|" .env
            sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
        else
            sed -i "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$TOKEN_ENCRYPTION_KEY|" .env
            sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
        fi
        echo "Created .env with secrets. Edit it to add your Google OAuth credentials."
    fi
fi
