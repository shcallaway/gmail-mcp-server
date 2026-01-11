---
name: explore
description: Comprehensive overview of inbox - volume, top senders, labels, activity patterns
---

# /explore - Inbox Overview

Provide a comprehensive profile of the inbox for orientation or periodic review.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_listAccounts` to identify which account is being explored
3. Use `gmail_getLabelInfo` for: INBOX, UNREAD, STARRED, SENT, DRAFT, SPAM, TRASH
4. Use `gmail_listLabels` to get all labels with counts
5. Use `gmail_searchMessages` with these queries (maxResults: 50 each):
   - `in:inbox newer_than:1d` (today)
   - `in:inbox newer_than:7d` (this week)
   - `in:inbox newer_than:30d` (this month)
6. Analyze search results to identify top senders by frequency

## Output Format

```
📊 Inbox Overview ({account})

## Volume
• Total in inbox: {count}
• Unread: {count}
• Starred: {count}
• Drafts: {count}

## Recent Activity
• Today: {count} messages
• This week: {count} messages
• This month: {count} messages

## Top Senders (last 30 days)
1. {sender} - {count} messages
2. {sender} - {count} messages
3. {sender} - {count} messages
4. {sender} - {count} messages
5. {sender} - {count} messages

## Labels
System:
• INBOX: {count}
• SENT: {count}
• SPAM: {count}
• TRASH: {count}

Custom:
• {label}: {count}
• {label}: {count}
...

## Inbox Health
• Unread rate: {unread/total}%
• {assessment: "Inbox looks manageable" / "High volume - consider triage" / etc.}
```

## Notes

- This is more comprehensive than /inbox - use for orientation, not daily checks
- Calculate top senders by counting frequency in search results
- Only show custom labels that have messages
- Provide a brief health assessment based on:
  - Unread rate (>50% = needs attention)
  - Total volume (>500 inbox = consider archiving)
  - Spam volume (high = check filters)
- If inbox is very large, note that counts are approximate
- Group related insights together for easy scanning
