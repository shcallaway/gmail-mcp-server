---
name: gmail-starred
description: Show all starred messages
---

# /gmail-starred - View Starred Messages

Show all starred messages (typically important items marked for follow-up).

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_getLabelInfo` for STARRED to get count
3. Use `gmail_searchMessages` with query `is:starred` and maxResults: 25

## Output Format

```
⭐ {count} starred messages

• {sender} - {subject} - {date}
• {sender} - {subject} - {date}
• {sender} - {subject} - {date}
...
```

## Notes

- Sort by date (most recent first)
- Show relative dates for recent items, absolute for older
- If no starred messages, let user know
- Starred messages often represent items needing action - remind user of this context
- If count is high (20+), suggest reviewing and unstarring completed items
