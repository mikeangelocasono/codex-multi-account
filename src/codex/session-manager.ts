/**
 * Reading the shared session index.
 *
 * Sessions are not owned by an account. They live in the shared runtime home,
 * which is why `cma sessions` shows the same list no matter who is signed in,
 * and why any account can resume any session.
 *
 * Two sources, in order of preference:
 *
 *   1. `state_<n>.sqlite`, table `threads` - the same index Codex's own resume
 *      picker uses. It has titles, timestamps and archive state.
 *   2. `sessions/**\/rollout-*.jsonl` headers - always present, but only carries
 *      what the first line of the transcript records.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeHome } from '../storage/paths.js';
import { sessionsDir, stateDbPath } from './codex-home.js';
import { openDatabase } from './sqlite.js';

export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
  source: string;
  model: string | null;
  rolloutPath: string | null;
  origin: 'state-db' | 'rollout-file';
}

export interface ListSessionsOptions {
  /** Include archived sessions. */
  includeArchived?: boolean;
  /** Include sub-agent threads, which are noise in a picker. */
  includeSubagents?: boolean;
  /** Only sessions whose cwd matches this prefix. */
  cwd?: string;
  limit?: number;
  home?: string;
}

interface ThreadRow {
  id?: unknown;
  rollout_path?: unknown;
  cwd?: unknown;
  title?: unknown;
  first_user_message?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  archived?: unknown;
  source?: unknown;
  model?: unknown;
}

function toDate(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex stores whole seconds in `threads`; tolerate millisecond columns too.
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(0);
}

function normalizeCwd(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Codex records Windows extended-length paths; they are noise in a listing.
  return value.replace(/^\\\\\?\\/, '');
}

/** `source` is either a plain string or JSON describing a spawned sub-agent. */
function normalizeSource(value: unknown): { label: string; isSubagent: boolean } {
  if (typeof value !== 'string' || value.length === 0) return { label: 'unknown', isSubagent: false };
  if (!value.startsWith('{')) return { label: value, isSubagent: false };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.subagent) return { label: 'subagent', isSubagent: true };
  } catch {
    /* fall through to the raw label */
  }
  return { label: 'subagent', isSubagent: true };
}

function fromStateDb(home: string): SessionRecord[] | null {
  const dbPath = stateDbPath(home);
  if (!dbPath) return null;

  const db = openDatabase(dbPath, { readOnly: true });
  if (!db) return null;

  try {
    const rows = db.all(
      `SELECT id, rollout_path, cwd, title, first_user_message, created_at, updated_at,
              archived, source, model
         FROM threads
        ORDER BY updated_at DESC`,
    ) as ThreadRow[];

    return rows.map((row) => {
      const source = normalizeSource(row.source);
      const title =
        (typeof row.title === 'string' && row.title.trim()) ||
        (typeof row.first_user_message === 'string' && row.first_user_message.trim()) ||
        '';
      return {
        id: String(row.id ?? ''),
        title,
        cwd: normalizeCwd(row.cwd),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
        archived: row.archived === 1 || row.archived === true,
        source: source.label,
        model: typeof row.model === 'string' ? row.model : null,
        rolloutPath: typeof row.rollout_path === 'string' ? row.rollout_path : null,
        origin: 'state-db' as const,
      };
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function walkRollouts(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A missing or unreadable sessions/ directory simply means no sessions.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkRollouts(full, out, depth + 1);
    } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/**
 * First line of a rollout file, read with a bounded buffer.
 * These transcripts reach hundreds of megabytes; only the header is wanted.
 */
function readFirstLine(file: string, maxBytes = 64 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    if (read === 0) return null;
    const slice = buffer.subarray(0, read);
    const newline = slice.indexOf(10);
    return (newline === -1 ? slice : slice.subarray(0, newline)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do if the descriptor is already gone */
      }
    }
  }
}

function fromRolloutFiles(home: string): SessionRecord[] {
  const files: string[] = [];
  walkRollouts(sessionsDir(home), files);

  const records: SessionRecord[] = [];
  for (const file of files) {
    const header = readFirstLine(file);
    if (header === null) continue;

    try {
      const parsed = JSON.parse(header) as { payload?: Record<string, unknown> };
      const payload = parsed.payload ?? {};
      const id = typeof payload.session_id === 'string' ? payload.session_id : String(payload.id ?? '');
      if (!id) continue;
      const source = normalizeSource(payload.source);
      const stamp = toDate(payload.timestamp);
      const mtime = statSync(file).mtime;
      records.push({
        id,
        title: '',
        cwd: normalizeCwd(payload.cwd),
        createdAt: stamp,
        updatedAt: mtime,
        archived: false,
        source: source.label,
        model: null,
        rolloutPath: file,
        origin: 'rollout-file',
      });
    } catch {
      continue;
    }
  }

  return records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** All sessions Codex can resume from the shared runtime home. */
export function listSessions(options: ListSessionsOptions = {}): SessionRecord[] {
  const home = options.home ?? runtimeHome();
  const records = fromStateDb(home) ?? fromRolloutFiles(home);

  let filtered = records.filter((record) => record.id.length > 0);
  if (!options.includeArchived) filtered = filtered.filter((record) => !record.archived);
  if (!options.includeSubagents) filtered = filtered.filter((record) => record.source !== 'subagent');
  if (options.cwd) {
    const wanted = normalizeCwd(options.cwd).toLowerCase();
    filtered = filtered.filter((record) => record.cwd.toLowerCase() === wanted);
  }
  filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit ? filtered.slice(0, options.limit) : filtered;
}

export function findSession(id: string, options: ListSessionsOptions = {}): SessionRecord | null {
  const all = listSessions({ ...options, includeArchived: true, includeSubagents: true });
  return all.find((record) => record.id === id) ?? null;
}

export function latestSession(options: ListSessionsOptions = {}): SessionRecord | null {
  return listSessions(options)[0] ?? null;
}

/**
 * Point the thread index at rollout files that have moved.
 *
 * `threads.rollout_path` is absolute, so importing an existing Codex home
 * leaves every row pointing at the old location. Rewriting is idempotent:
 * rows already under the new root do not match the prefix.
 */
export function rewriteRolloutPaths(
  dbPath: string,
  fromPrefix: string,
  toPrefix: string,
): { updated: number } {
  const db = openDatabase(dbPath, { readOnly: false });
  if (!db) return { updated: 0 };

  try {
    const before = db.all(
      'SELECT COUNT(*) AS n FROM threads WHERE rollout_path LIKE ?',
      `${fromPrefix}%`,
    );
    const count = Number((before[0]?.n as number | undefined) ?? 0);
    if (count === 0) return { updated: 0 };

    db.run(
      `UPDATE threads
          SET rollout_path = ? || SUBSTR(rollout_path, ?)
        WHERE rollout_path LIKE ?`,
      toPrefix,
      fromPrefix.length + 1,
      `${fromPrefix}%`,
    );
    return { updated: count };
  } catch {
    return { updated: 0 };
  } finally {
    db.close();
  }
}
