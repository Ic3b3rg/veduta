# Gmail query notes

`is:unread` filters unread mail without changing labels. `after:` and `before:` bound provider dates. A result bound must also be passed to `messages.list` as `maxResults`; date filters alone are not enough. `messages.get` with `format=full` retrieves data without marking a message read. Never call mutation endpoints for search or summary.

For newest-N, the Gateway first establishes a complete recent interval with at most 20 IDs, using bounded timestamp probes when the list is paginated. It retrieves only timestamp/label metadata for those candidates, sorts by `internalDate`, and fetches full bodies only for the selected N. A first list result alone does not establish recency. If the bound cannot establish the result, report that limitation rather than claiming to have read the latest message.
