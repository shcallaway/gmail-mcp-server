---
name: gmail-drafts
description: List all pending email drafts
---

# /gmail-drafts - View Drafts

List all saved email drafts.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_listDrafts` to get all drafts

## Output Format

```
📝 {count} drafts

• To: {recipient} - {subject} - modified {relative_time}
• To: {recipient} - {subject} - modified {relative_time}
• To: (no recipient) - {subject} - modified {relative_time}
...
```

## Notes

- Show recipient(s), subject, and last modified time
- If recipient is empty, show "(no recipient)"
- If subject is empty, show "(no subject)"
- Sort by last modified (most recent first)
- If no drafts, let user know their drafts folder is empty
- Remind user that drafts can be sent from Gmail directly
