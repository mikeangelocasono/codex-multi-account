import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox } from './helpers.js';
import type { Sandbox } from './helpers.js';
import {
  findSession,
  latestSession,
  listSessions,
  rewriteRolloutPaths,
} from '../src/codex/session-manager.js';
import { openDatabase, sqliteAvailable } from '../src/codex/sqlite.js';
import { findVersionedDb, resolveSharedEntries, looksLikeCodexHome } from '../src/codex/codex-home.js';
import { runtimeHome } from '../src/storage/paths.js';
import { ensureHomeLayout } from '../src/accounts/profile-store.js';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
  ensureHomeLayout();
});

afterEach(() => {
  sandbox.cleanup();
});

const SESSION_A = '019fdafe-2982-77b0-87aa-7b375a526b79';
const SESSION_B = '01a01803-e02e-7722-8cb4-ec03dbad2d58';

function createStateDb(home: string, rows: Array<Record<string, unknown>>): string {
  const path = join(home, 'state_5.sqlite');
  const db = openDatabase(path, { readOnly: false });
  if (!db) throw new Error('sqlite unavailable');

  db.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    first_user_message TEXT NOT NULL DEFAULT '',
    model TEXT
  )`);

  for (const row of rows) {
    db.run(
      `INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
         sandbox_policy, approval_mode, first_user_message, archived, model)
       VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?, ?)`,
      row.id,
      row.rollout_path,
      row.created_at,
      row.updated_at,
      row.source,
      row.cwd,
      row.title,
      row.first_user_message ?? '',
      row.archived ?? 0,
      row.model ?? 'gpt-5.6-sol',
    );
  }
  db.close();
  return path;
}

function writeRollout(home: string, id: string, cwd: string): string {
  const dir = join(home, 'sessions', '2026', '08', '20');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-20T10-00-00-${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: '2026-08-20T10:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: id, id, timestamp: '2026-08-20T10:00:00.000Z', cwd, source: 'cli' },
    })}\n${JSON.stringify({ type: 'turn', payload: { text: 'x'.repeat(4096) } })}\n`,
    'utf8',
  );
  return path;
}

describe.runIf(sqliteAvailable())('session listing from the state database', () => {
  it('lists sessions newest first, hiding sub-agents and archived threads', () => {
    const home = runtimeHome();
    mkdirSync(home, { recursive: true });
    createStateDb(home, [
      {
        id: SESSION_A,
        rollout_path: writeRollout(home, SESSION_A, 'C:\\Projects\\Alpha'),
        created_at: 1_787_000_000,
        updated_at: 1_787_000_100,
        source: 'cli',
        cwd: '\\\\?\\C:\\Projects\\Alpha',
        title: 'Alpha work',
      },
      {
        id: SESSION_B,
        rollout_path: writeRollout(home, SESSION_B, 'C:\\Projects\\Beta'),
        created_at: 1_787_000_200,
        updated_at: 1_787_000_300,
        source: 'cli',
        cwd: '\\\\?\\C:\\Projects\\Beta',
        title: 'Beta work',
      },
      {
        id: '019ff44a-ee56-7170-9fb7-c5c7f60397eb',
        rollout_path: 'nowhere.jsonl',
        created_at: 1_787_000_400,
        updated_at: 1_787_000_500,
        source: JSON.stringify({ subagent: { thread_spawn: { depth: 1 } } }),
        cwd: 'C:\\Projects\\Beta',
        title: '',
      },
      {
        id: '019fdc9c-86e3-7bd2-add2-100f76cd725c',
        rollout_path: 'archived.jsonl',
        created_at: 1_787_000_600,
        updated_at: 1_787_000_700,
        source: 'cli',
        cwd: 'C:\\Projects\\Gamma',
        title: 'Archived',
        archived: 1,
      },
    ]);

    const sessions = listSessions();
    expect(sessions.map((session) => session.id)).toEqual([SESSION_B, SESSION_A]);
    expect(sessions[0]!.cwd).toBe('C:\\Projects\\Beta');
    expect(sessions[0]!.title).toBe('Beta work');
    expect(sessions[0]!.origin).toBe('state-db');
  });

  it('can include archived threads and sub-agents on request', () => {
    const home = runtimeHome();
    mkdirSync(home, { recursive: true });
    createStateDb(home, [
      {
        id: SESSION_A,
        rollout_path: 'a.jsonl',
        created_at: 1,
        updated_at: 2,
        source: 'cli',
        cwd: 'C:\\A',
        title: 'A',
      },
      {
        id: SESSION_B,
        rollout_path: 'b.jsonl',
        created_at: 3,
        updated_at: 4,
        source: 'cli',
        cwd: 'C:\\B',
        title: 'B',
        archived: 1,
      },
    ]);

    expect(listSessions().map((s) => s.id)).toEqual([SESSION_A]);
    expect(listSessions({ includeArchived: true }).map((s) => s.id)).toEqual([SESSION_B, SESSION_A]);
  });

  it('finds a specific session and the newest one', () => {
    const home = runtimeHome();
    mkdirSync(home, { recursive: true });
    createStateDb(home, [
      { id: SESSION_A, rollout_path: 'a.jsonl', created_at: 1, updated_at: 2, source: 'cli', cwd: 'C:\\A', title: 'A' },
      { id: SESSION_B, rollout_path: 'b.jsonl', created_at: 3, updated_at: 9, source: 'cli', cwd: 'C:\\B', title: 'B' },
    ]);

    expect(findSession(SESSION_A)?.title).toBe('A');
    expect(findSession('missing-id')).toBeNull();
    expect(latestSession()?.id).toBe(SESSION_B);
  });

  it('re-points rollout paths after transcripts move, idempotently', () => {
    const home = runtimeHome();
    mkdirSync(home, { recursive: true });
    const oldRoot = join(sandbox.root, 'previous-codex-home', 'sessions');
    const newRoot = join(home, 'sessions');
    const dbPath = createStateDb(home, [
      {
        id: SESSION_A,
        rollout_path: join(oldRoot, '2026', 'a.jsonl'),
        created_at: 1,
        updated_at: 2,
        source: 'cli',
        cwd: 'C:\\A',
        title: 'A',
      },
    ]);

    const first = rewriteRolloutPaths(dbPath, oldRoot, newRoot);
    expect(first.updated).toBe(1);
    expect(findSession(SESSION_A)?.rolloutPath).toBe(join(newRoot, '2026', 'a.jsonl'));

    // Running it again changes nothing.
    expect(rewriteRolloutPaths(dbPath, oldRoot, newRoot).updated).toBe(0);
  });
});

