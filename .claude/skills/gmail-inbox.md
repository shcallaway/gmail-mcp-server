---
name: gmail-inbox
description: Quick snapshot of inbox state - unread count, recent messages, starred items
---

# /gmail-inbox - Quick Inbox Status

Provide a quick snapshot of the user's inbox state without deep analysis.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_listAccounts` to show which account is being used
3. Use `gmail_getLabelInfo` for INBOX to get total message count
4. Use `gmail_getLabelInfo` for UNREAD to get unread count
5. Use `gmail_getLabelInfo` for STARRED to get starred count
6. Use `gmail_searchMessages` with query `in:inbox` and maxResults: 10 to get recent messages

## Output Format

```
📬 Inbox Status ({account})

Messages: {total} ({unread} unread)
Starred: {starred}

Recent messages:
• {sender} - {subject} - {relative_time}
• {sender} - {subject} - {relative_time}
...
```

## Notes

- Keep output concise - this is a quick status check
- Show relative time (e.g., "2 hours ago", "yesterday")
- Truncate long subjects if needed
- If not authenticated, explain how to connect with /gmail-connect
