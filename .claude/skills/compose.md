---
name: compose
description: Draft a new email or reply with context-aware suggestions
---

# /compose - Compose Email

Help draft a new email or reply to an existing thread.

## Usage

```
/compose                          # Start a new email
/compose reply to {description}   # Reply to a specific email
/compose follow up with {person}  # Follow up on recent conversation
```

## Steps for New Email

1. Use `gmail_status` to verify authentication
2. Ask user for: recipient, subject, and key points to cover
3. Draft the email body based on user's input
4. Use `gmail_createDraft` to save the draft
5. Provide the draft for review

## Steps for Reply

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` to find the email to reply to
3. Use `gmail_getMessage` (format: "full") to get the thread context
4. Understand the conversation and what's being asked
5. Ask user what they want to say in response
6. Draft a contextual reply
7. Use `gmail_createDraft` with `replyToMessageId` to create threaded reply
8. Provide the draft for review

## Steps for Follow-up

1. Use `gmail_status` to verify authentication
2. Use `gmail_searchMessages` to find recent emails with that person
3. Use `gmail_getThread` to get full conversation context
4. Draft a follow-up based on the last exchange
5. Use `gmail_createDraft` with `replyToMessageId` to thread it
6. Provide the draft for review

## Output Format

```
📧 Draft Created

To: {recipient}
Subject: {subject}
---
{body}
---

Draft saved. You can:
• Edit and send from Gmail
• Ask me to revise it
• Delete with gmail_deleteDraft({ draftId: "{id}" })
```

## Notes

- Always create a draft, never send directly (no send capability)
- For replies, use `replyToMessageId` to ensure proper threading
- Match the tone of the conversation (formal/casual)
- Keep emails concise unless user asks for detailed content
- If replying, reference specific points from the original email
- Include a clear call-to-action when appropriate
- Ask clarifying questions if user's intent is unclear
- Offer to revise if user wants changes
- Remind user to review before sending - drafts aren't sent automatically
