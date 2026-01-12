---
name: gmail-triage
description: Prioritize inbox - identify urgent emails, action items, and what needs response
---

# /gmail-triage - Inbox Triage

Analyze unread emails and prioritize them by urgency and action required.

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_batchSearchMessages` to gather emails in parallel:
   ```
   gmail_batchSearchMessages({
     queries: [
       { query: "is:unread in:inbox newer_than:1d", maxResults: 30 },
       { query: "is:unread in:inbox older_than:1d newer_than:7d", maxResults: 20 },
       { query: "is:starred is:unread", maxResults: 10 }
     ]
   })
   ```
3. Use `gmail_getMessage` (format: "summary") for emails that need more context
4. Categorize each email into priority buckets
5. Identify action items and who's waiting on a response

## Priority Categories

**Urgent** (needs response today)
- Direct questions to you
- Time-sensitive requests (meetings, deadlines)
- From VIPs/important contacts
- Keywords: urgent, asap, deadline, today, eod

**Action Required** (needs response this week)
- Requests requiring your input
- Threads where you're directly addressed
- Approvals or reviews needed

**FYI** (read when convenient)
- Newsletters, updates
- CC'd emails
- Automated notifications
- Group emails not requiring your response

**Low Priority** (can skip or archive)
- Marketing emails
- Old threads with no recent activity
- Already handled elsewhere

## Output Format

```
📥 Inbox Triage

## Urgent ({count})
• {sender} - {subject} - {why urgent}
• {sender} - {subject} - {why urgent}

## Action Required ({count})
• {sender} - {subject} - {action needed}
• {sender} - {subject} - {action needed}

## Awaiting Your Reply ({count})
• {sender} - {subject} - waiting since {date}

## FYI ({count})
• {sender} - {subject}
• {sender} - {subject}

## Can Archive ({count})
• {count} newsletters/marketing
• {count} automated notifications
• {count} old threads

---
Summary: {urgent} urgent, {action} need action, {fyi} FYI
Recommendation: {suggested next step}
```

## Notes

- Focus on unread emails - don't resurface already-read items
- Use message snippets and subjects to determine priority without fetching full content
- Look for question marks in subjects/snippets to identify questions
- Check for reply patterns - if thread has multiple messages, someone may be waiting
- Starred + unread = user previously marked as important
- Be concise - this is for quick scanning, not detailed summaries
- Suggest archiving candidates but don't auto-archive
- If inbox is clean (<5 unread), congratulate user