describe('session listing without a state database', () => {
  it('falls back to reading rollout headers', () => {
    const home = runtimeHome();
    mkdirSync(home, { recursive: true });
    writeRollout(home, SESSION_A, 'C:\\Projects\\Alpha');
    writeRollout(home, SESSION_B, 'C:\\Projects\\Beta');

    const sessions = listSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual([SESSION_B, SESSION_A].sort());
    expect(sessions[0]!.origin).toBe('rollout-file');
    expect(sessions.every((s) => s.cwd.startsWith('C:\\Projects'))).toBe(true);
  });

  it('returns nothing when the runtime is empty', () => {
    expect(listSessions()).toEqual([]);
    expect(latestSession()).toBeNull();
  });
});

describe('codex home introspection', () => {
  it('picks the highest-numbered state database', () => {
    const home = join(sandbox.root, 'codex');
    mkdirSync(home, { recursive: true });
    for (const name of ['state_2.sqlite', 'state_10.sqlite', 'state_9.sqlite', 'state.sqlite']) {
      writeFileSync(join(home, name), '');
    }
    expect(findVersionedDb(home, 'state')).toBe(join(home, 'state_10.sqlite'));
  });

  it('recognises a Codex home and enumerates its shared state', () => {
    const home = join(sandbox.root, 'codex2');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model = "x"');
    writeFileSync(join(home, 'auth.json'), '{}');
    writeFileSync(join(home, 'state_5.sqlite'), '');
    writeFileSync(join(home, 'state_5.sqlite-wal'), '');
    writeFileSync(join(home, 'history.jsonl'), '');

    expect(looksLikeCodexHome(home)).toBe(true);
    const names = resolveSharedEntries(home).map((entry) => entry.name);
    expect(names).toContain('sessions');
    expect(names).toContain('config.toml');
    expect(names).toContain('state_5.sqlite');
    expect(names).toContain('state_5.sqlite-wal');
    // The credential is never part of shared state.
    expect(names).not.toContain('auth.json');
  });

  it('does not mistake an arbitrary directory for a Codex home', () => {
    const home = join(sandbox.root, 'empty');
    mkdirSync(home, { recursive: true });
    expect(looksLikeCodexHome(home)).toBe(false);
  });
});
