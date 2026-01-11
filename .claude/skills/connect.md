---
name: connect
description: Connect a new Gmail account via OAuth
---

# /connect - Connect Gmail Account

Start the OAuth flow to connect a new Gmail account.

## Steps

1. Use `gmail_status` to check current connection status
2. Use `gmail_listAccounts` to show currently connected accounts (if any)
3. Use `gmail_authorize` with full scopes: ["gmail.readonly", "gmail.labels", "gmail.modify", "gmail.compose"]
4. Present the authorization URL to the user
5. Wait for confirmation and verify connection succeeded

## Output Format

### Starting authorization:
```
🔐 Connecting Gmail Account

Currently connected: {list or "none"}

Requesting scopes:
• gmail.readonly - Read emails and search
• gmail.labels - Manage labels
• gmail.modify - Archive, star, mark read/unread
• gmail.compose - Create and manage drafts

Please visit the authorization URL to connect your account...
```

### After successful connection:
```
✅ Successfully connected: {email}

This account is now {set as default / available for use}.

Use /accounts to see all connected accounts.
```

## Notes

- Request all scopes for full functionality
- Explain what each scope allows
- If authorization fails, provide troubleshooting steps
- If account is already connected, let user know
- First connected account automatically becomes default
