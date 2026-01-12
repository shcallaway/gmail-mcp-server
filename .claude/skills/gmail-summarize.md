---
name: gmail-summarize
description: Summarize an email thread or set of emails on a topic
---

# /gmail-summarize - Summarize Emails

Generate a concise summary of an email thread or collection of emails.

## Usage

```
/gmail-summarize {thread subject or description}
/gmail-summarize emails from {person}
/gmail-summarize emails about {topic}
```

## Steps for Thread Summary

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` to find the thread
3. Use `gmail_getThread` (format: "full") to get all messages
4. Analyze the full conversation
5. Generate structured summary

## Steps for Topic/Person Summary

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` to find relevant emails
3. Use `gmail_getMessage` (format: "summary") for each relevant message
4. Synthesize information across emails
5. Generate structured summary

## Output Format - Thread Summary

```
📋 Thread Summary

Subject: {subject}
Participants: {list of people}
Duration: {first date} → {last date} ({count} messages)

## Key Points
• {main point 1}
• {main point 2}
• {main point 3}

## Decisions Made
• {decision 1}
• {decision 2}

## Action Items
• {person}: {action item}
• {person}: {action item}

## Current Status
{where things stand / what's pending}
```

## Output Format - Topic Summary

```
📋 Summary: {topic}

{count} emails found ({date range})

## Overview
{2-3 sentence synthesis}

## Key Points
• {point from email 1}
• {point from email 2}
• {point from email 3}

## People Involved
• {person} - {their role/contribution}
• {person} - {their role/contribution}

## Timeline
• {date}: {event/update}
• {date}: {event/update}
```

## Notes

- Focus on extracting actionable information
- Identify who said what when it matters for accountability
- Highlight any deadlines or time-sensitive items
- Note any unresolved questions or pending decisions
- For long threads (>10 messages), focus on most recent + key turning points
- If thread is simple (1-2 messages), provide a brief summary instead of full format
- Don't include email signatures, disclaimers, or forwarded headers in summary
- If emails contain conflicting information, note the discrepancy
- Ask for clarification if search returns too many results to summarize effectively
