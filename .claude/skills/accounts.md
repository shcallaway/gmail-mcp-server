---
name: accounts
description: View connected Gmail accounts and current default
---

# /accounts - View Connected Accounts

Show all connected Gmail accounts and which is set as default.

## Steps

1. Use `gmail_status` to check connection status
2. Use `gmail_listAccounts` to get all connected accounts

## Output Format

```
📧 Connected Gmail Accounts

• {email} (default) ✓
• {email}
• {email}

Use /connect to add another account
Use gmail_setDefaultAccount to change default
```

### If no accounts connected:
```
📧 No Gmail accounts connected

Use /connect to authorize a Gmail account
```

## Notes

- Clearly indicate which account is the default
- Default account is used when no email parameter is specified in tools
- If only one account, still show it with (default) marker
- Remind user how to add more accounts or change default
