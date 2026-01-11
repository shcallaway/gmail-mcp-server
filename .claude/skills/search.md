---
name: search
description: Search Gmail using native query syntax
---

# /search - Gmail Search

Run a Gmail search using native query syntax.

## Usage

```
/search <query>
```

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` with the provided query and maxResults: 20
3. Display results with sender, subject, date, and snippet

## Output Format

```
🔍 Search: {query}
Found {count} messages

• {sender} - {subject} - {date}
  {snippet}

• {sender} - {subject} - {date}
  {snippet}
...
```

## Gmail Query Syntax Examples

Remind user of common operators if query is simple:

- `from:john@example.com` - from specific sender
- `to:me` - sent directly to you
- `subject:meeting` - subject contains word
- `has:attachment` - has attachments
- `is:unread` - unread messages
- `is:starred` - starred messages
- `newer_than:7d` - last 7 days
- `older_than:1m` - older than 1 month
- `in:inbox` - in inbox (not archived)
- `label:important` - has specific label
- `filename:pdf` - attachment filename

## Notes

- Pass query directly to Gmail - don't modify it
- Show snippet for context on what the email is about
- If no results, suggest query modifications
- If query is empty, show syntax help
