/**
 * Backups taken before anything destructive.
 *
 * Credentials are deliberately not backed up: a second copy of a live token is
 * a liability, and profiles are never modified by the operations that call
 * this. What is captured is the small, rebuildable-but-annoying-to-lose state:
 * the registry, the runtime pointer, and the Codex config and thread index.
 */

import { copyFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ensureDir, fileExists, writeJsonFile } from './atomic.js';
import { backupsDir, cmaHome, configPath, runtimeHome, statePath } from './paths.js';
import { findVersionedDb } from '../codex/codex-home.js';

export interface BackupResult {
  path: string;
  files: string[];
  skipped: string[];
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

/**
 * Snapshot the tool's own state plus the runtime's index files.
 * `label` is slugged by the caller; it only ever comes from our own code.
 */
export function createBackup(label: string, now = new Date()): BackupResult {
  const dir = join(backupsDir(), `${stamp(now)}-${label}`);
  ensureDir(dir, { secret: true });

  const files: string[] = [];
  const skipped: string[] = [];

  const take = (source: string, name = basename(source)): void => {
    if (!fileExists(source)) {
      skipped.push(source);
      return;
    }
    try {
      copyFileSync(source, join(dir, name));
      files.push(name);
    } catch {
      skipped.push(source);
    }
  };

  take(configPath());
  take(statePath());

  const runtime = runtimeHome();
  take(join(runtime, 'config.toml'));
  take(join(runtime, 'AGENTS.md'));

  const stateDb = findVersionedDb(runtime, 'state');
  if (stateDb) take(stateDb);

  writeJsonFile(join(dir, 'manifest.json'), {
    createdAt: now.toISOString(),
    label,
    cmaHome: cmaHome(),
    runtimeHome: runtime,
    files,
    skipped,
    note: 'Credential files are intentionally excluded from backups.',
  });

  return { path: dir, files, skipped };
}

export function listBackups(): string[] {
  try {
    return readdirSync(backupsDir()).sort().reverse();
  } catch {
    return [];
  }
}
