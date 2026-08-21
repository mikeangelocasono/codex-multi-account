/**
 * Cross-process locking and live-writer tracking.
 *
 * Two different mechanisms, for two different problems:
 *
 * 1. `withRuntimeLock` is a short exclusive lock held while the runtime
 *    credential is being swapped. It exists so two `cma use` invocations can
 *    never interleave a copy.
 *
 * 2. The *writer registry* records every Codex process this tool launched.
 *    Codex holds its credential open for the whole session and rewrites it on
 *    token refresh, so switching accounts while one is alive would hand the
 *    running process another account's tokens. Registry entries outlive the
 *    runtime lock deliberately.
 *
 * Both survive a crash: entries carry a pid, and a pid that is no longer alive
 * is reclaimed rather than blocking the user forever.
 */

import { openSync, closeSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CmaError, errnoCode } from '../utils/errors.js';
import { ensureDir } from './atomic.js';
import { runtimeLockPath, writersDir } from './paths.js';

/** A lock older than this with a live pid is assumed hung, not working. */
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

export interface LockRecord {
  pid: number;
  host: string;
  operation: string;
  createdAt: string;
}

export interface WriterRecord {
  id: string;
  pid: number;
  host: string;
  profile: string;
  command: string;
  cwd: string;
  startedAt: string;
}

/**
 * Is a pid still running?
 *
 * `kill(pid, 0)` is the portable probe. On Windows Node maps it onto
 * OpenProcess, so EPERM means "alive but not ours" and ESRCH means "gone".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : 'unknown',
      operation: typeof parsed.operation === 'string' ? parsed.operation : 'unknown',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
    };
  } catch {
    // Unreadable or truncated lock files are treated as stale: a lock we cannot
    // interpret cannot tell us who owns it.
    return null;
  }
}

function lockAgeMs(record: LockRecord): number {
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) ? Date.now() - created : Number.POSITIVE_INFINITY;
}

/**
 * A lock is reclaimable when its owner is gone, when it came from another
 * machine sharing this directory, or when it has clearly outlived its purpose.
 */
function isStale(record: LockRecord | null, staleMs: number): boolean {
  if (!record) return true;
  if (record.host !== hostname()) return lockAgeMs(record) > staleMs;
  if (!isProcessAlive(record.pid)) return true;
  return lockAgeMs(record) > staleMs;
}

function tryAcquire(path: string, operation: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    const record: LockRecord = {
      pid: process.pid,
      host: hostname(),
      operation,
      createdAt: new Date().toISOString(),
    };
    writeSync(fd, `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw new CmaError('IO', `Could not create the lock file at ${path}.`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sleepSync(ms: number): void {
  // A blocking sleep keeps the lock helpers synchronous, which in turn keeps
  // every caller free of half-applied async state on failure.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  operation?: string;
}

/** Run `fn` while holding the runtime lock. Always released, even on throw. */
export function withRuntimeLock<T>(fn: () => T, options: LockOptions = {}): T {
  const path = runtimeLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const operation = options.operation ?? 'runtime';

  ensureDir(join(path, '..'));

  const deadline = Date.now() + timeoutMs;
  let reclaimed = false;

  for (;;) {
    if (tryAcquire(path, operation)) break;

    const current = readLock(path);
    if (!reclaimed && isStale(current, staleMs)) {
      // Reclaim once. If a second process wins the race we fall back to waiting
      // rather than deleting its fresh lock.
      reclaimed = true;
      try {
        rmSync(path, { force: true });
      } catch {
        /* another process may have removed it already */
      }
      continue;
    }

    if (Date.now() >= deadline) {
      const owner = current ? `process ${current.pid} on ${current.host}` : 'an unknown process';
      throw new CmaError(
        'LOCK_TIMEOUT',
        `Another codex-multi-account operation is in progress (${owner}).`,
        {
          hint: `Wait for it to finish, or delete ${path} if you are sure nothing is running.`,
        },
      );
    }
    sleepSync(POLL_INTERVAL_MS);
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      /* the next run reclaims it as stale */
    }
  }
}

// ---------------------------------------------------------------------------
// Writer registry
// ---------------------------------------------------------------------------

function writerPath(id: string): string {
  return join(writersDir(), `${id}.json`);
}

/** Announce that a Codex process is about to run under `profile`. */
export function registerWriter(profile: string, command: string): WriterRecord {
  const record: WriterRecord = {
    id: `${process.pid}-${randomBytes(4).toString('hex')}`,
    pid: process.pid,
    host: hostname(),
    profile,
    command,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };

  ensureDir(writersDir());
  const path = writerPath(record.id);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } catch (error) {
    throw new CmaError('IO', 'Could not register this Codex session.', { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return record;
}

export function unregisterWriter(record: Pick<WriterRecord, 'id'>): void {
  try {
    rmSync(writerPath(record.id), { force: true });
  } catch {
    /* pruned as dead on the next listing */
  }
}

/**
 * Live writers, with dead entries pruned as a side effect.
 *
 * Pruning here is what makes crash recovery automatic: a Codex killed with the
 * terminal window leaves a file behind, and the next command removes it.
 */
export function listActiveWriters(): WriterRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(writersDir());
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw new CmaError('IO', 'Could not read the active-session registry.', { cause: error });
  }

  const alive: WriterRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(writersDir(), entry);
    let record: WriterRecord | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WriterRecord>;
      if (typeof parsed.pid === 'number' && typeof parsed.profile === 'string') {
        record = {
          id: typeof parsed.id === 'string' ? parsed.id : entry.replace(/\.json$/, ''),
          pid: parsed.pid,
          host: typeof parsed.host === 'string' ? parsed.host : 'unknown',
          profile: parsed.profile,
          command: typeof parsed.command === 'string' ? parsed.command : 'codex',
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
          startedAt:
            typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
        };
      }
    } catch {
      record = null;
    }

    const sameHost = record?.host === hostname();
    if (record && sameHost && isProcessAlive(record.pid)) {
      alive.push(record);
      continue;
    }
    if (record && !sameHost) {
      // Another machine sharing this directory: we cannot probe its pids, so
      // keep the entry and let the caller decide.
      alive.push(record);
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
  return alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Refuse to swap credentials while Codex is running.
 *
 * `allowProfile` lets `cma codex` re-materialise the credential for the
 * profile that is already running, which is a no-op in practice.
 */
export function assertNoActiveWriters(action: string, allowProfile?: string): void {
  const writers = listActiveWriters().filter((w) => w.profile !== allowProfile);
  if (writers.length === 0) return;

  const first = writers[0]!;
  const others = writers.length > 1 ? ` (and ${writers.length - 1} more)` : '';
  throw new CmaError(
    'ACTIVE_WRITER',
    `A Codex process is currently using account "${first.profile}"${others}.`,
    {
      hint: [
        `Exit that Codex session before you ${action}.`,
        `  pid ${first.pid}  started ${first.startedAt}  cwd ${first.cwd || 'unknown'}`,
        'If that process is already gone, run `cma check` to clear the stale entry.',
      ].join('\n'),
    },
  );
}
