# Gmail query notes

`is:unread` filters unread mail without changing labels. `after:` and `before:` bound provider dates. A result bound must also be passed to `messages.list` as `maxResults`; date filters alone are not enough. `messages.get` with `format=full` retrieves data without marking a message read. Never call mutation endpoints for search or summary.
