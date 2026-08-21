/**
 * Thin wrapper around `node:sqlite`.
 *
 * `node:sqlite` ships with Node 22.5+ and is still flagged experimental, so it
 * is imported lazily and every caller has a non-SQLite fallback. The
 * experimental warning is swallowed because it would otherwise print on a
 * plain `cma sessions`, which is not something a user can act on.
 */

import { createRequire } from 'node:module';

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlDatabase {
  all(sql: string, ...params: unknown[]): SqlRow[];
  run(sql: string, ...params: unknown[]): void;
  close(): void;
}

interface StatementLike {
  all(...params: unknown[]): SqlRow[];
  run(...params: unknown[]): unknown;
}

interface DatabaseLike {
  prepare(sql: string): StatementLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseLike;
  /** Present from Node 22.12; used to snapshot a database that may be in use. */
  backup?: (source: DatabaseLike, destination: string, options?: unknown) => Promise<number>;
}

let warningsSilenced = false;

/** Drop only the `node:sqlite` experimental notice; keep every other warning. */
function silenceSqliteWarning(): void {
  if (warningsSilenced) return;
  warningsSilenced = true;

  const existing = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error & { name?: string }) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
    for (const listener of existing) {
      (listener as (value: Error) => void)(warning);
    }
    if (existing.length === 0) {
      process.stderr.write(`${warning.name}: ${warning.message}\n`);
    }
  });
}

let cached: SqliteModule | null | undefined;

export function loadSqlite(): SqliteModule | null {
  if (cached !== undefined) return cached;
  silenceSqliteWarning();
  try {
    const require = createRequire(import.meta.url);
    cached = require('node:sqlite') as SqliteModule;
  } catch {
    cached = null;
  }
  return cached;
}

export function sqliteAvailable(): boolean {
  return loadSqlite() !== null;
}

/**
 * Snapshot a database using SQLite's online backup API.
 *
 * This is the only safe way to copy a database that another process may be
 * writing: a plain file copy can capture a torn page or miss the WAL.
 * Returns false when the API is unavailable, so callers fall back to copying.
 */
export async function backupDatabase(source: string, destination: string): Promise<boolean> {
  const sqlite = loadSqlite();
  if (!sqlite?.backup) return false;

  let db: DatabaseLike;
  try {
    db = new sqlite.DatabaseSync(source, { readOnly: true });
  } catch {
    return false;
  }

  try {
    await sqlite.backup(db, destination);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {
      /* the snapshot already succeeded or failed; closing cannot change that */
    }
  }
}

export interface OpenOptions {
  readOnly?: boolean;
}

/** Open a database, or return null when SQLite is unavailable or the file is unusable. */
export function openDatabase(path: string, options: OpenOptions = {}): SqlDatabase | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db: DatabaseLike;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: options.readOnly ?? true });
  } catch {
    return null;
  }

  return {
    all(sql: string, ...params: unknown[]): SqlRow[] {
      return db.prepare(sql).all(...params);
    },
    run(sql: string, ...params: unknown[]): void {
      db.prepare(sql).run(...params);
    },
    close(): void {
      try {
        db.close();
      } catch {
        /* closing a database that failed to open is not an error worth raising */
      }
    },
  };
}
