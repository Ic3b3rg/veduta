# Mailbox scope examples

- “Show unread receipts from this week”: one selected account, unread filter, receipts query, Monday through the next Monday in the user's timezone, bounded results.
- “Summarize the last five newsletters”: one selected account, newsletter query, newest five. The order is by provider timestamp.
- “Read my latest email” or “Leggi la mia ultima mail”: summarize the newest Inbox message, with no topic or unread filter and no read-state mutation. A subsequent account answer completes the same task.
- “The latest two from the shop, including archived messages”: retain the sender and count; include archived mail only because the user explicitly requested it.
- “Check my mail”: ask for a bounded query or time window before contacting the provider.
- If two accounts match and the user did not choose one, ask which account to use before contacting either provider.
