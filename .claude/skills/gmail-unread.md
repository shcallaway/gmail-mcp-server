---
name: gmail-unread
description: List all unread messages in inbox for quick scanning
---

# /gmail-unread - List Unread Messages

List all unread inbox messages for quick scanning.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_getLabelInfo` for UNREAD to get total count
3. Use `gmail_searchMessages` with query `is:unread in:inbox` and maxResults: 20

## Output Format

```
📩 {count} unread messages

Today:
• {sender} - {subject}
• {sender} - {subject}

Yesterday:
• {sender} - {subject}

Older:
• {sender} - {subject} - {date}
...
```

## Notes

- Group messages by: Today, Yesterday, This Week, Older
- Show sender name (not full email unless needed)
- Truncate long subjects
- If no unread messages, congratulate the user on inbox zero
- If many unread (50+), show first 20 and note total count
