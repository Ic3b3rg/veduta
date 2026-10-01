import type { DatabaseSync } from 'node:sqlite'
import { ensureSqliteColumn } from './sqlite-rows.ts'

/** Initializes and migrates the durable Surface store. */
export function initializeSurfaceSchema(db: DatabaseSync): void {
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists surfaces (
      id text primary key,
      space_id text not null,
      title text not null,
      tree_json text not null,
      state_json text not null,
      version integer not null,
      tree_version integer not null,
      updated_at text not null,
      updated_by text not null,
      archived integer not null default 0,
      daemon_owned integer not null default 0,
      pinned integer not null default 0,
      tree_updated_at text not null default '',
      template_id text,
      template_space_id text,
      content_origin text not null default 'trusted:user',
      presentation text not null default 'standard' check (presentation in ('standard', 'full')),
      validity_json text
    );
    create index if not exists surfaces_space_active
      on surfaces (space_id, archived, title);

    create table if not exists surface_events (
      cursor integer primary key,
      at text not null,
      space_id text not null,
      surface_id text not null,
      kind text not null default 'patch',
      event_json text not null
    );

    create table if not exists surface_commit_baseline (
      id integer primary key check (id = 1),
      legacy_surface_cursor integer not null,
      recorded_at text not null
    );

    create table if not exists surface_commits (
      sequence integer primary key autoincrement,
      id text not null unique,
      space_id text not null,
      surface_event_cursor integer,
      event_json text not null,
      destination text not null,
      correlation_id text,
      state text not null check (state in ('recovery_pending', 'delivered')),
      delivered_at text
    );
    create index if not exists surface_commits_pending_space
      on surface_commits (space_id, state, sequence);
    create unique index if not exists surface_commits_surface_cursor
      on surface_commits (surface_event_cursor)
      where surface_event_cursor is not null;

    create table if not exists idempotency_keys (
      key text primary key,
      event_cursor integer not null references surface_events(cursor)
    );

    create table if not exists surface_presentation_idempotency_keys (
      key text primary key,
      surface_id text not null references surfaces(id),
      presentation text not null check (presentation in ('standard', 'full'))
    );

    create table if not exists fast_action_intents (
      intent_id text primary key, outcome_json text not null, commit_id text, event_cursor integer
    );
    create table if not exists fast_action_consumers (name text primary key);
    create table if not exists fast_action_receipts (
      intent_id text not null references fast_action_intents(intent_id),
      consumer text not null references fast_action_consumers(name), received integer not null default 0,
      primary key (intent_id, consumer)
    );

    create table if not exists automation_outcome_idempotency_keys (
      key text primary key,
      event_cursor integer not null references surface_events(cursor)
    );

    create table if not exists surface_order_state (
      space_id text primary key,
      cursor integer not null
    );

    create table if not exists surface_order_items (
      surface_id text primary key references surfaces(id),
      space_id text not null,
      group_name text not null check (group_name in ('pinned', 'regular')),
      position integer not null check (position >= 0)
    );
    create unique index if not exists surface_order_items_space_group_position
      on surface_order_items (space_id, group_name, position);

    create table if not exists agent_turns (
      id integer primary key autoincrement,
      at text not null,
      space_id text not null,
      surface_id text not null,
      atom_id text not null,
      action_name text not null,
      payload_json text not null,
      surface_json text not null,
      atom_json text not null,
      content_origin text not null,
      status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
      idempotency_key text unique,
      request_json text not null,
      result_json text
    );

    create table if not exists tree_proposals (
      id integer primary key autoincrement,
      surface_id text not null,
      space_id text not null,
      operations_json text not null,
      expected_tree_version integer not null,
      origin text not null,
      status text not null default 'pending',
      created_at text not null,
      resolved_at text,
      resolved_by text check (resolved_by is null or resolved_by = 'trusted:user')
    );
    create index if not exists tree_proposals_surface_status
      on tree_proposals (surface_id, status);
  `)

  // `create table if not exists` does not update databases created by older
  // versions, so each additive column is also migrated explicitly.
  ensureSqliteColumn(db, 'surface_events', 'kind', "text not null default 'patch'")
  // Pre-lifecycle requests have no execution receipt or trustworthy captured origin.
  // They must never be replayed automatically after this upgrade (issue #146).
  ensureSqliteColumn(
    db,
    'agent_turns',
    'content_origin',
    "text not null default 'untrusted:legacy-action'",
  )
  ensureSqliteColumn(db, 'agent_turns', 'status', "text not null default 'failed'")
  ensureSqliteColumn(db, 'agent_turns', 'idempotency_key', 'text')
  ensureSqliteColumn(db, 'agent_turns', 'request_json', "text not null default ''")
  ensureSqliteColumn(db, 'agent_turns', 'result_json', 'text')
  db.exec(`
    update agent_turns
    set result_json = '{"error":"Recorded before durable execution tracking; inspect canonical outcome before retrying"}'
    where status = 'failed' and result_json is null and request_json = ''
      and content_origin = 'untrusted:legacy-action';
    create unique index if not exists agent_turns_idempotency
      on agent_turns (idempotency_key) where idempotency_key is not null;
    create index if not exists agent_turns_active_space
      on agent_turns (space_id) where status in ('queued', 'running');
  `)
  db.exec(`
    insert or ignore into surface_commit_baseline (id, legacy_surface_cursor, recorded_at)
    values (1, (select coalesce(max(cursor), 0) from surface_events), datetime('now'))
  `)
  ensureSqliteColumn(db, 'surfaces', 'daemon_owned', 'integer not null default 0')
  ensureSqliteColumn(db, 'surfaces', 'pinned', 'integer not null default 0')
  ensureSqliteColumn(db, 'surfaces', 'tree_updated_at', "text not null default ''")
  // Treat a legacy row's last known update as its tree update. Leaving the
  // new column empty would make it immediately satisfy any stability cutoff.
  db.exec(`update surfaces set tree_updated_at = updated_at where tree_updated_at = ''`)
  ensureSqliteColumn(db, 'surfaces', 'template_id', 'text')
  ensureSqliteColumn(db, 'surfaces', 'template_space_id', 'text')
  ensureSqliteColumn(db, 'surfaces', 'content_origin', "text not null default 'trusted:user'")
  ensureSqliteColumn(
    db,
    'surfaces',
    'presentation',
    "text not null default 'standard' check (presentation in ('standard', 'full'))",
  )
  ensureSqliteColumn(db, 'tree_proposals', 'resolved_by', 'text')
  db.exec(`
    update tree_proposals
    set resolved_by = 'trusted:user'
    where status in ('accepted', 'rejected') and resolved_by is null
  `)
}
