/** Shared by fresh PushStore creation and the forward-only v4 data migration. */
export const PUSH_ANNOUNCEMENT_SCHEMA = `
  create table if not exists push_announcements (
    id text primary key,
    outcome text not null
  );
  create table if not exists push_announcement_targets (
    announcement_id text not null,
    endpoint text not null,
    p256dh text not null,
    auth text not null,
    primary key (announcement_id, endpoint)
  );
`
