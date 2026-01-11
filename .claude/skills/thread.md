---
name: thread
description: View a specific email conversation thread
---

# /thread - View Conversation Thread

Pull up a specific email conversation thread.

## Usage

```
/thread <subject or search query>
```

## Steps

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` with the provided query to find matching threads
3. If multiple matches, present options and ask user to choose
4. If single match or user selected, use `gmail_getThread` with format: 'full' to get complete thread
5. Display the full conversation

## Output Format

### If multiple matches:
```
🔍 Found {count} matching threads:

1. {subject} - {participants} - {date} ({message_count} messages)
2. {subject} - {participants} - {date} ({message_count} messages)
...

Which thread? (enter number)
```

### Thread display:
```
📧 Thread: {subject}
Participants: {list of participants}
Messages: {count}

---
From: {sender}
Date: {date}

{message body}

---
From: {sender}
Date: {date}

{message body}

---
...
```

## Notes

- Show messages in chronological order (oldest first)
- Include full message body, not just snippets
- Show clear separators between messages
- If thread is very long (10+ messages), summarize older messages and show recent in full
- Extract just the new content from replies (strip quoted text if possible)
- If no matches found, suggest broadening the search
