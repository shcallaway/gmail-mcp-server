---
name: gmail-labels
description: List all Gmail labels with message counts
---

# /gmail-labels - View Labels

List all Gmail labels with their message counts.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_listLabels` to get all labels

## Output Format

```
🏷️ Gmail Labels

System Labels:
• INBOX: {total} ({unread} unread)
• SENT: {total}
• DRAFT: {count}
• STARRED: {count}
• SPAM: {count}
• TRASH: {count}

Custom Labels:
• {label_name}: {total} ({unread} unread)
• {label_name}: {total}
• {parent}/{child}: {total}
...
```

## Notes

- Separate system labels from custom labels
- Show unread count only if > 0
- Show nested labels with their hierarchy (parent/child)
- Sort custom labels alphabetically
- Skip labels with 0 messages unless they're system labels
- If no custom labels exist, note that user can create them
