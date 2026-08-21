/**
 * Knowledge about the layout of a Codex home directory.
 *
 * Codex versions its state databases by filename (`state_5.sqlite`,
 * `thread_history_1.sqlite`). Nothing here hard-codes a version number: the
 * highest-numbered file wins, so a Codex upgrade that bumps the schema is
 * picked up without a change to this tool.
 *
 * The split between shared and profile-specific state is the whole design, so
 * it is declared here as data rather than scattered through the import code.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { errnoCode } from '../utils/errors.js';
import { fileExists } from '../storage/atomic.js';

/**
 * State that is deliberately shared between every account.
 *
 * Sharing these is what makes a session created under one account resumable
 * under another: the transcript, the thread index and the projected history
 * all live here.
 */
export const SHARED_STATE: ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'glob'; why: string }> = [
  { name: 'sessions', kind: 'dir', why: 'Rollout transcripts. The conversation itself.' },
  {
    name: 'state_*.sqlite',
    kind: 'glob',
    why: 'Thread index: id, title, cwd, timestamps and the rollout path resume looks up.',
  },
  {
    name: 'thread_history_*.sqlite',
    kind: 'glob',
    why: 'Paginated turn/item history. Modern Codex reads context from here, not the rollout file.',
  },
  { name: 'history.jsonl', kind: 'file', why: 'Cross-session prompt history for the TUI.' },
  { name: 'config.toml', kind: 'file', why: 'Model, approvals, MCP servers, plugins, project trust.' },
  { name: 'AGENTS.md', kind: 'file', why: 'Global agent instructions.' },
  { name: 'skills', kind: 'dir', why: 'Installed skills.' },
  { name: 'prompts', kind: 'dir', why: 'Saved prompts.' },
  { name: 'plugins', kind: 'dir', why: 'Installed plugins and marketplace state.' },
  { name: 'memories_*.sqlite', kind: 'glob', why: 'Agent memories.' },
  { name: 'goals_*.sqlite', kind: 'glob', why: 'Goal tracking.' },
  { name: 'queue_*.sqlite', kind: 'glob', why: 'Queued work.' },
  { name: 'models_cache.json', kind: 'file', why: 'Model catalogue cache.' },
  { name: 'version.json', kind: 'file', why: 'Update-check cache.' },
  { name: 'installation_id', kind: 'file', why: 'Stable installation identifier.' },
  { name: 'secrets', kind: 'dir', why: 'MCP/connector secrets, keyed by service rather than by account.' },
  { name: 'mcp-oauth-locks', kind: 'dir', why: 'MCP OAuth coordination.' },
];

/**
 * State that must never be shared.
 *
 * Exactly one entry. Everything else in a Codex home is either shared state or
 * a regenerable cache.
 */
export const PROFILE_STATE: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: 'auth.json',
    why: 'ChatGPT OAuth tokens or an API key. The one file that identifies the account.',
  },
];

/** Regenerable or machine-local; not copied on import. */
export const TRANSIENT_STATE: readonly string[] = [
  '.tmp',
  'tmp',
  'cache',
  'log',
  'logs_*.sqlite',
  'logs_*.sqlite-wal',
  'logs_*.sqlite-shm',
  'app-server-daemon',
  'app-server-control',
  'thread-writer-locks',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'node_repl',
  'ambient-suggestions',
  'dictation-history',
  'computer-use',
  'vendor_imports',
];

/**
 * Highest-numbered match for a `<base>_<n>.sqlite` family.
 * Returns an absolute path, or null when the family is absent.
 */
export function findVersionedDb(home: string, base: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }

  const pattern = new RegExp(`^${base}_(\\d+)\\.sqlite$`);
  let best: { path: string; version: number } | null = null;
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (!match) continue;
    const version = Number.parseInt(match[1]!, 10);
    if (!best || version > best.version) best = { path: join(home, entry), version };
  }
  return best?.path ?? null;
}

export function stateDbPath(home: string): string | null {
  return findVersionedDb(home, 'state');
}

export function threadHistoryDbPath(home: string): string | null {
  return findVersionedDb(home, 'thread_history');
}

export function sessionsDir(home: string): string {
  return join(home, 'sessions');
}

export function authPath(home: string): string {
  return join(home, 'auth.json');
}

/** Does this directory look like a Codex home that has been used at all? */
export function looksLikeCodexHome(home: string): boolean {
  return (
    fileExists(join(home, 'auth.json')) ||
    fileExists(join(home, 'config.toml')) ||
    fileExists(sessionsDir(home)) ||
    stateDbPath(home) !== null
  );
}

/** Expand a shared-state entry into concrete names present in `home`. */
export function resolveSharedEntries(home: string): Array<{ name: string; kind: 'file' | 'dir' }> {
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }

  const out: Array<{ name: string; kind: 'file' | 'dir' }> = [];
  for (const spec of SHARED_STATE) {
    if (spec.kind === 'glob') {
      const pattern = new RegExp(`^${spec.name.replace('*', '\\d+')}$`);
      for (const entry of entries) {
        if (!pattern.test(entry)) continue;
        out.push({ name: entry, kind: 'file' });
        // SQLite WAL sidecars must travel with their database.
        for (const suffix of ['-wal', '-shm']) {
          if (entries.includes(entry + suffix)) out.push({ name: entry + suffix, kind: 'file' });
        }
      }
      continue;
    }
    if (entries.includes(spec.name)) out.push({ name: spec.name, kind: spec.kind });
  }
  return out;
}
