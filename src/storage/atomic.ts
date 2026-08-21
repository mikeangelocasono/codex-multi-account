/**
 * Atomic file primitives.
 *
 * Credentials are replaced with write-temp-then-rename so a crash can never
 * leave a half-written `auth.json` behind. `fs.renameSync` is atomic within a
 * directory on POSIX and on Windows (libuv uses MoveFileEx with
 * REPLACE_EXISTING), so temporary files are always created beside the target.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { CmaError, errnoCode } from '../utils/errors.js';
import { applyDirPermissions, applyFilePermissions } from '../security/permissions.js';

export interface AtomicWriteOptions {
  /** POSIX mode for the final file. 0o600 for anything credential-shaped. */
  mode?: number;
  /** Also tighten the ACL on Windows. Only worth it for secrets. */
  secret?: boolean;
}

export function ensureDir(path: string, options: { secret?: boolean } = {}): void {
  mkdirSync(path, { recursive: true, mode: options.secret ? 0o700 : 0o755 });
  if (options.secret) applyDirPermissions(path);
}

function tempPathFor(target: string): string {
  return join(dirname(target), `.${randomBytes(8).toString('hex')}.tmp`);
}

/** Write `data` to `target` atomically, fsyncing before the rename. */
export function writeFileAtomic(
  target: string,
  data: Buffer | string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  // Only the file is hardened. Tightening the parent here would be a trap:
  // `runtime/` holds the credential *and* ordinary shared state, and locking
  // that directory down leaves every file created in it afterwards with no
  // usable permissions at all.
  ensureDir(dirname(target));

  const temp = tempPathFor(target);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', mode);
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(temp, target);
    if (options.secret) applyFilePermissions(target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed; closing is best effort */
      }
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      /* leftover temp files are harmless and cleaned on the next write */
    }
    throw new CmaError('IO', `Could not write ${describePath(target)}.`, {
      hint: hintForErrno(errnoCode(error)),
      cause: error,
    });
  }
}

/** Copy `source` onto `target` atomically. Used for credential moves. */
export function copyFileAtomic(
  source: string,
  target: string,
  options: AtomicWriteOptions = {},
): void {
  let data: Buffer;
  try {
    data = readFileSync(source);
  } catch (error) {
    throw new CmaError('IO', `Could not read ${describePath(source)}.`, {
      hint: hintForErrno(errnoCode(error)),
      cause: error,
    });
  }
  writeFileAtomic(target, data, options);
}

export function readJsonFile<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw new CmaError('IO', `Could not read ${describePath(path)}.`, {
      hint: hintForErrno(errnoCode(error)),
      cause: error,
    });
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new CmaError('STATE_CORRUPT', `${describePath(path)} is not valid JSON.`, {
      hint: 'Fix or delete the file and run the command again. Deleting it loses the profile registry, not your credentials.',
      cause: error,
    });
  }
}

export function writeJsonFile(path: string, value: unknown, options: AtomicWriteOptions = {}): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: options.mode ?? 0o600,
    secret: options.secret,
  });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Absolute paths in error text are fine; the file *contents* are the secret. */
function describePath(path: string): string {
  return path;
}

function hintForErrno(code: string | undefined): string | undefined {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied. On Windows, close any process holding the file (including a running Codex) and check that the folder is not read-only.';
    case 'ENOSPC':
      return 'The disk is full.';
    case 'EBUSY':
      return 'The file is locked by another process. Exit any running Codex session and try again.';
    case 'EROFS':
      return 'The filesystem is read-only.';
    default:
      return undefined;
  }
}
