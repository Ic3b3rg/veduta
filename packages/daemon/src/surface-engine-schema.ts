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
      content_origin text not null default 'trusted:user'
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

    create table if not exists idempotency_keys (
      key text primary key,
      event_cursor integer not null references surface_events(cursor)
    );

    create table if not exists agent_turns (
      id integer primary key autoincrement,
      at text not null,
      space_id text not null,
      surface_id text not null,
      atom_id text not null,
      action_name text not null,
      payload_json text not null,
      surface_json text not null,
      atom_json text not null
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
      resolved_at text
    );
    create index if not exists tree_proposals_surface_status
      on tree_proposals (surface_id, status);
  `)

  // `create table if not exists` does not update databases created by older
  // versions, so each additive column is also migrated explicitly.
  ensureSqliteColumn(db, 'surface_events', 'kind', "text not null default 'patch'")
  ensureSqliteColumn(db, 'surfaces', 'daemon_owned', 'integer not null default 0')
  ensureSqliteColumn(db, 'surfaces', 'pinned', 'integer not null default 0')
  ensureSqliteColumn(db, 'surfaces', 'tree_updated_at', "text not null default ''")
  // Treat a legacy row's last known update as its tree update. Leaving the
  // new column empty would make it immediately satisfy any stability cutoff.
  db.exec(`update surfaces set tree_updated_at = updated_at where tree_updated_at = ''`)
  ensureSqliteColumn(db, 'surfaces', 'template_id', 'text')
  ensureSqliteColumn(db, 'surfaces', 'template_space_id', 'text')
  ensureSqliteColumn(db, 'surfaces', 'content_origin', "text not null default 'trusted:user'")
}
