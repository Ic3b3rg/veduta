---
name: gmail-connector
description: Read a scoped Gmail Mailbox with the native read-only Gmail API tools.
metadata:
  veduta.version: '1'
  veduta.tools: 'resolve_mailbox_scope,search_mailbox'
  veduta.provider: gmail
  veduta.intent: '(mail|gmail|inbox|newsletter|receipt)'
---

# Gmail connector

Use `resolve_mailbox_scope` then `search_mailbox` for a Gmail account. The Gateway owns OAuth refresh, `users.messages.list`, and bounded `users.messages.get` calls. The connector never requests more than `gmail.readonly` and never invokes `messages.modify`, Watch, thread mutation, or attachment endpoints.

Connection setup only checks account identity. It does not imply permission to scan the inbox. Every search must derive from the current trusted user request and belong to the active Space. The Gmail query in the resolved scope is the exact provider query used by the Gateway. Results are reduced behind the tool-less quarantined reader before the Agent sees them.

If a connection is missing or needs authorization, direct the user to Mail connections in Settings. Do not ask for OAuth tokens in Chat. If the provider returns an authorization or transport error, report it accurately and leave the old Mailbox Surface unchanged.

For native query semantics, load [Gmail query notes](references/query-notes.md) when needed.
