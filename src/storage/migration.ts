/**
 * Importing an existing Codex home into the shared runtime.
 *
 * The user's own `~/.codex` is read-only as far as this module is concerned.
 * Nothing is moved, renamed or deleted there; every operation is a copy into
 * `runtime/`, and running the import twice copies only what is missing.
 *
 * One rewrite is unavoidable: `state_<n>.sqlite` stores an absolute
 * `rollout_path` per thread, so after the transcripts move the index has to be
 * pointed at their new location or resume cannot find them.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { CmaError } from '../utils/errors.js';
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from './atomic.js';
import { importHistoryPath, runtimeHome } from './paths.js';
import { PROFILE_STATE, TRANSIENT_STATE, resolveSharedEntries } from '../codex/codex-home.js';
import { backupDatabase, openDatabase } from '../codex/sqlite.js';
import { findVersionedDb, sessionsDir } from '../codex/codex-home.js';
import { rewriteRolloutPaths } from '../codex/session-manager.js';

export interface PlanEntry {
  name: string;
  kind: 'file' | 'dir';
  bytes: number;
  why: string;
}

export interface ImportPlan {
  source: string;
  target: string;
  entries: PlanEntry[];
  totalBytes: number;
  sessionBytes: number;
  hasAuth: boolean;
  includeSessions: boolean;
  includePlugins: boolean;
}

export interface ImportResult {
  copiedFiles: number;
  skippedFiles: number;
  copiedBytes: number;
  rolloutPathsRewritten: number;
  /** Databases folded into an existing runtime rather than overwritten. */
  mergedDatabases: number;
  /** Rows added by those merges. */
  mergedRows: number;
  authImported: boolean;
  backupPath?: string;
}

const isTransient = (name: string): boolean =>
  TRANSIENT_STATE.some((pattern) =>
    pattern.includes('*')
      ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(name)
      : pattern === name,
  );

/** Transcripts and the two databases that index them. */
function isSessionState(name: string): boolean {
  return (
    name === 'sessions' ||
    /^state_\d+\.sqlite(-wal|-shm)?$/.test(name) ||
    /^thread_history_\d+\.sqlite(-wal|-shm)?$/.test(name)
  );
}

function dirSize(path: string, budgetFiles = 200_000): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [path];
  while (stack.length > 0 && files < budgetFiles) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(full);
      } else {
        bytes += info.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function entrySize(path: string): number {
  try {
    const info = statSync(path);
    return info.isDirectory() ? dirSize(path).bytes : info.size;
  } catch {
    return 0;
  }
}

export interface PlanOptions {
  source: string;
  includeSessions?: boolean;
  includePlugins?: boolean;
}

/** Work out what an import would do, without doing it. */
export function planImport(options: PlanOptions): ImportPlan {
  const source = resolve(options.source);
  const target = runtimeHome();
  const includeSessions = options.includeSessions ?? true;
  const includePlugins = options.includePlugins ?? true;

  if (resolve(target) === source) {
    throw new CmaError('INVALID_ARGUMENT', 'The import source is the runtime home itself.', {
      hint: 'Point --from at your original Codex home, e.g. ~/.codex.',
    });
  }

  const shared = resolveSharedEntries(source);
  const entries: PlanEntry[] = [];
  let sessionBytes = 0;

  for (const item of shared) {
    if (isTransient(item.name)) continue;
    // WAL sidecars are never planned separately: a database is copied with the
    // online-backup API, or with its sidecars, by the code that handles it.
    if (/\.sqlite-(wal|shm)$/.test(item.name)) continue;
    if (!includePlugins && item.name === 'plugins') continue;
    // Skipping transcripts means skipping the indexes that point at them:
    // importing the thread index alone would list sessions whose rollout files
    // are not here, and every one of them would fail to resume.
    if (!includeSessions && isSessionState(item.name)) continue;
    const bytes = entrySize(join(source, item.name));
    if (item.name === 'sessions') sessionBytes = bytes;
    entries.push({
      name: item.name,
      kind: item.kind,
      bytes,
      why: 'shared state',
    });
  }

  return {
    source,
    target,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sessionBytes,
    hasAuth: fileExists(join(source, PROFILE_STATE[0]!.name)),
    includeSessions,
    includePlugins,
  };
}

interface CopyStats {
  copied: number;
  skipped: number;
  bytes: number;
}

/**
 * Timestamps survive a copy only to millisecond precision (`utimes` takes a
 * Date), while NTFS records 100-nanosecond ticks. Without a tolerance the
 * restored mtime always compares as *older* than the source and every file
 * would be copied again on the next run.
 */
const MTIME_TOLERANCE_MS = 2000;

/**
 * Copy a file only when the destination is missing or differs.
 * Size plus mtime is enough here: rollout files are append-only, so a changed
 * transcript always changes size, and databases go through the SQLite path.
 */
function copyFileIfNeeded(source: string, target: string, force: boolean, stats: CopyStats): void {
  let sourceInfo;
  try {
    sourceInfo = statSync(source);
  } catch {
    return;
  }

  if (!force && fileExists(target)) {
    try {
      const targetInfo = statSync(target);
      const sameSize = targetInfo.size === sourceInfo.size;
      const notOlder = targetInfo.mtimeMs >= sourceInfo.mtimeMs - MTIME_TOLERANCE_MS;
      if (sameSize && notOlder) {
        stats.skipped += 1;
        return;
      }
    } catch {
      /* fall through and copy */
    }
  }

  ensureDir(join(target, '..'));
  copyFileSync(source, target);
  try {
    utimesSync(target, sourceInfo.atime, sourceInfo.mtime);
  } catch {
    /* timestamps are an optimisation for the next run, not a requirement */
  }
  stats.copied += 1;
  stats.bytes += sourceInfo.size;
}

function copyDirIncremental(source: string, target: string, force: boolean, stats: CopyStats): void {
  let entries: string[];
  try {
    entries = readdirSync(source);
  } catch {
    return;
  }
  mkdirSync(target, { recursive: true });

  for (const entry of entries) {
    if (isTransient(entry)) continue;
    const from = join(source, entry);
    const to = join(target, entry);
    let info;
    try {
      info = statSync(from);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      copyDirIncremental(from, to, force, stats);
    } else {
      copyFileIfNeeded(from, to, force, stats);
    }
  }
}

export interface RunImportOptions {
  plan: ImportPlan;
  force?: boolean;
  /** Progress callback, called once per top-level entry. */
  onProgress?: (message: string) => void;
}

/** Execute a plan. Safe to run repeatedly. */
export async function runImport(options: RunImportOptions): Promise<ImportResult> {
  const { plan } = options;
  const force = options.force ?? false;
  const report = options.onProgress ?? (() => undefined);

  ensureDir(plan.target);

  const stats: CopyStats = { copied: 0, skipped: 0, bytes: 0 };
  let merges = 0;
  let mergedRows = 0;

  for (const entry of plan.entries) {
    const from = join(plan.source, entry.name);
    const to = join(plan.target, entry.name);

    if (entry.kind === 'dir') {
      report(`copying ${entry.name}/`);
      copyDirIncremental(from, to, force, stats);
      continue;
    }

    if (entry.name.endsWith('.sqlite')) {
      if (fileExists(to)) {
        // The runtime already has this database and it may hold sessions
        // created since the last import. Merge rather than overwrite: a
        // snapshot here would silently delete newer threads.
        report(`merging ${entry.name}`);
        const outcome = mergeDatabase(from, to);
        if (outcome.merged) {
          merges += 1;
          mergedRows += outcome.rows;
        } else {
          report(`  left ${entry.name} untouched (${outcome.reason ?? 'merge unavailable'})`);
        }
        continue;
      }

      report(`snapshotting ${entry.name}`);
      const ok = await backupDatabase(from, to);
      if (ok) {
        stats.copied += 1;
        stats.bytes += entrySize(from);
      } else {
        // No online-backup support: fall back to a plain copy of the database
        // and its write-ahead sidecars.
        copyFileIfNeeded(from, to, force, stats);
        for (const suffix of ['-wal', '-shm']) {
          if (fileExists(from + suffix)) copyFileIfNeeded(from + suffix, to + suffix, force, stats);
        }
      }
      continue;
    }

    if (entry.name.endsWith('.sqlite-wal') || entry.name.endsWith('.sqlite-shm')) {
      // Handled with their database above.
      continue;
    }

    report(`copying ${entry.name}`);
    copyFileIfNeeded(from, to, force, stats);
  }

  // Point the thread index at the transcripts' new home.
  let rewritten = 0;
  const targetStateDb = findVersionedDb(plan.target, 'state');
  if (targetStateDb && plan.includeSessions) {
    const fromPrefix = sessionsDir(plan.source);
    const toPrefix = sessionsDir(plan.target);
    report('re-pointing the thread index at the imported transcripts');
    rewritten = rewriteRolloutPaths(targetStateDb, fromPrefix, toPrefix).updated;
  }

  recordImport(plan, stats, rewritten);

  return {
    copiedFiles: stats.copied,
    skippedFiles: stats.skipped,
    copiedBytes: stats.bytes,
    rolloutPathsRewritten: rewritten,
    mergedDatabases: merges,
    mergedRows,
    authImported: false,
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Fold the rows of one Codex database into another without losing either side.
 *
 * `INSERT OR IGNORE` keeps whatever the runtime already has and adds only what
 * is missing, which is the behaviour a repeated import needs: threads created
 * since the first import must survive.
 *
 * Any failure leaves the target untouched. Half-merging a thread index would
 * be worse than not merging at all.
 */
export function mergeDatabase(
  source: string,
  target: string,
): { merged: boolean; rows: number; reason?: string } {
  const db = openDatabase(target, { readOnly: false });
  if (!db) return { merged: false, rows: 0, reason: 'SQLite is unavailable' };

  let attached = false;
  try {
    db.run('ATTACH DATABASE ? AS src', source);
    attached = true;

    const sourceTables = db
      .all("SELECT name FROM src.sqlite_master WHERE type = 'table'")
      .map((row) => String(row.name))
      .filter((name) => IDENTIFIER.test(name) && !name.startsWith('sqlite_'))
      .filter((name) => name !== '_sqlx_migrations');

    const targetTables = new Set(
      db
        .all("SELECT name FROM main.sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name)),
    );

    let rows = 0;
    db.run('BEGIN');
    for (const table of sourceTables) {
      if (!targetTables.has(table)) continue;
      const before = Number(db.all(`SELECT COUNT(*) AS n FROM main."${table}"`)[0]?.n ?? 0);
      db.run(`INSERT OR IGNORE INTO main."${table}" SELECT * FROM src."${table}"`);
      const after = Number(db.all(`SELECT COUNT(*) AS n FROM main."${table}"`)[0]?.n ?? 0);
      rows += after - before;
    }
    db.run('COMMIT');
    return { merged: true, rows };
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* there may be no open transaction */
    }
    return { merged: false, rows: 0, reason: (error as Error).message };
  } finally {
    if (attached) {
      try {
        db.run('DETACH DATABASE src');
      } catch {
        /* the connection is about to close anyway */
      }
    }
    db.close();
  }
}

interface ImportHistory {
  imports: Array<{
    at: string;
    source: string;
    target: string;
    copiedFiles: number;
    skippedFiles: number;
    copiedBytes: number;
    rolloutPathsRewritten: number;
    includedSessions: boolean;
  }>;
}

function recordImport(plan: ImportPlan, stats: CopyStats, rewritten: number): void {
  const history = readJsonFile<ImportHistory>(importHistoryPath()) ?? { imports: [] };
  history.imports.push({
    at: new Date().toISOString(),
    source: plan.source,
    target: plan.target,
    copiedFiles: stats.copied,
    skippedFiles: stats.skipped,
    copiedBytes: stats.bytes,
    rolloutPathsRewritten: rewritten,
    includedSessions: plan.includeSessions,
  });
  // Keep the file small; the last few runs are all anyone reads.
  history.imports = history.imports.slice(-20);
  writeJsonFile(importHistoryPath(), history, { mode: 0o600 });
}

export function previousImports(): ImportHistory['imports'] {
  return readJsonFile<ImportHistory>(importHistoryPath())?.imports ?? [];
}

/** Human-readable byte count for plan output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Used by the import command to describe where things came from. */
export function describeRelative(from: string, to: string): string {
  const rel = relative(from, to);
  return rel.length === 0 ? '.' : rel;
}
